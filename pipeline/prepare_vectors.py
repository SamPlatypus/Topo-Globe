#!/usr/bin/env python3
"""Prepare vector layers for one region file.

Inputs
  * OpenStreetMap .osm.pbf (roads, tracks, paths + a few walker POIs)
  * Vicmap Hydro GeoJSON from fetch_vicmap.py (watercourses, water areas, points)

Output: a compact JSON consumed by encode_region.ts

Only real, mapped features are used.  Nothing is derived from elevation.

Roads/tracks keep their topology: ways are cut at junction nodes into edges
that share node indices, so the phone can route on them.  Edges that cross the
region boundary are kept whole (one node outside), so the same boundary node
appears in both neighbouring region files and routes join up across edges.
"""
import argparse, json, math, sys
from collections import defaultdict

import osmium
from shapely.geometry import shape, box, LineString, Polygon, MultiPolygon, GeometryCollection, MultiLineString
from shapely.ops import linemerge

COORD_SCALE = 50000   # 2e-5 degree grid (~2 m; rounding <= 1.1 m)
OSM_TOL_M = 2.0        # Douglas-Peucker tolerance for roads/tracks (OSM traces are +-5 m)
HYDRO_TOL_M = 4.0      # ... for Vicmap watercourses (1:25,000 product, ~12 m accuracy)
AREA_TOL_M = 3.0       # ... for Vicmap water areas
MIN_WATER_AREA_M2 = 150.0

# ---------------------------------------------------------------- OSM classes
# class ids shared with src/shared/vector.ts
C_MOTORWAY, C_TRUNK, C_PRIMARY, C_SECONDARY, C_TERTIARY, C_MINOR, C_SERVICE, C_TRACK, C_PATH, C_FOOTWAY, C_CYCLEWAY, C_BRIDLEWAY, C_STEPS = range(13)
HW_CLASS = {
    'motorway': C_MOTORWAY, 'motorway_link': C_MOTORWAY,
    'trunk': C_TRUNK, 'trunk_link': C_TRUNK,
    'primary': C_PRIMARY, 'primary_link': C_PRIMARY,
    'secondary': C_SECONDARY, 'secondary_link': C_SECONDARY,
    'tertiary': C_TERTIARY, 'tertiary_link': C_TERTIARY,
    'unclassified': C_MINOR, 'residential': C_MINOR, 'living_street': C_MINOR, 'road': C_MINOR,
    'service': C_SERVICE, 'track': C_TRACK,
    'path': C_PATH, 'footway': C_FOOTWAY, 'pedestrian': C_FOOTWAY,
    'cycleway': C_CYCLEWAY, 'bridleway': C_BRIDLEWAY, 'steps': C_STEPS,
}
DROP_FOOTWAY = {'sidewalk', 'crossing', 'traffic_island', 'access_aisle'}
DROP_SERVICE = {'driveway', 'parking_aisle', 'drive-through', 'drive_through'}
SAC = {'hiking': 1, 'mountain_hiking': 2, 'demanding_mountain_hiking': 3, 'alpine_hiking': 4,
       'demanding_alpine_hiking': 5, 'difficult_alpine_hiking': 6}
UNPAVED = {'unpaved', 'gravel', 'dirt', 'ground', 'compacted', 'fine_gravel', 'grass', 'earth', 'mud', 'sand',
           'rock', 'pebblestone', 'woodchips', 'grass_paver'}

# flags
F_BRIDGE, F_TUNNEL, F_NOFOOT, F_UNPAVED, F_PRIVATE, F_FORD = 1, 2, 4, 8, 16, 32

POI_TYPES = {  # (key, value) -> poi class id (src/shared/vector.ts)
    ('natural', 'peak'): 1, ('natural', 'saddle'): 2, ('natural', 'cave_entrance'): 3,
    ('tourism', 'alpine_hut'): 4, ('tourism', 'wilderness_hut'): 4, ('amenity', 'shelter'): 5,
    ('tourism', 'camp_site'): 6, ('amenity', 'drinking_water'): 7, ('tourism', 'viewpoint'): 8,
    ('amenity', 'toilets'): 9,
}
VIC_POI = {'waterfall': 10, 'rapid': 11, 'spring': 12}


def classify_way(t):
    hw = t.get('highway')
    if hw not in HW_CLASS:
        return None
    if hw == 'footway' and t.get('footway') in DROP_FOOTWAY:
        return None
    if hw == 'service' and t.get('service') in DROP_SERVICE:
        return None
    if t.get('area') == 'yes' or t.get('indoor') == 'yes':
        return None
    access = t.get('access')
    foot = t.get('foot')
    if hw == 'service' and access in ('private', 'no') and foot not in ('yes', 'designated', 'permissive'):
        return None  # private driveways / yards
    cls = HW_CLASS[hw]
    flags = 0
    if t.get('bridge') not in (None, 'no'):
        flags |= F_BRIDGE
    if t.get('tunnel') not in (None, 'no'):
        flags |= F_TUNNEL
    if t.get('ford') not in (None, 'no'):
        flags |= F_FORD
    if t.get('surface') in UNPAVED or (cls == C_TRACK and t.get('surface') is None):
        flags |= F_UNPAVED
    walk_ok_tags = foot in ('yes', 'designated', 'permissive')
    if cls == C_MOTORWAY or foot in ('no', 'private', 'use_sidepath') or (access in ('no',) and not walk_ok_tags):
        flags |= F_NOFOOT
    if access in ('private', 'customers', 'permit') and not walk_ok_tags:
        flags |= F_PRIVATE
    name = t.get('name') or t.get('ref') or ''
    sac = SAC.get(t.get('sac_scale'), 0)
    return cls, flags, name, sac


class Collector(osmium.SimpleHandler):
    pass


def m_per_deg(lat):
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = f * (2 - f)
    p = math.radians(lat)
    w = math.sqrt(1 - e2 * math.sin(p) ** 2)
    N = a / w
    M = a * (1 - e2) / w ** 3
    return math.radians(1) * N * math.cos(p), math.radians(1) * M


def dp_simplify(pts, tol_m, lat0):
    """Douglas-Peucker on lon/lat points using a local metric scale. Keeps endpoints."""
    if len(pts) <= 2:
        return pts
    kx, ky = m_per_deg(lat0)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol_m * tol_m
    while stack:
        i, j = stack.pop()
        ax, ay = pts[i][0] * kx, pts[i][1] * ky
        bx, by = pts[j][0] * kx, pts[j][1] * ky
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for k in range(i + 1, j):
            px, py = pts[k][0] * kx - ax, pts[k][1] * ky - ay
            if L2 == 0:
                d2 = px * px + py * py
            else:
                tt = max(0.0, min(1.0, (px * dx + py * dy) / L2))
                ex, ey = px - tt * dx, py - tt * dy
                d2 = ex * ex + ey * ey
            if d2 > best:
                best, bi = d2, k
        if best > tol2:
            keep[bi] = True
            stack.append((i, bi))
            stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]


def q(v):
    return int(round(v * COORD_SCALE))


def load_osm(path, W, S, E, N):
    ways = []        # (attrs, [(node_id, lon, lat), ...])
    pois = []
    fp = osmium.FileProcessor(path).with_locations().with_filter(osmium.filter.KeyFilter('highway', 'natural', 'tourism', 'amenity'))
    for o in fp:
        if o.is_node():
            t = o.tags
            if t.get('shelter_type') == 'public_transport' or t.get('highway') == 'bus_stop':
                continue
            for (k, v), cid in POI_TYPES.items():
                if t.get(k) == v:
                    lon, lat = o.location.lon, o.location.lat
                    if W <= lon <= E and S <= lat <= N:
                        ele = t.get('ele')
                        try:
                            ele = float(str(ele).replace('m', '').strip()) if ele else None
                        except ValueError:
                            ele = None
                        pois.append({'t': cid, 'lon': lon, 'lat': lat, 'name': t.get('name') or '', 'ele': ele})
                    break
            continue
        if not o.is_way():
            continue
        t = o.tags
        if 'highway' not in t:
            if t.get('shelter_type') == 'public_transport':
                continue
            # huts / campsites / shelters mapped as areas -> centroid POI
            for (k, v), cid in POI_TYPES.items():
                if t.get(k) == v and len(o.nodes) >= 3:
                    try:
                        xs = [n.location.lon for n in o.nodes]
                        ys = [n.location.lat for n in o.nodes]
                    except osmium.InvalidLocationError:
                        break
                    lon, lat = sum(xs) / len(xs), sum(ys) / len(ys)
                    if W <= lon <= E and S <= lat <= N:
                        pois.append({'t': cid, 'lon': lon, 'lat': lat, 'name': t.get('name') or '', 'ele': None})
                    break
            continue
        c = classify_way(t)
        if c is None:
            continue
        try:
            nodes = [(n.ref, n.location.lon, n.location.lat) for n in o.nodes]
        except osmium.InvalidLocationError:
            continue
        inside = [W <= x <= E and S <= y <= N for _, x, y in nodes]
        if not any(inside):
            # a way can still cross the region without a node inside: test segments
            crosses = False
            rect = box(W, S, E, N)
            for k in range(len(nodes) - 1):
                if LineString([nodes[k][1:], nodes[k + 1][1:]]).intersects(rect):
                    crosses = True
                    break
            if not crosses:
                continue
            inside = [True] * len(nodes)  # keep whole way piece (rare: long segment through a corner)
        # keep runs of inside nodes plus one outside neighbour on each side
        keep = [False] * len(nodes)
        for k, ins in enumerate(inside):
            if ins:
                keep[k] = True
                if k > 0:
                    keep[k - 1] = True
                if k + 1 < len(nodes):
                    keep[k + 1] = True
        run = []
        for k, kp in enumerate(keep):
            if kp:
                run.append(nodes[k])
            elif run:
                if len(run) >= 2:
                    ways.append((c, run))
                run = []
        if len(run) >= 2:
            ways.append((c, run))
    return ways, pois


def build_graph(ways, lat0):
    """Cut ways into junction-to-junction edges, simplify each edge, then merge
    edges with identical attributes through simple (degree-2) nodes into chains.

    Returns chains as lists of quantised points.  Topology is carried by exact
    coordinate equality: every junction is emitted with identical coordinates in
    every chain that uses it, and distinct OSM nodes are guaranteed never to share
    a quantised coordinate (collisions are nudged by one unit).
    """
    use = defaultdict(int)
    for _, run in ways:
        ids = [n[0] for n in run]
        for k, nid in enumerate(ids):
            use[nid] += 1 if 0 < k < len(ids) - 1 else 2
    # quantise with collision avoidance
    qpos = {}
    taken = {}

    def qnode(n):
        nid = n[0]
        if nid in qpos:
            return qpos[nid]
        x, y = q(n[1]), q(n[2])
        k = 0
        while (x, y) in taken and taken[(x, y)] != nid:
            k += 1
            x += 1 if k % 2 else 0
            y += 0 if k % 2 else 1
        taken[(x, y)] = nid
        qpos[nid] = (x, y)
        return (x, y)

    edges = []  # (attr, nodeA, nodeB, [interior quantised pts])
    for attr, run in ways:
        start = 0
        for k in range(1, len(run)):
            if use[run[k][0]] >= 2 or k == len(run) - 1:
                seg = run[start:k + 1]
                pts = dp_simplify([(p[1], p[2]) for p in seg], OSM_TOL_M, lat0)
                interior = []
                for x, y in pts[1:-1]:
                    pt = (q(x), q(y))
                    # interior points never coincide with any junction position
                    if pt in taken:
                        pt = (pt[0] + 1, pt[1])
                    interior.append(pt)
                a = seg[0][0]
                b = seg[-1][0]
                qnode(seg[0]); qnode(seg[-1])
                if a == b and not interior:
                    start = k
                    continue
                edges.append([attr, a, b, interior])
                start = k
    # merge through degree-2 nodes with equal attributes
    inc = defaultdict(list)
    for i, e in enumerate(edges):
        inc[e[1]].append(i)
        inc[e[2]].append(i)
    used = [False] * len(edges)
    chains = []

    def other(e, n):
        return e[2] if e[1] == n else e[1]

    def pts_from(e, n):
        """points of edge e starting at node n (excluding n)."""
        if e[1] == n:
            return e[3] + [qpos[e[2]]]
        return list(reversed(e[3])) + [qpos[e[1]]]

    for i, e in enumerate(edges):
        if used[i]:
            continue
        used[i] = True
        attr = e[0]
        # walk backwards from e[1] to find chain start
        seq = [qpos[e[1]]] + e[3] + [qpos[e[2]]]
        # extend forward
        cur_node, cur = e[2], i
        while True:
            nb = inc[cur_node]
            if len(nb) != 2 or e[1] == e[2]:
                break
            j = nb[0] if nb[1] == cur else nb[1]
            if used[j] or edges[j][0] != attr or j == cur:
                break
            used[j] = True
            seq += pts_from(edges[j], cur_node)
            cur_node, cur = other(edges[j], cur_node), j
        # extend backward
        cur_node, cur = e[1], i
        while True:
            nb = inc[cur_node]
            if len(nb) != 2 or e[1] == e[2]:
                break
            j = nb[0] if nb[1] == cur else nb[1]
            if used[j] or edges[j][0] != attr or j == cur:
                break
            used[j] = True
            back = pts_from(edges[j], cur_node)  # from cur_node outward
            seq = list(reversed(back)) + seq
            cur_node, cur = other(edges[j], cur_node), j
        cls, flags, name, sac = attr
        chains.append({'c': cls, 'f': flags, 'n': name, 's': sac, 'p': seq})
    return len(qpos), chains


def title_case(s):
    if not s:
        return ''
    out = []
    for w in s.split(' '):
        if not w:
            continue
        lw = w.lower()
        if lw.startswith('mc') and len(w) > 3:
            out.append('Mc' + lw[2].upper() + lw[3:])
        else:
            parts = lw.split("'")
            parts = [p[:1].upper() + p[1:] for p in parts]
            ww = "'".join(parts)
            ww = '-'.join(p[:1].upper() + p[1:] for p in ww.split('-'))
            out.append(ww)
    return ' '.join(out)


# Vicmap watercourse classes (src/shared/vector.ts)
W_RIVER, W_STREAM, W_CHANNEL, W_CONNECTOR = 0, 1, 2, 3
HIER = {'H': 2, 'M': 1, 'L': 0, None: 0}


def load_vicmap(prefix, W, S, E, N, lat0):
    rect = box(W, S, E, N)
    lines_by_key = defaultdict(list)
    with open(prefix + 'hy_watercourse.geojson') as fh:
        wc = json.load(fh)['features']
    for f in wc:
        p = f['properties']
        ft = p.get('feature_type_code') or ''
        if ft == 'watercourse_river':
            cls = W_RIVER
        elif ft == 'watercourse_stream' or ft == 'connector_structure':
            cls = W_STREAM
        elif ft in ('watercourse_channel', 'watercourse_drain', 'watercourse_channel_drain'):
            cls = W_CHANNEL
        elif ft == 'connector_river':
            cls = W_CONNECTOR  # river centre-line through mapped river areas: low zooms only
        else:
            continue  # other connectors run through lakes/swamps (network links, not channels)
        g = shape(f['geometry'])
        key = (cls, title_case(p.get('name') or ''), HIER.get(p.get('hierarchy'), 0))
        lines_by_key[key].append(g)
    lines = []
    for (cls, name, hier), geoms in lines_by_key.items():
        merged = linemerge(geoms)
        parts = [merged] if merged.geom_type == 'LineString' else list(merged.geoms)
        for part in parts:
            clipped = part.intersection(rect)
            if clipped.is_empty:
                continue
            pieces = [clipped] if clipped.geom_type == 'LineString' else [gg for gg in getattr(clipped, 'geoms', []) if gg.geom_type == 'LineString']
            for pc in pieces:
                pts = dp_simplify(list(pc.coords), HYDRO_TOL_M, lat0)
                if len(pts) < 2:
                    continue
                lines.append({'c': cls, 'n': name, 'h': hier, 'p': [(q(x), q(y)) for x, y in pts]})
    # water areas
    areas = []
    kx, ky = m_per_deg(lat0)
    AREA_CLS = {'wb_lake': 0, 'reservoir': 0, 'pondage': 1, 'pondage_sewerage': 1, 'pondage_saltpan': 1,
                'watercourse_area_river': 2, 'watercourse_area_channel_drain': 2, 'watercourse_area_drain': 2,
                'watercourse_area_channel': 2, 'wetland_swamp': 3}
    with open(prefix + 'hy_water_area_polygon.geojson') as fh:
        wa = json.load(fh)['features']
    for f in wa:
        p = f['properties']
        cls = AREA_CLS.get(p.get('feature_type_code'))
        if cls is None:
            continue
        g = shape(f['geometry'])
        if not g.is_valid:
            g = g.buffer(0)
        g = g.intersection(rect)
        if g.is_empty:
            continue
        polys = [g] if g.geom_type == 'Polygon' else [gg for gg in getattr(g, 'geoms', []) if gg.geom_type == 'Polygon']
        for pg in polys:
            if pg.area * kx * ky < MIN_WATER_AREA_M2:
                continue
            tol_deg = AREA_TOL_M / ky
            pg2 = pg.simplify(tol_deg, preserve_topology=True)
            if pg2.is_empty or pg2.geom_type != 'Polygon':
                continue
            rings = [list(pg2.exterior.coords)] + [list(r.coords) for r in pg2.interiors]
            rings = [[(q(x), q(y)) for x, y in r[:-1]] for r in rings if len(r) >= 4]
            if not rings or len(rings[0]) < 3:
                continue
            areas.append({'c': cls, 'n': title_case(p.get('name') or ''), 'r': rings})
    pois = []
    with open(prefix + 'hy_water_point.geojson') as fh:
        wp = json.load(fh)['features']
    for f in wp:
        p = f['properties']
        cid = VIC_POI.get(p.get('feature_type_code'))
        if cid is None:
            continue
        x, y = f['geometry']['coordinates'][:2]
        if W <= x <= E and S <= y <= N:
            pois.append({'t': cid, 'lon': x, 'lat': y, 'name': title_case(p.get('name') or ''), 'ele': None})
    return lines, areas, pois


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--osm', required=True)
    ap.add_argument('--vicmap-prefix', required=True)
    ap.add_argument('--bbox', required=True, help='west,south,east,north')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    W, S, E, N = map(float, a.bbox.split(','))
    lat0 = (S + N) / 2
    ways, osm_pois = load_osm(a.osm, W, S, E, N)
    njunc, chains = build_graph(ways, lat0)
    print(f'OSM: {len(ways)} way pieces -> {njunc} junction nodes, {len(chains)} chains, '
          f'{sum(len(e["p"]) for e in chains)} points, {len(osm_pois)} POIs', file=sys.stderr)
    lines, areas, vic_pois = load_vicmap(a.vicmap_prefix, W, S, E, N, lat0)
    print(f'Vicmap: {len(lines)} lines ({sum(len(l["p"]) for l in lines)} pts), {len(areas)} areas '
          f'({sum(sum(len(r) for r in ar["r"]) for ar in areas)} pts), {len(vic_pois)} points', file=sys.stderr)
    out = {
        'bbox': [W, S, E, N], 'coordScale': COORD_SCALE,
        'roads': chains,
        'waterLines': lines, 'waterAreas': areas,
        'pois': osm_pois + vic_pois,
    }
    with open(a.out, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'))


if __name__ == '__main__':
    main()
