/**
 * Encode one region file (.topo) from the prepared inputs.
 *
 *   tsx pipeline/encode_region.ts --dem work/S38E145.f32 --vectors work/S38E145_vectors.json \
 *       --meta work/S38E145_meta.json --out dist/vic_S38E145.topo
 *
 * The DEM codec and vector codec are the same TypeScript modules the phone uses
 * to decode, so encoder and decoder cannot drift apart.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'fflate';
import { encodeDem, decodeDemBlock, blockCount, DEM_UNIT_M } from '../src/shared/demcodec';
import { encodeChunk, decodeChunk, type ChunkInput, type InLine, COORD_SCALE } from '../src/shared/vectorcodec';
import { writeRegion, readRegion, type ChunkRef } from '../src/shared/regionfile';
import { CREDITS } from '../src/shared/credits';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= process.argv.length) throw new Error(`missing --${name}`);
  return process.argv[i + 1];
}

interface Meta {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  rows: number;
  cols: number;
  north: number;
  west: number;
  dLat: number;
  dLon: number;
  sources: Record<string, string>;
}

const meta = JSON.parse(readFileSync(arg('meta'), 'utf8')) as Meta;
const demBuf = readFileSync(arg('dem'));
const dem = new Float32Array(demBuf.buffer, demBuf.byteOffset, meta.rows * meta.cols);
const vec = JSON.parse(readFileSync(arg('vectors'), 'utf8'));

// ---------------------------------------------------------------- DEM
let t = Date.now();
const res = encodeDem(dem, meta.rows, meta.cols, { northLat: meta.north, dLat: meta.dLat, dLon: meta.dLon, blockSize: 240 });
const blockOffsets: number[] = [0];
for (const b of res.blocks) blockOffsets.push(blockOffsets[blockOffsets.length - 1] + b.length);
const demBytes = new Uint8Array(blockOffsets[blockOffsets.length - 1]);
res.blocks.forEach((b, i) => demBytes.set(b, blockOffsets[i]));
let minE = Infinity, maxE = -Infinity;
for (let i = 0; i < dem.length; i++) { const v = dem[i]; if (v < minE) minE = v; if (v > maxE) maxE = v; }
console.error(`DEM: ${demBytes.length} bytes, max error ${res.maxErrorM.toFixed(3)} m, rms ${res.rmsErrorM.toFixed(3)} m, ${Date.now() - t} ms`);

// ---------------------------------------------------------------- vectors
const [W, S, E, N] = meta.bounds;
const CX = 8, CY = 8;
const ox = Math.round(W * COORD_SCALE), oy = Math.round(S * COORD_SCALE);
const cw = Math.round((E - W) * COORD_SCALE) / CX, ch = Math.round((N - S) * COORD_SCALE) / CY;
const chunks: ChunkInput[] = Array.from({ length: CX * CY }, () => ({ roads: [], water: [], areas: [], pois: [] }));
function chunkOf(x: number, y: number): number {
  const cx = Math.min(CX - 1, Math.max(0, Math.floor((x - ox) / cw)));
  const cy = Math.min(CY - 1, Math.max(0, Math.floor((y - oy) / ch)));
  return cy * CX + cx;
}
function centre(pts: number[][]): [number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
// global name table in order of first use (chunk by chunk) for good delta coding
const rawRoads = vec.roads as { c: number; f: number; n: string; s: number; p: number[][] }[];
const rawWater = vec.waterLines as { c: number; n: string; h: number; p: number[][] }[];
const rawAreas = vec.waterAreas as { c: number; n: string; r: number[][][] }[];
const rawPois = vec.pois as { t: number; lon: number; lat: number; name: string; ele: number | null }[];
const tmp: { roads: typeof rawRoads; water: typeof rawWater; areas: typeof rawAreas; pois: typeof rawPois }[] =
  Array.from({ length: CX * CY }, () => ({ roads: [], water: [], areas: [], pois: [] }));
for (const r of rawRoads) tmp[chunkOf(...centre(r.p))].roads.push(r);
for (const w of rawWater) tmp[chunkOf(...centre(w.p))].water.push(w);
for (const a of rawAreas) tmp[chunkOf(...centre(a.r[0]))].areas.push(a);
for (const p of rawPois) tmp[chunkOf(Math.round(p.lon * COORD_SCALE), Math.round(p.lat * COORD_SCALE))].pois.push(p);
const nameIndex = new Map<string, number>();
const names: string[] = [];
const nid = (s: string) => {
  if (!s) return -1;
  let i = nameIndex.get(s);
  if (i === undefined) { i = names.length; names.push(s); nameIndex.set(s, i); }
  return i;
};
const flat = (p: number[][]) => p.flat();
tmp.forEach((c, k) => {
  const ci = chunks[k];
  for (const r of c.roads) ci.roads.push({ a0: r.c, a1: r.f, a2: r.s, name: nid(r.n), pts: flat(r.p) } as InLine);
  for (const w of c.water) ci.water.push({ a0: w.c, a1: w.h, a2: 0, name: nid(w.n), pts: flat(w.p) } as InLine);
  for (const a of c.areas) ci.areas.push({ cls: a.c, name: nid(a.n), rings: a.r.map(flat) });
  for (const p of c.pois) ci.pois.push({ type: p.t, name: nid(p.name), ele: p.ele, x: Math.round(p.lon * COORD_SCALE), y: Math.round(p.lat * COORD_SCALE) });
});
t = Date.now();
const chunkBytes: Uint8Array[] = [];
const chunkRefs: ChunkRef[] = [];
let off = 0;
let totalPts = 0;
for (const c of chunks) {
  const b = encodeChunk(c);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (pts: number[]) => { for (let i = 0; i < pts.length; i += 2) { const x = pts[i], y = pts[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } totalPts += pts.length / 2; };
  c.roads.forEach((l) => grow(l.pts));
  c.water.forEach((l) => grow(l.pts));
  c.areas.forEach((a) => a.rings.forEach(grow));
  c.pois.forEach((p) => grow([p.x, p.y]));
  chunkRefs.push({ offset: off, length: b.length, ext: Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0], roads: c.roads.length, water: c.water.length, areas: c.areas.length, pois: c.pois.length });
  chunkBytes.push(b);
  off += b.length;
}
const vecBytes = new Uint8Array(off);
chunkBytes.forEach((b, i) => vecBytes.set(b, chunkRefs[i].offset));
const nameBytes = deflateSync(new TextEncoder().encode(names.join('\n')), { level: 9 });
console.error(`Vectors: ${vecBytes.length} bytes (${totalPts} points, ${(vecBytes.length * 8 / totalPts).toFixed(1)} bits/pt), names ${names.length} -> ${nameBytes.length} bytes, ${Date.now() - t} ms`);

// ---------------------------------------------------------------- container
const file = writeRegion({
  format: 1,
  id: meta.id,
  name: meta.name,
  bounds: meta.bounds,
  created: new Date().toISOString(),
  sources: meta.sources,
  credits: CREDITS.map((c) => c.text),
  dem: {
    north: meta.north, west: meta.west, dLat: meta.dLat, dLon: meta.dLon, unit: DEM_UNIT_M,
    minElev: Math.round(minE * 10) / 10, maxElev: Math.round(maxE * 10) / 10,
    params: res.params, blockOffsets, maxErrorM: res.maxErrorM,
  },
  vec: {
    scale: COORD_SCALE, chunksX: CX, chunksY: CY, chunks: chunkRefs, nameCount: names.length,
    counts: { roads: rawRoads.length, water: rawWater.length, areas: rawAreas.length, pois: rawPois.length, points: totalPts },
  },
}, demBytes, nameBytes, vecBytes);
writeFileSync(arg('out'), file);
console.error(`Wrote ${arg('out')}: ${file.length} bytes (${(file.length / 1048576).toFixed(2)} MiB)`);

// ---------------------------------------------------------------- self-check: decode everything back
const m = readRegion(file);
const nb = blockCount(m.dem.params.rows, m.dem.params.blockSize);
let maxDiff = 0;
for (let br = 0; br < nb; br++) for (let bc = 0; bc < nb; bc++) {
  const k = br * nb + bc;
  const b = decodeDemBlock(m.dem.params, br, bc, file, m.sections.dem.offset + m.dem.blockOffsets[k], m.sections.dem.offset + m.dem.blockOffsets[k + 1]);
  for (let r = 0; r < b.h; r += 7) for (let c = 0; c < b.w; c += 7) {
    const d = Math.abs(b.data[r * b.w + c] * DEM_UNIT_M - dem[(b.r0 + r) * meta.cols + b.c0 + c]);
    if (d > maxDiff) maxDiff = d;
  }
}
if (maxDiff > 1.0 + 1e-6) throw new Error(`DEM self-check failed: ${maxDiff}`);
let roads = 0, water = 0, areas = 0, pois = 0;
for (const c of m.vec.chunks) {
  const d = decodeChunk(file, m.sections.vec.offset + c.offset, m.sections.vec.offset + c.offset + c.length);
  if (d.roads.n !== c.roads || d.water.n !== c.water || d.areas.n !== c.areas || d.pois.n !== c.pois) throw new Error('vector self-check failed');
  roads += d.roads.n; water += d.water.n; areas += d.areas.n; pois += d.pois.n;
}
console.error(`Self-check OK: DEM max |err| ${maxDiff.toFixed(3)} m; ${roads} roads, ${water} waterways, ${areas} water areas, ${pois} POIs decoded`);
console.log(JSON.stringify({ file: arg('out'), bytes: file.length, dem: demBytes.length, vectors: vecBytes.length, names: nameBytes.length }));
