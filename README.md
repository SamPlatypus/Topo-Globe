# Topo Globe

Offline 3D topographic maps of Victoria for Android (Capacitor). The app opens on a 3D globe; tapping a loaded region flies into a 3D terrain map with 10 m contours, hillshade, steep-ground colouring, OpenStreetMap roads/tracks/paths and Vicmap waterways. **The app makes no network calls** – the APK does not even request the INTERNET permission – and every calculation runs on the phone.

*by @SamAndNinjaCat*

## Downloads

- Test APKs: the GitHub Pages download page of this repository (`https://samplatypus.github.io/Topo-Globe/`), rebuilt by the **App** workflow on every push together with the automated done-check results.
- Region files: release **`regions-v1`** (`vic_<ID>.topo`), built by the **Regions** workflow.

## Regions

Victoria is split into 40 one-degree cells (about 88 × 111 km), aligned with the Copernicus GLO-30 tiles and named by their south-west corner (`S38E145` = 38–37° S, 145–146° E). Each file holds:

| Layer | Source | Encoding |
|---|---|---|
| Elevation | Copernicus DEM GLO-30, full 1″ grid (3601 × 3601 incl. shared edges) | TGD1: 8-neighbour predictor + slope-adaptive quantisation (0.5 m on ground flatter than 1:6, 1 m to 1:3, 2 m steeper → contour lines move ≤ 3 m) + context-modelled binary range coding, in independent 240 × 240 blocks |
| Roads, tracks, paths, walker POIs | OpenStreetMap (Geofabrik Australia extract) | TGV1: junction-preserving chains, Douglas-Peucker 2 m, 2e-5° grid, delta + range coding in 8 × 8 chunks |
| Waterways, water bodies, waterfalls/springs | Vicmap Hydro (DataVic WFS) | as above, 4 m simplification (1:25 000 product) |

Neighbouring regions share their edge samples and their boundary-crossing road segments, so contours and walking routes continue across region edges. Nothing is derived from elevation: streams are only the mapped Vicmap features.

Build one region locally (needs Python 3.12 with `pipeline/requirements.txt`, Node 22, optionally `osmium-tool`):

```sh
npm ci
python pipeline/build_region.py --id S38E145 --osm australia-latest.osm.pbf --out dist-regions
```

## Calculations (all offline, on the phone)

- **Distance, bearing, area** – WGS84 ellipsoid, Karney's algorithms (GeographicLib); cross-checked against Vincenty in the tests.
- **Grid references** – MGA2020 zones 54/55 (GRS80 Transverse Mercator, Krüger series to n⁸, matches PROJ to < 1 mm), 100 km square letters and 6/8-figure references; grid convergence for grid bearings. GPS positions are moved from WGS84/ATRF2014 to GDA2020 with the Australian plate motion model before a grid reference is shown.
- **Magnetic declination** – bundled World Magnetic Model WMM2025, degree-12 spherical-harmonic synthesis (passes all 100 official test values); bearings shown true, magnetic and grid.
- **Elevation** – bilinear interpolation of the 30 m grid.
- **Contours** – marching squares on the phone from the native grid; 10 m (index 50 m) from zoom 14, 20/100 m at 13, 50/250 m at 12, 100/500 m at 11, 200/1000 m at 10.
- **Hillshade, slope, steep ground** – multidirectional hillshade; slope from central differences with ellipsoidal grid spacing, coloured from 15° to ≥ 40°.
- **Profiles** – geodesic legs sampled every ≤ 15 m; ascent/descent on a 45 m moving average with a 3 m hysteresis (rejects DEM noise).
- **Walking routes** – A* on mapped tracks, paths and roads (private and no-foot ways excluded); edge time from Tobler's hiking function with elevations sampled every ≤ 30 m; admissible straight-line heuristic at 6 km/h.
- **GPS** – raw GNSS (Android GPS provider, no network location), accuracy circle, satellites-in-view/used while waiting for a slow first fix with no phone signal.
- **Waypoints** – written to app storage with fsync + atomic rename (survive crashes and reboots).
- **Budget phones** – a frame-rate governor steps render resolution, labels, slope shading, pitch and finally 3D down when frames get slow, and back up when they are fast.

## Development

```sh
npm ci
npm test                 # unit tests: codecs, geodesy, MGA2020, WMM2025, contours, Tobler, A*
npx vite build           # web bundle in dist/
npx cap sync android && (cd android && ./gradlew assembleDebug)
node tests/e2e/serve.mjs dist 4173 & node tests/e2e/browser-donecheck.mjs http://127.0.0.1:4173/ vic_S38E145.topo out
```

`tests/e2e/android-donecheck.mjs` is the phone done-check run on an Android emulator in CI: airplane mode, the real Android file picker, emulator GNSS, waypoint, profile, route, then `adb reboot` and a check that the waypoint survived.

Test APKs are signed with a committed **test-only** key (`android/app/test-signing.keystore`) so that newer test builds install over older ones without losing data. Do not use it for store releases.

## Credits

- Roads, tracks, paths and POIs © OpenStreetMap contributors, ODbL 1.0 – openstreetmap.org/copyright. Region files are a derived database, also under the ODbL.
- Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.
- Vicmap Hydro © State of Victoria (Department of Transport and Planning), CC BY 4.0.
- World Magnetic Model WMM2025 – NOAA NCEI and BGS (public domain). Natural Earth (public domain).
- Software: MapLibre GL JS (BSD-3-Clause), GeographicLib (MIT), fflate (MIT), Capacitor (MIT).
