#!/usr/bin/env python3
"""Download Copernicus DEM GLO-30 tiles and stitch the 3601 x 3601 grid of one region.

A region is one 1x1 degree Copernicus tile (named by its south-west corner, e.g.
S38E145 = 38..37 S, 145..146 E).  Samples sit exactly on whole arcseconds; the
tile holds rows lat0+1 .. lat0+1/3600 and columns lon0 .. lon0+1-1/3600.  We add
the closing row (first row of the tile to the south) and closing column (first
column of the tile to the east), so neighbouring regions share their edge
samples and contours/routes join exactly.  Missing tiles are open ocean -> 0 m.

Source: Copernicus DEM GLO-30 public COGs on AWS (copernicus-dem-30m bucket).
"""
import argparse, json, os, sys, time, urllib.request

import numpy as np
import rasterio

BASE = 'https://copernicus-dem-30m.s3.amazonaws.com'


def tile_name(lat_s, lon_w):
    ns = 'S' if lat_s < 0 else 'N'
    ew = 'W' if lon_w < 0 else 'E'
    return f'Copernicus_DSM_COG_10_{ns}{abs(lat_s):02d}_00_{ew}{abs(lon_w):03d}_00_DEM'


def fetch(lat_s, lon_w, cache):
    name = tile_name(lat_s, lon_w)
    path = os.path.join(cache, name + '.tif')
    if os.path.exists(path):
        return path
    url = f'{BASE}/{name}/{name}.tif'
    for i in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'topo-globe-region-builder'})
            with urllib.request.urlopen(req, timeout=300) as r, open(path + '.part', 'wb') as fh:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    fh.write(b)
            os.replace(path + '.part', path)
            return path
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None  # no tile: ocean
            err = e
        except Exception as e:  # noqa
            err = e
        time.sleep(2 ** (i + 1))
    raise SystemExit(f'failed to download {url}: {err}')


def read(path):
    with rasterio.open(path) as ds:
        if ds.width != 3600 or ds.height != 3600:
            raise SystemExit(f'{path}: unexpected size {ds.width}x{ds.height} (expected 3600 for latitudes < 50 deg)')
        t = ds.transform
        if abs(t.a - 1 / 3600) > 1e-12 or abs(t.e + 1 / 3600) > 1e-12:
            raise SystemExit(f'{path}: unexpected pixel size')
        return ds.read(1).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--id', required=True, help='e.g. S38E145')
    ap.add_argument('--cache', default='work/cop')
    ap.add_argument('--out', required=True, help='output .f32 path')
    a = ap.parse_args()
    lat_s = (-1 if a.id[0] == 'S' else 1) * int(a.id[1:3])
    lon_w = (-1 if a.id[3] == 'W' else 1) * int(a.id[4:7])
    os.makedirs(a.cache, exist_ok=True)
    main_tile = fetch(lat_s, lon_w, a.cache)
    if not main_tile:
        raise SystemExit(f'{a.id}: no Copernicus tile (all ocean)')
    g = np.zeros((3601, 3601), np.float32)
    g[:3600, :3600] = read(main_tile)
    s = fetch(lat_s - 1, lon_w, a.cache)        # south neighbour: its first row is our closing row
    e = fetch(lat_s, lon_w + 1, a.cache)        # east neighbour: its first column is our closing column
    se = fetch(lat_s - 1, lon_w + 1, a.cache)
    if s:
        g[3600, :3600] = read(s)[0, :]
    else:
        g[3600, :3600] = g[3599, :3600]
    if e:
        g[:3600, 3600] = read(e)[:, 0]
    else:
        g[:3600, 3600] = g[:3600, 3599]
    if se:
        g[3600, 3600] = read(se)[0, 0]
    else:
        g[3600, 3600] = g[3599, 3599]
    if not np.isfinite(g).all():
        bad = ~np.isfinite(g)
        print(f'warning: {bad.sum()} non-finite samples set to 0', file=sys.stderr)
        g[bad] = 0
    g.tofile(a.out)
    print(json.dumps({'id': a.id, 'min': float(g.min()), 'max': float(g.max()), 'neighbours': {'south': bool(s), 'east': bool(e), 'southeast': bool(se)}}))


if __name__ == '__main__':
    main()
