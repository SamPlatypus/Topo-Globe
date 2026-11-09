#!/usr/bin/env python3
"""Build the small bundled globe map (src/assets/world.json) from Natural Earth.

Natural Earth is public domain.  Usage (needs shapely + pyshp/fiona-free reading via shapely+zip):
  python scripts/build_world.py <dir with ne_*.zip> src/assets/world.json

World: 110m land and country borders.  South-east Australia (Victoria and
neighbours): 10m land, state borders and big lakes, so the coastline still
looks right when the globe flies down to a region.
"""
import io, json, sys, zipfile, struct
from shapely.geometry import shape, box, mapping
from shapely.ops import unary_union


def read_shp(zpath):
    """Tiny shapefile reader (polygons/polylines) - avoids a GDAL dependency."""
    z = zipfile.ZipFile(zpath)
    shp = next(n for n in z.namelist() if n.endswith('.shp'))
    data = z.read(shp)
    pos = 100
    out = []
    while pos < len(data):
        _, clen = struct.unpack('>ii', data[pos:pos + 8])
        rec = data[pos + 8: pos + 8 + clen * 2]
        pos += 8 + clen * 2
        st = struct.unpack('<i', rec[:4])[0]
        if st == 0:
            continue
        nparts, npts = struct.unpack('<ii', rec[36:44])
        parts = list(struct.unpack('<%di' % nparts, rec[44:44 + 4 * nparts]))
        p0 = 44 + 4 * nparts
        pts = [struct.unpack('<dd', rec[p0 + 16 * i: p0 + 16 * i + 16]) for i in range(npts)]
        rings = [pts[parts[i]:(parts[i + 1] if i + 1 < nparts else npts)] for i in range(nparts)]
        out.append((st, rings))
    return out


def polys(recs):
    from shapely.geometry import Polygon
    from shapely.geometry.polygon import orient
    res = []
    for st, rings in recs:
        if st not in (5, 15, 25):
            continue
        # shapefile: outer rings clockwise, holes counter-clockwise
        cur = None
        for r in rings:
            if len(r) < 4:
                continue
            p = Polygon(r)
            area = sum((r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]) for i in range(len(r) - 1))
            if area < 0:  # clockwise -> outer
                if cur is not None:
                    res.append(cur)
                cur = Polygon(r)
            elif cur is not None:
                cur = Polygon(cur.exterior.coords, list(cur.interiors) + [p.exterior])
        if cur is not None:
            res.append(cur)
    return res


def lines(recs):
    from shapely.geometry import LineString
    return [LineString(r) for st, rings in recs if st in (3, 13, 23) for r in rings if len(r) >= 2]


def rnd(g, nd=4):
    m = mapping(g)
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    m['coordinates'] = r(m['coordinates'])
    return m


def main():
    d, out = sys.argv[1], sys.argv[2]
    feats = []
    se = box(136.0, -44.0, 154.0, -31.0)  # south-east Australia detail window
    world_land = polys(read_shp(f'{d}/ne_110m_land.zip'))
    for p in world_land:
        g = p.difference(se)
        if not g.is_empty:
            feats.append({'type': 'Feature', 'properties': {'k': 'land'}, 'geometry': rnd(g.simplify(0.02), 3)})
    detail = [p.intersection(se) for p in polys(read_shp(f'{d}/ne_10m_land.zip')) if p.intersects(se)]
    for g in detail:
        if not g.is_empty:
            feats.append({'type': 'Feature', 'properties': {'k': 'land'}, 'geometry': rnd(g.simplify(0.003), 4)})
    for l in lines(read_shp(f'{d}/ne_110m_admin_0_boundary_lines_land.zip')):
        feats.append({'type': 'Feature', 'properties': {'k': 'border'}, 'geometry': rnd(l.simplify(0.02), 3)})
    for l in lines(read_shp(f'{d}/ne_10m_admin_1_states_provinces_lines.zip')):
        if l.intersects(se):
            g = l.intersection(se)
            if not g.is_empty:
                feats.append({'type': 'Feature', 'properties': {'k': 'state'}, 'geometry': rnd(g.simplify(0.003), 4)})
    for p in polys(read_shp(f'{d}/ne_10m_lakes.zip')):
        if p.intersects(se) and p.area > 0.002:
            feats.append({'type': 'Feature', 'properties': {'k': 'lake'}, 'geometry': rnd(p.intersection(se).simplify(0.003), 4)})
    fc = {'type': 'FeatureCollection', 'features': feats}
    with open(out, 'w') as fh:
        json.dump(fc, fh, separators=(',', ':'))
    print(len(feats), 'features')


if __name__ == '__main__':
    main()
