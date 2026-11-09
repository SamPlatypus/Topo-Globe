/**
 * Platform layer: the Android app uses a small native Capacitor plugin
 * (TopoNative: file picker import, durable atomic file writes, raw GNSS
 * location).  In a desktop browser (development and automated tests) the
 * same interface is backed by an <input type=file>, IndexedDB, localStorage
 * and navigator.geolocation.  No code path makes network requests.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface GpsFix {
  lat: number;
  lon: number;
  accuracy: number; // metres (68 %)
  altitude: number | null;
  time: number; // ms since epoch (GNSS fix time - accurate UTC even when the phone clock is not)
  provider: string;
  /** phone clock (Date.now) when the fix arrived - used for freshness, since the phone's clock may drift without network time */
  received?: number;
}
export interface GnssStatus {
  inView: number;
  used: number;
}

interface TopoNativePlugin {
  pickRegionFile(): Promise<{ cancelled: boolean; path?: string; name?: string; size?: number }>;
  finalizeRegion(o: { tmpPath: string; id: string }): Promise<{ path: string }>;
  deleteFile(o: { path: string }): Promise<void>;
  listRegions(): Promise<{ files: { id: string; path: string; size: number }[] }>;
  writeText(o: { name: string; text: string }): Promise<void>;
  readText(o: { name: string }): Promise<{ text: string | null }>;
  startGps(): Promise<{ ok: boolean; reason?: string }>;
  stopGps(): Promise<void>;
  getLastKnown(): Promise<{ lat?: number; lon?: number; accuracy?: number; time?: number }>;
  keepAwake(o: { on: boolean }): Promise<void>;
  exitApp(): Promise<void>;
  viewportInfo(): Promise<{ left: number; top: number; width: number; height: number; density: number }>;
  addListener(event: 'location', fn: (f: GpsFix) => void): Promise<PluginListenerHandle>;
  addListener(event: 'gnss', fn: (s: GnssStatus) => void): Promise<PluginListenerHandle>;
  addListener(event: 'gpsError', fn: (e: { reason: string }) => void): Promise<PluginListenerHandle>;
}

export const isNative = Capacitor.isNativePlatform();
const Native = isNative ? registerPlugin<TopoNativePlugin>('TopoNative') : null;
// hook for the automated done-check (real taps need the WebView's position on screen)
(globalThis as unknown as { __topoNative?: unknown }).__topoNative = Native;

// ---------------------------------------------------------------- tiny IndexedDB key-value store (web)
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('topo-globe', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('regions');
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbOp<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await idb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------- region files
export interface PickedRegion {
  name: string;
  size: number;
  /** native: temporary file path to finalise; web: bytes */
  tmpPath?: string;
  bytes?: ArrayBuffer;
}
export interface StoredRegion {
  id: string;
  size: number;
  /** a same-origin URL the workers can fetch (native) */
  url?: string;
  path?: string;
}

export function fileUrl(path: string): string {
  return Capacitor.convertFileSrc(path.startsWith('file://') ? path : 'file://' + path);
}

/** Open the phone's file picker for a .topo region file. */
export async function pickRegionFile(): Promise<PickedRegion | null> {
  if (Native) {
    const r = await Native.pickRegionFile();
    if (r.cancelled || !r.path) return null;
    return { name: r.name ?? 'region.topo', size: r.size ?? 0, tmpPath: r.path };
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.topo,application/octet-stream';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      resolve({ name: f.name, size: f.size, bytes: await f.arrayBuffer() });
    });
    input.addEventListener('cancel', () => { input.remove(); resolve(null); });
    document.body.appendChild(input);
    input.click();
  });
}

export async function storeRegion(id: string, picked: PickedRegion): Promise<StoredRegion> {
  if (Native && picked.tmpPath) {
    const r = await Native.finalizeRegion({ tmpPath: picked.tmpPath, id });
    return { id, size: picked.size, path: r.path, url: fileUrl(r.path) };
  }
  await idbOp('regions', 'readwrite', (s) => s.put(picked.bytes, id));
  return { id, size: picked.size };
}

export async function discardPicked(picked: PickedRegion): Promise<void> {
  if (Native && picked.tmpPath) await Native.deleteFile({ path: picked.tmpPath }).catch(() => undefined);
}

export async function listStoredRegions(): Promise<StoredRegion[]> {
  if (Native) {
    const r = await Native.listRegions();
    return r.files.map((f) => ({ id: f.id, size: f.size, path: f.path, url: fileUrl(f.path) }));
  }
  const keys = await idbOp<IDBValidKey[]>('regions', 'readonly', (s) => s.getAllKeys());
  return keys.map((k) => ({ id: String(k), size: 0 }));
}

export async function readStoredRegion(r: StoredRegion): Promise<ArrayBuffer | null> {
  if (r.url) return null; // workers fetch the local file URL themselves
  return (await idbOp<ArrayBuffer | undefined>('regions', 'readonly', (s) => s.get(r.id))) ?? null;
}

export async function deleteStoredRegion(r: StoredRegion): Promise<void> {
  if (Native && r.path) await Native.deleteFile({ path: r.path });
  else await idbOp('regions', 'readwrite', (s) => s.delete(r.id));
}

// ---------------------------------------------------------------- durable small files (waypoints, settings)
export async function writeText(name: string, text: string): Promise<void> {
  try { localStorage.setItem('tg:' + name, text); } catch { /* storage may be unavailable */ }
  if (Native) await Native.writeText({ name, text });
  else await idbOp('kv', 'readwrite', (s) => s.put(text, name));
}

export async function readText(name: string): Promise<string | null> {
  if (Native) {
    const r = await Native.readText({ name });
    if (r.text !== null && r.text !== undefined) return r.text;
  } else {
    try {
      const v = await idbOp<string | undefined>('kv', 'readonly', (s) => s.get(name));
      if (v !== undefined) return v;
    } catch { /* fall through */ }
  }
  try { return localStorage.getItem('tg:' + name); } catch { return null; }
}

// ---------------------------------------------------------------- GPS
export interface GpsHandlers {
  onFix: (f: GpsFix) => void;
  onGnss: (s: GnssStatus) => void;
  onError: (reason: string) => void;
}

let nativeSubs: PluginListenerHandle[] = [];
let webWatch: number | null = null;

export async function startGps(h: GpsHandlers): Promise<void> {
  if (Native) {
    nativeSubs.push(await Native.addListener('location', h.onFix));
    nativeSubs.push(await Native.addListener('gnss', h.onGnss));
    nativeSubs.push(await Native.addListener('gpsError', (e) => h.onError(e.reason)));
    const r = await Native.startGps();
    if (!r.ok) h.onError(r.reason ?? 'GPS unavailable');
    const last = await Native.getLastKnown().catch(() => ({} as { lat?: number }));
    void last;
    return;
  }
  if (!('geolocation' in navigator)) {
    h.onError('This device has no location service.');
    return;
  }
  // No timeout: without phone signal the first fix can take minutes (no assistance data).
  webWatch = navigator.geolocation.watchPosition(
    (p) => h.onFix({
      lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy,
      altitude: p.coords.altitude, time: p.timestamp, provider: 'browser',
    }),
    (e) => h.onError(e.code === e.PERMISSION_DENIED ? 'Location permission was refused.' : e.message || 'Location error'),
    { enableHighAccuracy: true, maximumAge: 0 },
  );
}

export async function lastKnownFix(): Promise<GpsFix | null> {
  if (!Native) return null;
  const r = await Native.getLastKnown().catch(() => null);
  if (!r || r.lat === undefined || r.lon === undefined) return null;
  return { lat: r.lat, lon: r.lon, accuracy: r.accuracy ?? 9999, altitude: null, time: r.time ?? 0, provider: 'last-known' };
}

export async function stopGps(): Promise<void> {
  if (Native) {
    await Native.stopGps();
    for (const s of nativeSubs) await s.remove();
    nativeSubs = [];
  }
  if (webWatch !== null) {
    navigator.geolocation.clearWatch(webWatch);
    webWatch = null;
  }
}

export async function keepAwake(on: boolean): Promise<void> {
  if (Native) await Native.keepAwake({ on }).catch(() => undefined);
}

export async function exitApp(): Promise<void> {
  if (Native) await Native.exitApp();
}
