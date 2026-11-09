/**
 * Topo Globe – offline 3D topographic maps of Victoria.
 *
 * Opens on a 3D globe.  Region files (.topo) are added from the phone's file
 * picker; tapping a loaded region flies into the 3D terrain map.  Everything
 * runs on the phone; the app has no network permission and makes no network
 * requests.
 */
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, MapMouseEvent, GeoJSONSource } from 'maplibre-gl';
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import TileWorker from './worker/terrain.worker.ts?worker';
import { WorkerPool } from './app/workers';
import { registerProtocols } from './map/protocols';
import { buildStyle } from './map/style';
import { FrameGovernor } from './map/governor';
import * as P from './app/platform';
import { VIC_REGIONS, VIC_OUTLINE, regionBounds } from './shared/regions-vic';
import { CREDITS } from './shared/credits';
import { inverse, direct, polygonArea, geodesicCircle } from './shared/geo/geodesic';
import { magneticField, decimalYear } from './shared/geo/wmm';
import { atrfToGda2020 } from './shared/geo/gda2020';
import { formatDuration } from './shared/calc/tobler';
import { ASCENT_THRESHOLD_M } from './shared/calc/profile';
import { SLOPE_CLASSES } from './worker/tiles';
import { drawProfile, profileIndexAt, type ProfileData } from './ui/chart';
import { fmtDist, fmtElev, fmtArea, fmtBearing, fmtDecl, fmtLatLon, fmtDms, fmtGrid, fmtAgo, fmtClock, esc } from './ui/format';
import type { RouteResult } from './shared/calc/routing';
import type { ProfileStats } from './shared/calc/profile';

// ---------------------------------------------------------------- types & state
interface LoadedRegion {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  size: number;
  stored: P.StoredRegion;
}
interface Waypoint {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elev: number | null;
  created: string;
  source: 'gps' | 'map';
  epoch?: number; // decimal year of a GPS observation (for GDA2020 conversion)
  accuracy?: number;
}
interface Settings {
  zone: 'auto' | 54 | 55;
  hillshade: boolean;
  slope: boolean;
  contours: boolean;
  roads: boolean;
  water: boolean;
  terrain3d: boolean;
  exaggeration: number;
}
interface ProfileResult extends ProfileData { lon: Float64Array; lat: Float64Array; stats: ProfileStats }

const DEFAULT_SETTINGS: Settings = { zone: 'auto', hillshade: true, slope: true, contours: true, roads: true, water: true, terrain3d: true, exaggeration: 1.3 };

const state = {
  regions: new Map<string, LoadedRegion>(),
  waypoints: [] as Waypoint[],
  settings: { ...DEFAULT_SETTINGS },
  gps: { on: false, fix: null as P.GpsFix | null, gnss: null as P.GnssStatus | null, startedAt: 0, error: '' as string, centred: false },
  mode: 'browse' as 'browse' | 'measure' | 'route',
  measure: { pts: [] as [number, number][], closed: false, profile: null as ProfileResult | null },
  route: { from: null as [number, number] | null, to: null as [number, number] | null, result: null as (RouteResult & { profile: ProfileResult }) | null, busy: false },
  welcome: true,
};
(window as unknown as { __topo: unknown }).__topo = state; // inspection hook for automated checks

// ---------------------------------------------------------------- DOM
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
document.body.innerHTML = `
  <div id="map" aria-label="Map"></div>
  <div id="status" class="status hidden" role="status" aria-live="polite"></div>
  <div id="crosshair" class="crosshair hidden" aria-hidden="true"></div>
  <div id="sheet" class="sheet hidden" role="dialog" aria-modal="false"></div>
  <nav id="menu" class="menu" aria-label="Menu"></nav>
  <button id="dots" class="dots" aria-label="Menu" aria-expanded="true"><span></span><span></span><span></span></button>
  <div id="toast" class="toast hidden" role="alert"></div>
`;
const menuEl = $<HTMLElement>('#menu');
const sheetEl = $<HTMLElement>('#sheet');
const statusEl = $<HTMLElement>('#status');
const dotsEl = $<HTMLButtonElement>('#dots');
const toastEl = $<HTMLElement>('#toast');
const crossEl = $<HTMLElement>('#crosshair');

let toastTimer = 0;
function toast(msg: string, ms = 3500): void {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), ms);
}

// ---------------------------------------------------------------- workers & map
const cores = navigator.hardwareConcurrency || 4;
const pool = new WorkerPool(cores >= 4 ? 2 : 1, () => new TileWorker());
registerProtocols(pool);
maplibregl.setWorkerUrl(mlWorkerUrl);
maplibregl.setWorkerCount(Math.max(1, Math.min(2, cores - 2)));

let map: MlMap;
let governor: FrameGovernor;
let terrainOn = false;
/** set once the current style has loaded (map.isStyleLoaded() is false while tiles stream in) */
let styleReady = false;

function regionUnionBounds(): [number, number, number, number] | null {
  if (!state.regions.size) return null;
  let w = 180, s = 90, e = -180, n = -90;
  for (const r of state.regions.values()) {
    w = Math.min(w, r.bounds[0]); s = Math.min(s, r.bounds[1]);
    e = Math.max(e, r.bounds[2]); n = Math.max(n, r.bounds[3]);
  }
  return [w, s, e, n];
}

function createMap(): void {
  map = new maplibregl.Map({
    container: 'map',
    style: buildStyle({ bounds: regionUnionBounds() }),
    center: [140, -30],
    zoom: 1.4,
    maxPitch: 75,
    attributionControl: false,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
    fadeDuration: 0,
    canvasContextAttributes: { antialias: false, powerPreference: 'default' },
    maxTileCacheZoomLevels: 3,
    refreshExpiredTiles: false,
  } as maplibregl.MapOptions);
  map.touchZoomRotate.enableRotation();
  map.on('load', () => {
    styleReady = true;
    refreshOverlays();
    applyLayerSettings();
    updateTerrain();
  });
  map.on('zoomend', () => updateTerrain());
  map.on('moveend', () => updateTerrain());
  map.on('click', onMapClick);
  governor = new FrameGovernor(map);
  (window as unknown as { __gov: unknown }).__gov = governor;
  governor.onChange = (lvl) => {
    applyLayerSettings();
    updateTerrain();
    map.setMaxPitch(lvl.maxPitch);
    if (governor.level >= 3) toast(`Slow phone detected – switched to ${lvl.label} to keep the map moving.`);
  };
}

function rebuildStyle(): void {
  terrainOn = false;
  styleReady = false;
  map.setStyle(buildStyle({ bounds: regionUnionBounds() }), { diff: false });
  map.once('style.load', () => {
    styleReady = true;
    refreshOverlays();
    applyLayerSettings();
    updateTerrain();
  });
}

function updateTerrain(): void {
  if (!map || !styleReady) return;
  const lvl = governor?.levels[governor.level];
  const want = state.settings.terrain3d && state.regions.size > 0 && map.getZoom() >= 6 && (lvl?.terrain ?? true) && !!map.getSource('dem');
  if (want && !terrainOn) {
    map.setTerrain({ source: 'dem', exaggeration: state.settings.exaggeration });
    terrainOn = true;
  } else if (!want && terrainOn) {
    map.setTerrain(null);
    terrainOn = false;
  } else if (want && terrainOn) {
    const t = map.getTerrain();
    if (t && t.exaggeration !== state.settings.exaggeration) map.setTerrain({ source: 'dem', exaggeration: state.settings.exaggeration });
  }
}

function applyLayerSettings(): void {
  if (!map || !styleReady) return;
  const lvl = governor?.levels[governor.level];
  const vis = (ids: string[], on: boolean) => ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  const s = state.settings;
  vis(['hillshade'], s.hillshade);
  vis(['slope'], s.slope && (lvl?.slope ?? true));
  vis(['contour-minor', 'contour-index'], s.contours);
  vis(['contour-label'], s.contours && (lvl?.labels ?? true));
  vis(['road-casing', 'road-fill', 'track', 'path'], s.roads);
  vis(['road-label'], s.roads && (lvl?.labels ?? true));
  vis(['water-area', 'water-line'], s.water);
  vis(['water-label'], s.water && (lvl?.labels ?? true));
}

function setData(src: string, fc: GeoJSON.FeatureCollection): void {
  const s = map?.getSource(src) as GeoJSONSource | undefined;
  s?.setData(fc);
}

function refreshOverlays(): void {
  if (!map || !styleReady) return;
  const feats: GeoJSON.Feature[] = [];
  feats.push({ type: 'Feature', properties: { k: 'vic' }, geometry: { type: 'MultiPolygon', coordinates: VIC_OUTLINE.map((r) => [r]) } });
  for (const c of VIC_REGIONS) {
    const [w, s, e, n] = regionBounds(c);
    const loaded = state.regions.has(c.id);
    feats.push({ type: 'Feature', properties: { k: loaded ? 'loaded' : 'cell', id: c.id, name: c.name }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
  }
  for (const r of state.regions.values()) {
    if (VIC_REGIONS.some((c) => c.id === r.id)) continue;
    const [w, s, e, n] = r.bounds;
    feats.push({ type: 'Feature', properties: { k: 'loaded', id: r.id, name: r.name }, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
  }
  setData('regions', { type: 'FeatureCollection', features: feats });
  renderWaypoints();
  renderGps();
  renderMeasure();
  renderRoute();
}

// ---------------------------------------------------------------- persistence
async function saveWaypoints(): Promise<void> {
  try {
    await P.writeText('waypoints.json', JSON.stringify({ version: 1, waypoints: state.waypoints }));
  } catch (e) {
    toast('Could not save waypoints: ' + (e as Error).message, 6000);
  }
}
async function loadWaypoints(): Promise<void> {
  const t = await P.readText('waypoints.json');
  if (!t) return;
  try {
    const d = JSON.parse(t);
    if (Array.isArray(d.waypoints)) state.waypoints = d.waypoints;
  } catch { /* ignore corrupt file */ }
}
async function saveSettings(): Promise<void> {
  await P.writeText('settings.json', JSON.stringify(state.settings)).catch(() => undefined);
}
async function loadSettings(): Promise<void> {
  const t = await P.readText('settings.json');
  if (t) try { state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(t) }; } catch { /* defaults */ }
}

// ---------------------------------------------------------------- regions
interface WorkerMeta { meta: { id: string; name: string; bounds: [number, number, number, number]; dem: { maxErrorM: number }; vec: { counts: Record<string, number> } }; size: number }

async function loadRegionIntoWorkers(stored: P.StoredRegion, bytes: ArrayBuffer | null, verify: boolean): Promise<WorkerMeta> {
  const results = await pool.all<WorkerMeta>((i) => {
    if (stored.url) return { msg: { type: 'load', key: stored.id, url: stored.url, verify: verify && i === 0 } };
    const copy = bytes!.slice(0);
    return { msg: { type: 'load', key: stored.id, bytes: copy, verify: verify && i === 0 }, transfer: [copy] };
  });
  return results[0];
}

async function restoreRegions(): Promise<void> {
  const list = await P.listStoredRegions().catch(() => [] as P.StoredRegion[]);
  for (const s of list) {
    try {
      const bytes = await P.readStoredRegion(s);
      if (!s.url && !bytes) continue;
      const r = await loadRegionIntoWorkers(s, bytes, false);
      state.regions.set(r.meta.id, { id: r.meta.id, name: r.meta.name, bounds: r.meta.bounds, size: r.size, stored: s });
    } catch (e) {
      console.warn('could not restore region', s.id, e);
    }
  }
}

async function addRegion(): Promise<void> {
  closeMenu();
  let picked: P.PickedRegion | null = null;
  try {
    picked = await P.pickRegionFile();
  } catch (e) {
    toast('Could not open the file picker: ' + (e as Error).message, 6000);
    return;
  }
  if (!picked) return;
  showStatus(`Checking ${picked.name}…`);
  try {
    // verify in a worker before keeping anything
    const tmpStored: P.StoredRegion = picked.tmpPath ? { id: '__import', size: picked.size, path: picked.tmpPath, url: P.fileUrl(picked.tmpPath) } : { id: '__import', size: picked.size };
    const meta = await loadRegionIntoWorkers(tmpStored, picked.bytes ?? null, true);
    await pool.all(() => ({ msg: { type: 'unload', key: '__import' } }));
    const id = meta.meta.id;
    const stored = await P.storeRegion(id, picked);
    const old = state.regions.get(id);
    if (old) await pool.all(() => ({ msg: { type: 'unload', key: id } }));
    const bytes = await P.readStoredRegion(stored);
    const m = await loadRegionIntoWorkers(stored, bytes, false);
    state.regions.set(id, { id, name: m.meta.name, bounds: m.meta.bounds, size: m.size, stored });
    hideStatus();
    rebuildStyle();
    toast(`Loaded ${id} – ${m.meta.name} (${(m.size / 1048576).toFixed(1)} MB). Tap it on the globe to fly in.`, 6000);
    flyToRegion(id, true);
  } catch (e) {
    hideStatus();
    await P.discardPicked(picked);
    await pool.all(() => ({ msg: { type: 'unload', key: '__import' } })).catch(() => undefined);
    toast((e as Error).message, 8000);
  }
}

async function removeRegion(id: string): Promise<void> {
  const r = state.regions.get(id);
  if (!r) return;
  if (!confirm(`Remove ${id} – ${r.name} from this phone?`)) return;
  await pool.all(() => ({ msg: { type: 'unload', key: id } }));
  await P.deleteStoredRegion(r.stored);
  state.regions.delete(id);
  rebuildStyle();
  openMenu('regions');
}

function flyToRegion(id: string, overview = false): void {
  const r = state.regions.get(id);
  const cell = VIC_REGIONS.find((c) => c.id === id);
  const b = r?.bounds ?? (cell ? regionBounds(cell) : null);
  if (!b) return;
  closeMenu();
  const centre: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  if (overview) map.flyTo({ center: centre, zoom: 7.2, pitch: 0, bearing: 0, duration: 2500, essential: true });
  else map.flyTo({ center: centre, zoom: 11.2, pitch: 62, bearing: -15, duration: 5000, curve: 1.6, essential: true });
}

function backToGlobe(): void {
  closeMenu();
  closeSheet();
  map.flyTo({ center: [140, -30], zoom: 1.4, pitch: 0, bearing: 0, duration: 3000, essential: true });
}

// ---------------------------------------------------------------- map taps
function onMapClick(e: MapMouseEvent): void {
  const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
  if (state.mode === 'measure') {
    state.measure.pts.push(lngLat);
    renderMeasure();
    updateMeasure();
    return;
  }
  if (state.mode === 'route') {
    if (!state.route.from) state.route.from = lngLat;
    else state.route.to = lngLat;
    renderRoute();
    updateRoutePanel();
    if (state.route.from && state.route.to) void computeRoute();
    return;
  }
  // globe / low zoom: tap a region cell
  if (map.getZoom() < 9) {
    const hits = map.queryRenderedFeatures(e.point, { layers: ['loaded-fill'] });
    if (hits.length) {
      flyToRegion(String(hits[0].properties?.id));
      return;
    }
    const cell = VIC_REGIONS.find((c) => lngLat[0] >= c.west && lngLat[0] < c.west + 1 && lngLat[1] >= c.south && lngLat[1] < c.south + 1);
    if (cell && map.getZoom() >= 4) {
      showSheet(`<h2>${cell.id} · ${esc(cell.name)}</h2><p>This region is not loaded yet. Download <b>vic_${cell.id}.topo</b> from the Topo Globe download page, then use <b>Add region</b> in the menu.</p>${btn('close', 'Close')}`);
      return;
    }
  }
  void showPointInfo(lngLat);
}

// ---------------------------------------------------------------- point info
interface PointInfo { elev: number; slope: number; aspect: number; region: string | null }

async function showPointInfo(ll: [number, number]): Promise<void> {
  const [lon, lat] = ll;
  setData('focus', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: ll } }] });
  const info = await pool.query<PointInfo>({ type: 'point', lon, lat });
  const g = fmtGrid(lat, lon, state.settings.zone);
  const mf = magneticField(lat, lon, Number.isFinite(info.elev) ? info.elev : 0, decimalYear(new Date()));
  let fromGps = '';
  const fix = currentFix();
  if (fix) {
    const inv = inverse(fix.lat, fix.lon, lat, lon);
    fromGps = `<div class="row"><span>From you</span><b>${fmtDist(inv.s12)} · ${fmtBearing(inv.azi1, magneticField(fix.lat, fix.lon, 0, decimalYear(new Date())).decl, g.convergence)}</b></div>`;
  }
  showSheet(`
    <h2>${info.region ? fmtElev(info.elev) : 'Outside loaded regions'}</h2>
    <div class="rows">
      ${info.region ? `<div class="row"><span>Elevation</span><b>${fmtElev(info.elev)} <small>(30 m grid, bilinear)</small></b></div>
      <div class="row"><span>Slope</span><b>${Number.isFinite(info.slope) ? `${info.slope.toFixed(0)}° (${Math.round(Math.tan((info.slope * Math.PI) / 180) * 100)} %), facing ${compass(info.aspect)}` : '–'}</b></div>` : ''}
      <div class="row"><span>Grid ref</span><b>${g.ref}</b></div>
      <div class="row"><span>MGA2020</span><b>${g.full}</b></div>
      <div class="row"><span>Lat / lon</span><b>${fmtLatLon(lat, lon)}<br>${fmtDms(lat, lon)}</b></div>
      <div class="row"><span>Declination</span><b>${fmtDecl(mf.decl)} (WMM2025)</b></div>
      ${fromGps}
    </div>
    <div class="btns">${btn('wpt-here', 'Waypoint here')}${btn('route-here', 'Route to here')}${btn('close', 'Close')}</div>`);
  sheetEl.dataset.lon = String(lon);
  sheetEl.dataset.lat = String(lat);
}

function compass(az: number): string {
  if (!Number.isFinite(az)) return '–';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(az / 22.5) % 16];
}

// ---------------------------------------------------------------- waypoints
function currentFix(maxAgeMs = 120000): P.GpsFix | null {
  const f = state.gps.fix;
  if (!f || f.provider === 'last-known' || !state.gps.on) return null;
  return Date.now() - (f.received ?? f.time) < maxAgeMs ? f : null;
}

async function addWaypoint(at?: [number, number]): Promise<void> {
  closeMenu();
  let lon: number, lat: number;
  let source: 'gps' | 'map' = 'map';
  let epoch: number | undefined;
  let accuracy: number | undefined;
  const fix = currentFix(30000);
  if (at) [lon, lat] = at;
  else if (fix) {
    lon = fix.lon; lat = fix.lat; source = 'gps'; epoch = decimalYear(new Date(fix.time)); accuracy = fix.accuracy;
  } else {
    const c = map.getCenter();
    lon = c.lng; lat = c.lat;
  }
  const info = await pool.query<PointInfo>({ type: 'point', lon, lat }).catch(() => ({ elev: NaN } as PointInfo));
  let n = state.waypoints.length + 1;
  while (state.waypoints.some((w) => w.name === `WP ${n}`)) n++;
  const wp: Waypoint = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: `WP ${n}`, lat, lon,
    elev: Number.isFinite(info.elev) ? Math.round(info.elev) : null, created: new Date().toISOString(), source, epoch, accuracy,
  };
  state.waypoints.push(wp);
  await saveWaypoints();
  renderWaypoints();
  toast(`${wp.name} saved ${source === 'gps' ? `at your GPS position (±${Math.round(accuracy ?? 0)} m)` : 'at the map centre'}.`);
}

function waypointGrid(w: Waypoint): ReturnType<typeof fmtGrid> {
  // GPS waypoints are ITRF/WGS84 at the observation epoch: convert to GDA2020 for MGA2020
  const p = w.source === 'gps' && w.epoch ? atrfToGda2020(w.lat, w.lon, w.epoch) : { lat: w.lat, lon: w.lon };
  return fmtGrid(p.lat, p.lon, state.settings.zone);
}

function renderWaypoints(): void {
  setData('waypoints', {
    type: 'FeatureCollection',
    features: state.waypoints.map((w) => ({ type: 'Feature', properties: { name: w.name, id: w.id }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } })),
  });
}

// ---------------------------------------------------------------- GPS
let gpsTicker = 0;
async function toggleGps(): Promise<void> {
  closeMenu();
  if (state.gps.on) {
    if (currentFix()) {
      // second tap re-centres
      const f = currentFix()!;
      map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 14), duration: 1500 });
      return;
    }
    await stopGpsNow();
    return;
  }
  state.gps = { on: true, fix: null, gnss: null, startedAt: Date.now(), error: '', centred: false };
  const last = await P.lastKnownFix();
  if (last) state.gps.fix = last;
  renderGps();
  updateGpsStatus();
  gpsTicker = window.setInterval(updateGpsStatus, 1000);
  await P.keepAwake(true);
  await P.startGps({
    onFix: (f) => {
      f.received = Date.now();
      state.gps.fix = f;
      state.gps.error = '';
      renderGps();
      updateGpsStatus();
      if (!state.gps.centred) {
        state.gps.centred = true;
        map.flyTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 2500 });
      }
    },
    onGnss: (s) => { state.gps.gnss = s; },
    onError: (r) => { state.gps.error = r; updateGpsStatus(); },
  });
}

async function stopGpsNow(): Promise<void> {
  state.gps.on = false;
  clearInterval(gpsTicker);
  await P.stopGps();
  await P.keepAwake(false);
  hideStatus();
  renderGps();
}

function renderGps(): void {
  const f = state.gps.fix;
  if (!state.gps.on || !f) {
    setData('gps', { type: 'FeatureCollection', features: [] });
    return;
  }
  const stale = f.provider === 'last-known' || Date.now() - (f.received ?? f.time) > 60000;
  const ring = geodesicCircle(f.lat, f.lon, Math.max(3, Math.min(f.accuracy, 20000)), 72);
  setData('gps', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
      { type: 'Feature', properties: { stale }, geometry: { type: 'Point', coordinates: [f.lon, f.lat] } },
    ],
  });
}

function updateGpsStatus(): void {
  if (!state.gps.on) return;
  const f = state.gps.fix;
  const s = state.gps.gnss;
  const sat = s ? ` · ${s.inView} satellites seen, ${s.used} used` : '';
  if (state.gps.error) {
    showStatus(`GPS: ${state.gps.error}`);
    return;
  }
  if (f && f.provider !== 'last-known') {
    const age = Date.now() - (f.received ?? f.time);
    const gda = atrfToGda2020(f.lat, f.lon, decimalYear(new Date(f.time)));
    const g = fmtGrid(gda.lat, gda.lon, state.settings.zone);
    showStatus(`GPS ±${Math.round(f.accuracy)} m · ${age < 3000 ? 'live' : fmtAgo(age)}${sat}<br><small>${g.ref} · ${fmtLatLon(f.lat, f.lon)}</small>`);
    renderGps();
    return;
  }
  const t = Date.now() - state.gps.startedAt;
  let msg = `GPS: searching for satellites… ${fmtClock(t)}${sat}`;
  if (f && f.provider === 'last-known') msg += `<br><small>Grey dot: last known position (${fmtAgo(Date.now() - f.time)}).</small>`;
  if (t > 45000) msg += '<br><small>No phone signal? The first fix can take several minutes. Keep still with a clear view of the sky.</small>';
  showStatus(msg);
}

// ---------------------------------------------------------------- measure
function startMeasure(): void {
  closeMenu();
  state.mode = 'measure';
  state.measure = { pts: [], closed: false, profile: null };
  renderMeasure();
  updateMeasure();
}

function renderMeasure(): void {
  const pts = state.measure.pts;
  const feats: GeoJSON.Feature[] = pts.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
  if (pts.length >= 2) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: densify(state.measure.closed ? [...pts, pts[0]] : pts) } });
  if (state.measure.closed && pts.length >= 3) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [densify([...pts, pts[0]])] } });
  setData('measure', { type: 'FeatureCollection', features: feats });
}

/** Draw each leg as the geodesic it is measured along. */
function densify(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < pts.length; i++) {
    const inv = inverse(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]);
    const n = Math.min(64, Math.max(1, Math.ceil(inv.s12 / 2000)));
    if (i === 1) out.push(pts[0]);
    for (let k = 1; k <= n; k++) {
      const d = direct(pts[i - 1][1], pts[i - 1][0], inv.azi1, (inv.s12 * k) / n);
      out.push([d.lon, d.lat]);
    }
  }
  return out;
}

let measureSeq = 0;
async function updateMeasure(): Promise<void> {
  const pts = state.measure.pts;
  if (pts.length < 2) {
    showSheet(`<h2>Measure</h2><p>Tap the map to add points along a line. ${pts.length ? 'Tap the next point.' : 'Tap the first point.'}</p>
      <div class="btns">${pts.length ? btn('m-undo', 'Undo point') : ''}${btn('m-done', 'Done')}</div>`);
    return;
  }
  const seq = ++measureSeq;
  const legs = state.measure.closed ? [...pts, pts[0]] : pts;
  let total = 0;
  for (let i = 1; i < legs.length; i++) total += inverse(legs[i - 1][1], legs[i - 1][0], legs[i][1], legs[i][0]).s12;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const last = inverse(a[1], a[0], b[1], b[0]);
  const se = inverse(pts[0][1], pts[0][0], b[1], b[0]);
  const decl = magneticField(a[1], a[0], 0, decimalYear(new Date())).decl;
  const conv = fmtGrid(a[1], a[0], state.settings.zone).convergence;
  const area = state.measure.closed && pts.length >= 3 ? polygonArea(pts) : null;
  const prof = await pool.query<ProfileResult>({ type: 'profile', coords: legs });
  if (seq !== measureSeq) return;
  state.measure.profile = prof;
  const st = prof.stats;
  showSheet(`
    <h2>${fmtDist(total)}${area ? ` · ${fmtArea(area.area)}` : ''}</h2>
    <div class="rows">
      <div class="row"><span>Last leg</span><b>${fmtDist(last.s12)} · ${fmtBearing(last.azi1, decl, conv)}</b></div>
      ${pts.length > 2 ? `<div class="row"><span>Start → end</span><b>${fmtDist(se.s12)} · ${fmtBearing(se.azi1, decl, conv)}</b></div>` : ''}
      <div class="row"><span>Climb</span><b>↑ ${fmtElev(st.ascent)} · ↓ ${fmtElev(st.descent)} <small>(filtered; raw ↑${fmtElev(st.rawAscent)})</small></b></div>
      <div class="row"><span>Elevation</span><b>${fmtElev(st.min)} – ${fmtElev(st.max)}</b></div>
    </div>
    <canvas id="profile" class="profile" aria-label="Elevation profile"></canvas>
    <p class="note">WGS84 ellipsoid (Karney). Magnetic declination ${fmtDecl(decl)} (WMM2025). Ascent/descent ignore changes under ${ASCENT_THRESHOLD_M} m (grid noise).</p>
    <div class="btns">${btn('m-undo', 'Undo point')}${pts.length >= 3 ? btn('m-close', state.measure.closed ? 'Open line' : 'Close shape (area)') : ''}${btn('m-clear', 'Clear')}${btn('m-done', 'Done')}</div>`);
  attachProfile(prof);
}

function attachProfile(prof: ProfileResult): void {
  const cv = document.getElementById('profile') as HTMLCanvasElement | null;
  if (!cv) return;
  drawProfile(cv, prof);
  const onPick = (clientX: number) => {
    const i = profileIndexAt(cv, prof, clientX);
    drawProfile(cv, prof, i);
    setData('focus', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [prof.lon[i], prof.lat[i]] } }] });
  };
  cv.addEventListener('pointerdown', (e) => onPick(e.clientX));
  cv.addEventListener('pointermove', (e) => { if (e.buttons) onPick(e.clientX); });
}

// ---------------------------------------------------------------- routes
function startRoute(from?: [number, number], to?: [number, number]): void {
  closeMenu();
  state.mode = 'route';
  const fix = currentFix();
  state.route = { from: from ?? (fix ? [fix.lon, fix.lat] : null), to: to ?? null, result: null, busy: false };
  renderRoute();
  updateRoutePanel();
  if (state.route.from && state.route.to) void computeRoute();
}

function renderRoute(): void {
  const feats: GeoJSON.Feature[] = [];
  const r = state.route.result;
  if (r) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } });
  setData('route', { type: 'FeatureCollection', features: feats });
  const pts: GeoJSON.Feature[] = [];
  if (state.route.from) pts.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: state.route.from } });
  if (state.route.to) pts.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: state.route.to } });
  if (state.mode === 'route') setData('measure', { type: 'FeatureCollection', features: pts });
}

function updateRoutePanel(): void {
  const r = state.route;
  if (r.busy) {
    showSheet(`<h2>Planning route…</h2><p>Finding the quickest walk on mapped tracks and paths.</p>`);
    return;
  }
  if (!r.from || !r.to) {
    showSheet(`<h2>Walking route</h2><p>${!r.from ? 'Tap the start point (or turn on My location first).' : 'Now tap the destination.'}</p>
      <div class="btns">${currentFix() ? btn('r-from-gps', 'Start from my location') : ''}${btn('r-cancel', 'Cancel')}</div>`);
    return;
  }
  const res = r.result;
  if (!res) return;
  const st = res.profile.stats;
  const legs = res.legs.filter((l) => l.metres >= 30).slice(0, 12)
    .map((l) => `<li>${esc(l.name || roadClassName(l.cls))} <small>${fmtDist(l.metres)}</small></li>`).join('');
  showSheet(`
    <h2>${fmtDist(st.distance)} · ${formatDuration(res.seconds)}</h2>
    <div class="rows">
      <div class="row"><span>Climb</span><b>↑ ${fmtElev(st.ascent)} · ↓ ${fmtElev(st.descent)}</b></div>
      <div class="row"><span>Highest</span><b>${fmtElev(st.max)}</b></div>
    </div>
    <canvas id="profile" class="profile" aria-label="Route elevation profile"></canvas>
    <ol class="legs">${legs}</ol>
    <p class="note">Time from Tobler's hiking function on the 30 m DEM; mapped tracks and paths only (A*). Allow extra time for rough tracks, breaks and route-finding.</p>
    <div class="btns">${btn('r-new', 'New route')}${btn('r-done', 'Done')}</div>`);
  attachProfile(res.profile);
}

function roadClassName(c: number): string {
  return ['Motorway', 'Highway', 'Main road', 'Road', 'Road', 'Street', 'Service road', 'Track', 'Path', 'Footpath', 'Cycle path', 'Bridle trail', 'Steps'][c] ?? 'Way';
}

async function computeRoute(): Promise<void> {
  const r = state.route;
  if (!r.from || !r.to) return;
  if (!state.regions.size) {
    toast('Load a region first.');
    return;
  }
  r.busy = true;
  updateRoutePanel();
  try {
    const res = await pool.query<(RouteResult & { profile: ProfileResult }) | { error: string }>({ type: 'route', from: r.from, to: r.to });
    r.busy = false;
    if ('error' in res) {
      showSheet(`<h2>No route</h2><p>${esc(res.error)}</p><div class="btns">${btn('r-new', 'Try again')}${btn('r-done', 'Close')}</div>`);
      return;
    }
    r.result = res;
    renderRoute();
    updateRoutePanel();
  } catch (e) {
    r.busy = false;
    showSheet(`<h2>Route failed</h2><p>${esc((e as Error).message)}</p><div class="btns">${btn('r-done', 'Close')}</div>`);
  }
}

// ---------------------------------------------------------------- sheet / status
function btn(action: string, label: string, extra = ''): string {
  return `<button class="btn" data-action="${action}" ${extra}>${label}</button>`;
}

function showSheet(html: string): void {
  sheetEl.innerHTML = html;
  sheetEl.classList.remove('hidden');
  // while measuring or routing, keep the sheet low so the map stays tappable
  sheetEl.classList.toggle('compact', state.mode !== 'browse');
}
function closeSheet(): void {
  sheetEl.classList.add('hidden');
  sheetEl.innerHTML = '';
  setData('focus', { type: 'FeatureCollection', features: [] });
}
function showStatus(html: string): void {
  statusEl.innerHTML = html;
  statusEl.classList.remove('hidden');
}
function hideStatus(): void {
  statusEl.classList.add('hidden');
}

function endModes(): void {
  state.mode = 'browse';
  state.measure = { pts: [], closed: false, profile: null };
  state.route = { from: null, to: null, result: null, busy: false };
  renderMeasure();
  renderRoute();
  setData('measure', { type: 'FeatureCollection', features: [] });
  closeSheet();
}

sheetEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!t) return;
  const a = t.dataset.action!;
  const lon = Number(sheetEl.dataset.lon), lat = Number(sheetEl.dataset.lat);
  switch (a) {
    case 'close': closeSheet(); break;
    case 'wpt-here': void addWaypoint([lon, lat]); closeSheet(); break;
    case 'route-here': {
      const fix = currentFix();
      startRoute(fix ? [fix.lon, fix.lat] : undefined, [lon, lat]);
      break;
    }
    case 'm-undo': state.measure.pts.pop(); renderMeasure(); void updateMeasure(); break;
    case 'm-close': state.measure.closed = !state.measure.closed; renderMeasure(); void updateMeasure(); break;
    case 'm-clear': state.measure.pts = []; state.measure.closed = false; renderMeasure(); void updateMeasure(); break;
    case 'm-done': endModes(); break;
    case 'r-from-gps': { const f = currentFix(); if (f) { state.route.from = [f.lon, f.lat]; renderRoute(); updateRoutePanel(); } break; }
    case 'r-new': state.route = { from: null, to: null, result: null, busy: false }; renderRoute(); updateRoutePanel(); break;
    case 'r-cancel': case 'r-done': endModes(); break;
  }
});

// ---------------------------------------------------------------- menu
type MenuPage = 'main' | 'regions' | 'waypoints' | 'layers' | 'settings';
let menuOpen = true;
let menuPage: MenuPage = 'main';

function renderMenu(page: MenuPage = 'main'): void {
  menuPage = page;
  const s = state.settings;
  let html = '';
  if (page === 'main') {
    html = `
      ${state.welcome ? `<p class="welcome">Offline 3D topographic maps of Victoria. Tap anywhere to start.</p>` : ''}
      ${btn('add-region', 'Add region')}
      ${btn('gps', state.gps.on ? (currentFix() ? 'Centre on my location' : 'Stop GPS') : 'My location (GPS)')}
      ${btn('waypoint', 'Drop waypoint')}
      ${btn('measure', 'Measure line & profile')}
      ${btn('route', 'Plan walking route')}
      ${btn('waypoints', `Waypoints (${state.waypoints.length})`)}
      ${btn('regions', `Regions (${state.regions.size})`)}
      ${btn('layers', 'Map layers')}
      ${btn('settings', 'Settings')}
      ${btn('globe', 'Back to globe')}
      <div class="credits">
        <h3>Data credits</h3>
        ${CREDITS.map((c) => `<p>${esc(c.text)}</p>`).join('')}
        <p class="by">by @SamAndNinjaCat</p>
      </div>`;
  } else if (page === 'regions') {
    const items = [...state.regions.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => `
      <div class="item"><div><b>${r.id}</b> ${esc(r.name)}<br><small>${(r.size / 1048576).toFixed(1)} MB</small></div>
      <div class="item-btns">${btn('go-region', 'Go', `data-id="${r.id}"`)}${btn('rm-region', 'Remove', `data-id="${r.id}"`)}</div></div>`).join('');
    html = `<h2>Regions</h2>${items || '<p>No regions loaded yet. Download a region file (.topo) and add it here.</p>'}${btn('add-region', 'Add region')}${btn('main', '‹ Back')}`;
  } else if (page === 'waypoints') {
    const items = state.waypoints.map((w) => {
      const g = waypointGrid(w);
      return `<div class="item"><div><b>${esc(w.name)}</b> ${w.elev !== null ? `${w.elev} m` : ''}<br><small>${g.ref} · ${new Date(w.created).toLocaleString('en-AU')}</small></div>
      <div class="item-btns">${btn('go-wpt', 'Go', `data-id="${w.id}"`)}${btn('rename-wpt', 'Rename', `data-id="${w.id}"`)}${btn('rm-wpt', 'Delete', `data-id="${w.id}"`)}</div></div>`;
    }).join('');
    html = `<h2>Waypoints</h2>${items || '<p>No waypoints yet. Use “Drop waypoint” or tap the map.</p>'}${btn('main', '‹ Back')}`;
  } else if (page === 'layers') {
    const tg = (key: keyof Settings, label: string) => `<label class="toggle"><input type="checkbox" data-setting="${key}" ${s[key] ? 'checked' : ''}><span>${label}</span></label>`;
    html = `<h2>Map layers</h2>
      ${tg('terrain3d', '3D terrain')}
      <label class="toggle"><span>Terrain height ×</span><select data-setting="exaggeration">${[1, 1.3, 1.5, 2].map((v) => `<option value="${v}" ${s.exaggeration === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      ${tg('hillshade', 'Hillshade')}
      ${tg('slope', 'Steep ground colours')}
      <div class="legend">${SLOPE_CLASSES.map((c) => `<span><i style="background:rgba(${c.rgba[0]},${c.rgba[1]},${c.rgba[2]},${Math.min(1, c.rgba[3] / 160)})"></i>${c.label}</span>`).join('')}</div>
      ${tg('contours', 'Contours (10 m, index every 50 m)')}
      ${tg('roads', 'Roads, tracks & paths')}
      ${tg('water', 'Waterways')}
      ${btn('main', '‹ Back')}`;
  } else if (page === 'settings') {
    html = `<h2>Settings</h2>
      <label class="toggle"><span>MGA2020 zone</span><select data-setting="zone">
        <option value="auto" ${s.zone === 'auto' ? 'selected' : ''}>Automatic</option>
        <option value="54" ${s.zone === 54 ? 'selected' : ''}>Zone 54</option>
        <option value="55" ${s.zone === 55 ? 'selected' : ''}>Zone 55</option></select></label>
      <p class="note">Grid references use MGA2020 (GDA2020, Krüger series). GPS positions are converted from WGS84 to GDA2020 with the Australian plate motion model before showing grid references.</p>
      <p class="note">Render quality: ${governor ? governor.levels[governor.level].label : 'full quality'} (adjusts automatically).</p>
      ${btn('main', '‹ Back')}`;
  }
  menuEl.innerHTML = html;
}

function openMenu(page: MenuPage = 'main'): void {
  renderMenu(page);
  menuEl.classList.add('open');
  dotsEl.setAttribute('aria-expanded', 'true');
  menuOpen = true;
  menuEl.scrollTop = 0;
}
function closeMenu(): void {
  menuEl.classList.remove('open');
  dotsEl.setAttribute('aria-expanded', 'false');
  menuOpen = false;
  if (state.welcome) {
    state.welcome = false;
  }
}

dotsEl.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()));

menuEl.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
  if (!t) return;
  const id = t.dataset.id ?? '';
  switch (t.dataset.action) {
    case 'add-region': void addRegion(); break;
    case 'gps': void toggleGps(); break;
    case 'waypoint': void addWaypoint(); break;
    case 'measure': startMeasure(); break;
    case 'route': startRoute(); break;
    case 'waypoints': openMenu('waypoints'); break;
    case 'regions': openMenu('regions'); break;
    case 'layers': openMenu('layers'); break;
    case 'settings': openMenu('settings'); break;
    case 'globe': backToGlobe(); break;
    case 'main': openMenu('main'); break;
    case 'go-region': flyToRegion(id); break;
    case 'rm-region': void removeRegion(id); break;
    case 'go-wpt': {
      const w = state.waypoints.find((x) => x.id === id);
      if (w) { closeMenu(); map.flyTo({ center: [w.lon, w.lat], zoom: Math.max(14, map.getZoom()), duration: 2500 }); }
      break;
    }
    case 'rename-wpt': {
      const w = state.waypoints.find((x) => x.id === id);
      const name = w && prompt('Waypoint name', w.name);
      if (w && name && name.trim()) { w.name = name.trim().slice(0, 60); void saveWaypoints(); renderWaypoints(); openMenu('waypoints'); }
      break;
    }
    case 'rm-wpt': {
      const w = state.waypoints.find((x) => x.id === id);
      if (w && confirm(`Delete ${w.name}?`)) { state.waypoints = state.waypoints.filter((x) => x.id !== id); void saveWaypoints(); renderWaypoints(); openMenu('waypoints'); }
      break;
    }
  }
});

menuEl.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement | HTMLSelectElement;
  const key = t.dataset.setting as keyof Settings | undefined;
  if (!key) return;
  const s = state.settings as unknown as Record<string, unknown>;
  if (t instanceof HTMLInputElement && t.type === 'checkbox') s[key] = t.checked;
  else if (key === 'zone') s[key] = t.value === 'auto' ? 'auto' : Number(t.value);
  else if (key === 'exaggeration') s[key] = Number(t.value);
  void saveSettings();
  applyLayerSettings();
  updateTerrain();
});

// Android back button: close what is open, step back to the globe, then exit.
window.addEventListener('topoback', () => {
  if (state.welcome) { state.welcome = false; closeMenu(); renderMenu('main'); return; }
  if (menuOpen) { if (menuPage !== 'main') openMenu('main'); else closeMenu(); return; }
  if (state.mode !== 'browse') { endModes(); return; }
  if (!sheetEl.classList.contains('hidden')) { closeSheet(); return; }
  if (map && map.getZoom() > 4) { backToGlobe(); return; }
  void P.exitApp();
});

// First tap anywhere folds the welcome menu to the dots (and does nothing else).
let swallowClick = false;
document.addEventListener('pointerdown', (e) => {
  if (!state.welcome) return;
  state.welcome = false;
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 700);
  e.stopPropagation();
  e.preventDefault();
  closeMenu();
  renderMenu('main');
}, true);
for (const ev of ['click', 'mousedown', 'touchstart', 'touchend', 'mouseup', 'pointerup']) {
  document.addEventListener(ev, (e) => {
    if (!swallowClick) return;
    e.stopPropagation();
    e.preventDefault();
    if (ev === 'click' || ev === 'touchend') setTimeout(() => (swallowClick = false), 0);
  }, { capture: true, passive: false });
}

// ---------------------------------------------------------------- boot
async function boot(): Promise<void> {
  renderMenu('main');
  menuEl.classList.add('open');
  await Promise.all([loadSettings(), loadWaypoints()]);
  showStatus('Loading regions…');
  await restoreRegions();
  hideStatus();
  createMap();
  renderMenu('main');
  (window as unknown as { __map: unknown }).__map = map;
}

void boot();
