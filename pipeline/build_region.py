#!/usr/bin/env python3
"""Build one region file end to end.

  python pipeline/build_region.py --id S38E145 --osm work/australia-latest.osm.pbf --out dist-regions

Steps: Copernicus GLO-30 DEM (stitched with neighbour edges) -> Vicmap Hydro
(DataVic WFS) -> OpenStreetMap roads/tracks/paths/POIs (osmium extract of the
region + margin) -> encode_region.ts (same codecs as the app) -> vic_<ID>.topo
"""
import argparse, datetime, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)


def run(cmd, **kw):
    print('+', ' '.join(cmd), file=sys.stderr, flush=True)
    return subprocess.run(cmd, check=True, **kw)


def region_name(rid):
    src = open(os.path.join(ROOT, 'src/shared/regions-vic.ts')).read()
    import re
    m = re.search(r"id: '%s', name: \"([^\"]+)\"" % rid, src)
    return m.group(1) if m else rid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True)
    ap.add_argument('--osm', required=True, help='OSM .osm.pbf covering the region (Australia extract)')
    ap.add_argument('--osm-date', default='')
    ap.add_argument('--work', default='work')
    ap.add_argument('--out', default='dist-regions')
    a = ap.parse_args()
    rid = a.id
    lat_s = -int(rid[1:3]) if rid[0] == 'S' else int(rid[1:3])
    lon_w = int(rid[4:7]) if rid[3] == 'E' else -int(rid[4:7])
    W, S, E, N = lon_w, lat_s, lon_w + 1, lat_s + 1
    work = os.path.join(a.work, rid)
    os.makedirs(work, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)
    py = sys.executable
    # 1. DEM
    dem = os.path.join(work, f'{rid}.f32')
    run([py, os.path.join(HERE, 'prepare_dem.py'), '--id', rid, '--cache', os.path.join(a.work, 'cop'), '--out', dem])
    # 2. Vicmap Hydro (small margin so features crossing the edge are clipped exactly at it)
    vic_prefix = os.path.join(work, f'{rid}_')
    run([py, os.path.join(HERE, 'fetch_vicmap.py'), '--bbox', f'{W - 0.005},{S - 0.005},{E + 0.005},{N + 0.005}', '--out', vic_prefix])
    # 3. OSM extract (margin keeps ways that cross the boundary whole up to their first outside node)
    osm_small = os.path.join(work, f'{rid}.osm.pbf')
    if shutil.which('osmium'):
        run(['osmium', 'extract', '-b', f'{W - 0.05},{S - 0.05},{E + 0.05},{N + 0.05}', '--strategy', 'complete_ways', '-O', '-o', osm_small, a.osm])
    else:
        osm_small = a.osm
    vec = os.path.join(work, f'{rid}_vectors.json')
    run([py, os.path.join(HERE, 'prepare_vectors.py'), '--osm', osm_small, '--vicmap-prefix', vic_prefix, '--bbox', f'{W},{S},{E},{N}', '--out', vec])
    # 4. encode
    today = datetime.date.today().isoformat()
    meta = {
        'id': rid, 'name': region_name(rid), 'bounds': [W, S, E, N], 'rows': 3601, 'cols': 3601,
        'north': N, 'west': W, 'dLat': 1 / 3600, 'dLon': 1 / 3600,
        'sources': {
            'copernicus': 'Copernicus DEM GLO-30 (public COG tiles, AWS open data)',
            'vicmap': f'Vicmap Hydro via DataVic open data WFS, fetched {today}',
            'osm': f'OpenStreetMap Australia extract{(" of " + a.osm_date) if a.osm_date else ""}',
        },
    }
    meta_path = os.path.join(work, f'{rid}_meta.json')
    with open(meta_path, 'w') as fh:
        json.dump(meta, fh)
    out = os.path.join(a.out, f'vic_{rid}.topo')
    run(['npx', 'tsx', os.path.join(ROOT, 'pipeline/encode_region.ts'), '--dem', dem, '--vectors', vec, '--meta', meta_path, '--out', out], cwd=ROOT)
    print(json.dumps({'id': rid, 'file': out, 'bytes': os.path.getsize(out)}))


if __name__ == '__main__':
    main()
