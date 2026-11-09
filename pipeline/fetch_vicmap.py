#!/usr/bin/env python3
"""Download Vicmap Hydro features (DataVic open-data WFS) for one region bbox.

Writes a GeoJSON FeatureCollection per layer.  The WFS caps responses at 5000
features, so we page with startIndex over a stable sort (ufi).
Data: Vicmap Hydro (c) State of Victoria (Department of Transport and Planning), CC BY 4.0.
"""
import argparse, json, sys, time, urllib.parse, urllib.request

WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs"
LAYERS = {
    # layer: attributes we keep (geometry column is 'geom')
    "hy_watercourse": ["ufi", "feature_type_code", "name", "hierarchy", "construction", "usage", "geom"],
    "hy_water_area_polygon": ["ufi", "feature_type_code", "name", "geom"],
    "hy_water_point": ["ufi", "feature_type_code", "name", "geom"],
}
PAGE = 5000


def get(url, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "topo-globe-region-builder"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # network hiccups: back off and retry
            if i == tries - 1:
                raise
            wait = 2 ** (i + 1)
            print(f"  retry in {wait}s after {e}", file=sys.stderr)
            time.sleep(wait)


def fetch_layer(layer, south, west, north, east):
    feats = []
    start = 0
    total = None
    while True:
        q = {
            "service": "WFS", "version": "2.0.0", "request": "GetFeature",
            "typeNames": f"open-data-platform:{layer}",
            "outputFormat": "application/json", "srsName": "EPSG:4326",
            "count": str(PAGE), "startIndex": str(start), "sortBy": "ufi",
            "propertyName": ",".join(LAYERS[layer]),
            # WFS 2.0 + EPSG:4326 urn => lat,lon axis order
            "bbox": f"{south},{west},{north},{east},urn:ogc:def:crs:EPSG::4326",
        }
        d = json.loads(get(WFS + "?" + urllib.parse.urlencode(q)))
        page = d.get("features", [])
        total = d.get("numberMatched", total)
        feats.extend(page)
        print(f"  {layer}: {len(feats)}/{total}", file=sys.stderr)
        if len(page) < PAGE:
            break
        start += PAGE
    # de-duplicate by ufi (defensive against paging overlaps)
    seen, out = set(), []
    for f in feats:
        u = f["properties"].get("ufi")
        if u in seen:
            continue
        seen.add(u)
        out.append(f)
    if total is not None and len(out) < int(total) * 0.999:
        raise SystemExit(f"{layer}: only {len(out)} of {total} features downloaded")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", required=True, help="west,south,east,north (degrees)")
    ap.add_argument("--out", required=True, help="output prefix")
    a = ap.parse_args()
    w, s, e, n = map(float, a.bbox.split(","))
    for layer in LAYERS:
        feats = fetch_layer(layer, s, w, n, e)
        with open(f"{a.out}{layer}.geojson", "w") as fh:
            json.dump({"type": "FeatureCollection", "features": feats}, fh)
        print(f"{layer}: {len(feats)} features", file=sys.stderr)


if __name__ == "__main__":
    main()
