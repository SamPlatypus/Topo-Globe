/// <reference lib="webworker" />
/**
 * Tile & calculation worker.  Holds the loaded region files, generates map
 * tiles on demand (terrain DEM, slope shading, contours, roads/water/POIs) and
 * answers elevation, profile and routing queries.  Nothing here touches the
 * network: region bytes arrive from the app (transferred) or from a same-origin
 * local file URL served by the app shell.
 */
import { Region } from './region';
import { World, demTile, slopeTile, contourTile, vectorTile, slopeAt, TILE } from './tiles';
import { RoadGraph, type RoadInput } from '../shared/calc/routing';
import { profileStats } from '../shared/calc/profile';
import { sampleGeodesic, inverse } from '../shared/geo/geodesic';

declare const self: DedicatedWorkerGlobalScope;

const world = new World();
let graph: RoadGraph | null = null;
let graphKey = '';
const cancelled = new Set<number>();

type Msg =
  | { id: number; type: 'load'; key: string; bytes?: ArrayBuffer; url?: string; verify: boolean }
  | { id: number; type: 'unload'; key: string }
  | { id: number; type: 'tile'; kind: 'dem' | 'slope' | 'contour' | 'vec'; z: number; x: number; y: number }
  | { id: number; type: 'cancel'; target: number }
  | { id: number; type: 'point'; lon: number; lat: number }
  | { id: number; type: 'profile'; coords: [number, number][] }
  | { id: number; type: 'route'; from: [number, number]; to: [number, number] }
  | { id: number; type: 'stats' };

function reply(id: number, result: unknown, transfer: Transferable[] = []) {
  self.postMessage({ id, ok: true, result }, transfer);
}
function fail(id: number, error: unknown) {
  self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
}

const queue: Msg[] = [];
let busy = false;

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  if (m.type === 'cancel') {
    cancelled.add(m.target);
    return;
  }
  queue.push(m);
  pump();
};

function pump() {
  if (busy) return;
  busy = true;
  setTimeout(run, 0);
}

async function run() {
  // tiles first (keep the map responsive), newest requests first
  let idx = -1;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].type !== 'tile') { idx = i; break; }
  if (idx < 0 && queue.length) idx = queue.length - 1;
  const m = idx >= 0 ? queue.splice(idx, 1)[0] : undefined;
  if (m) {
    try {
      await handle(m);
    } catch (e) {
      fail(m.id, e);
    }
  } else {
    // idle: build overviews in the background, one block at a time
    for (const r of world.regions) {
      if (r.overviewStep()) {
        busy = false;
        setTimeout(pump, 0);
        return;
      }
    }
  }
  busy = false;
  if (queue.length || world.regions.some((r) => !r.overviewsReady)) pump();
}

async function handle(m: Msg) {
  switch (m.type) {
    case 'load': {
      let bytes: ArrayBuffer;
      if (m.bytes) bytes = m.bytes;
      else {
        const res = await fetch(m.url!);
        if (!res.ok) throw new Error(`could not read the stored region (${res.status})`);
        bytes = await res.arrayBuffer();
      }
      const reg = new Region(m.key, new Uint8Array(bytes), m.verify);
      const old = world.regions.findIndex((r) => r.key === m.key);
      if (old >= 0) {
        world.regions[old].dispose();
        world.regions.splice(old, 1);
      }
      world.regions.push(reg);
      world.regions.sort((a, b) => (a.key < b.key ? -1 : 1));
      graph = null;
      const { sections: _s, ...meta } = reg.meta;
      reply(m.id, { meta: { ...meta, dem: { ...meta.dem, params: undefined, blockOffsets: undefined }, vec: { ...meta.vec, chunks: undefined } }, size: bytes.byteLength });
      return;
    }
    case 'unload': {
      const i = world.regions.findIndex((r) => r.key === m.key);
      if (i >= 0) {
        world.regions[i].dispose();
        world.regions.splice(i, 1);
      }
      graph = null;
      reply(m.id, true);
      return;
    }
    case 'tile': {
      if (cancelled.delete(m.id)) {
        reply(m.id, null);
        return;
      }
      if (m.kind === 'dem' || m.kind === 'slope') {
        const px = m.kind === 'dem' ? demTile(world, m.z, m.x, m.y) : slopeTile(world, m.z, m.x, m.y);
        const bmp = await createImageBitmap(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, TILE, TILE), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        reply(m.id, bmp, [bmp]);
      } else {
        const buf = m.kind === 'contour' ? contourTile(world, m.z, m.x, m.y) : vectorTile(world, m.z, m.x, m.y);
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        reply(m.id, ab, [ab]);
      }
      return;
    }
    case 'point': {
      const elev = world.elevation(m.lon, m.lat);
      const { slope, aspect } = slopeAt(world, m.lon, m.lat);
      reply(m.id, { elev, slope, aspect, region: world.regionAt(m.lon, m.lat)?.key ?? null });
      return;
    }
    case 'profile': {
      reply(m.id, profileOf(m.coords));
      return;
    }
    case 'route': {
      const key = world.regions.map((r) => r.key).join(',');
      if (!graph || graphKey !== key) {
        const inputs: RoadInput[] = [];
        for (const r of world.regions) {
          const names = r.nameTable();
          for (let i = 0; i < r.meta.vec.chunks.length; i++) {
            const c = r.chunk(i).roads;
            if (!c.n) continue;
            inputs.push({ coords: c.coords, offsets: c.offsets, cls: c.a0, flags: c.a1, name: c.name, names, n: c.n });
          }
        }
        const scale = world.regions[0]?.meta.vec.scale ?? 50000;
        graph = new RoadGraph(inputs, scale, (lon, lat) => world.elevation(lon, lat));
        graphKey = key;
      }
      const r = graph.route(m.from[0], m.from[1], m.to[0], m.to[1]);
      if ('error' in r) {
        reply(m.id, r);
        return;
      }
      const prof = profileOfPolyline(r.coords);
      reply(m.id, { ...r, profile: prof });
      return;
    }
    case 'stats': {
      reply(m.id, { regions: world.regions.map((r) => ({ key: r.key, overviews: r.overviewsReady })), graph: graph ? { nodes: graph.nodes, edges: graph.edges } : null });
      return;
    }
  }
}

/** Profile along a measured line: each leg is a geodesic, sampled every <= 15 m. */
function profileOf(coords: [number, number][]) {
  const lon: number[] = [], lat: number[] = [], dist: number[] = [];
  let base = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lo1, la1] = coords[i - 1];
    const [lo2, la2] = coords[i];
    const pts = sampleGeodesic(la1, lo1, la2, lo2, 15);
    for (let k = i === 1 ? 0 : 1; k < pts.length; k++) {
      lon.push(pts[k][0]); lat.push(pts[k][1]); dist.push(base + pts[k][2]);
    }
    base += pts[pts.length - 1][2];
  }
  return finishProfile(lon, lat, dist);
}

/** Profile along a dense polyline (route), sampling every <= 15 m along straight sub-segments. */
function profileOfPolyline(coords: [number, number][]) {
  const lon: number[] = [], lat: number[] = [], dist: number[] = [];
  let base = 0;
  if (coords.length) { lon.push(coords[0][0]); lat.push(coords[0][1]); dist.push(0); }
  for (let i = 1; i < coords.length; i++) {
    const [lo1, la1] = coords[i - 1];
    const [lo2, la2] = coords[i];
    const d = inverse(la1, lo1, la2, lo2).s12;
    const n = Math.max(1, Math.ceil(d / 15));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      lon.push(lo1 + (lo2 - lo1) * f); lat.push(la1 + (la2 - la1) * f); dist.push(base + d * f);
    }
    base += d;
  }
  return finishProfile(lon, lat, dist);
}

function finishProfile(lon: number[], lat: number[], dist: number[]) {
  const n = dist.length;
  const elev = new Float64Array(n);
  for (let i = 0; i < n; i++) elev[i] = world.elevation(lon[i], lat[i]);
  const d = Float64Array.from(dist);
  const stats = profileStats(d, elev);
  return { dist: d, elev, lon: Float64Array.from(lon), lat: Float64Array.from(lat), stats };
}
