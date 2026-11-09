/**
 * TGV1 vector chunk codec.
 *
 * A region's vector data (OSM roads/tracks/paths, Vicmap waterways and water
 * areas, walker POIs) is split into 8 x 8 spatial chunks that decode
 * independently.  Coordinates are integers on a 2e-5 degree grid (rounding <= 1.1 m).  Lines are
 * delta coded with a half-step prediction and adaptive Exp-Golomb contexts on
 * the binary range coder.  Road topology is implicit: two road vertices with
 * identical coordinates are the same junction (the region builder guarantees
 * distinct OSM nodes never share a grid position).
 */
import { RangeDecoder, RangeEncoder } from './rangecoder';
import { SINT_CTX, UINT_CTX, decS, decSym, decU, encS, encSym, encU, newProbs } from './intcoder';

export const COORD_SCALE = 50000; // units per degree (2e-5 deg ~ 2 m grid; rounding <= 1.1 m)

// Road classes (match pipeline/prepare_vectors.py)
export const RC = {
  MOTORWAY: 0, TRUNK: 1, PRIMARY: 2, SECONDARY: 3, TERTIARY: 4, MINOR: 5, SERVICE: 6,
  TRACK: 7, PATH: 8, FOOTWAY: 9, CYCLEWAY: 10, BRIDLEWAY: 11, STEPS: 12,
} as const;
export const RF = { BRIDGE: 1, TUNNEL: 2, NOFOOT: 4, UNPAVED: 8, PRIVATE: 16, FORD: 32 } as const;
// Water line classes
export const WC = { RIVER: 0, STREAM: 1, CHANNEL: 2, CONNECTOR: 3 } as const;
// Water area classes
export const AC = { LAKE: 0, PONDAGE: 1, RIVER: 2, WETLAND: 3 } as const;
// POI types
export const PT = {
  PEAK: 1, SADDLE: 2, CAVE: 3, HUT: 4, SHELTER: 5, CAMP: 6, WATER: 7, VIEWPOINT: 8, TOILETS: 9,
  WATERFALL: 10, RAPID: 11, SPRING: 12,
} as const;

export interface InLine { a0: number; a1: number; a2: number; name: number; pts: number[] }
export interface InArea { cls: number; name: number; rings: number[][] }
export interface InPoi { type: number; name: number; ele: number | null; x: number; y: number }
export interface ChunkInput { roads: InLine[]; water: InLine[]; areas: InArea[]; pois: InPoi[] }

export interface LineSet {
  n: number;
  coords: Int32Array; // x,y interleaved
  offsets: Uint32Array; // n+1, in points
  a0: Uint8Array; // road: class | water: class
  a1: Uint8Array; // road: flags | water: hierarchy
  a2: Uint8Array; // road: sac scale
  name: Int32Array; // global name index or -1
  bbox: Int32Array; // 4 per feature
}
export interface AreaSet {
  n: number;
  coords: Int32Array;
  ringOffsets: Uint32Array; // rings+1, in points
  featRings: Uint32Array; // n+1, in rings
  cls: Uint8Array;
  name: Int32Array;
  bbox: Int32Array;
}
export interface PoiSet { n: number; x: Int32Array; y: Int32Array; type: Uint8Array; name: Int32Array; ele: Float32Array }
export interface DecodedChunk { roads: LineSet; water: LineSet; areas: AreaSet; pois: PoiSet }

// ---- context layout -------------------------------------------------------
const N_MAG = 10;
const C_CONT = 0; // 2 (roads, water)
const C_JUMP = 2; // 2 sets * 2 axes * SINT
const C_NPTS = C_JUMP + 4 * SINT_CTX; // 3 sets * UINT
const C_CRD = C_NPTS + 3 * UINT_CTX; // 3 sets * 2 axes * N_MAG * SINT
const C_NAME = C_CRD + 3 * 2 * N_MAG * SINT_CTX; // 4 sets * (UINT + SINT)
const C_RCLS = C_NAME + 4 * (UINT_CTX + SINT_CTX); // 16 prev * 16
const C_RFLG = C_RCLS + 16 * 16; // 16 cls * 8 bits
const C_SAC = C_RFLG + 16 * 8; // UINT
const C_WCLS = C_SAC + UINT_CTX; // 4 prev * 4
const C_WHIER = C_WCLS + 16; // 4 cls * 4
const C_ACLS = C_WHIER + 16; // 4
const C_RINGS = C_ACLS + 4; // UINT
const C_POIT = C_RINGS + UINT_CTX; // 16
const C_ELE = C_POIT + 16; // UINT
const C_POIXY = C_ELE + UINT_CTX; // 2 * SINT
const C_COUNT = C_POIXY + 2 * SINT_CTX; // 4 sections * UINT
const N_VCTX = C_COUNT + 4 * UINT_CTX;

const MAG_EDGES = [1, 2, 4, 7, 12, 20, 35, 60, 110];
function magClass(m: number): number {
  let b = 0;
  while (b < MAG_EDGES.length && m >= MAG_EDGES[b]) b++;
  return b;
}

class NameMtf {
  private list: number[] = [];
  private lastNew = 0;
  constructor(private readonly base: number) {}
  enc(enc: RangeEncoder, probs: Uint16Array, name: number): void {
    if (name < 0) {
      encU(enc, probs, this.base, 0);
      return;
    }
    const p = this.list.indexOf(name);
    if (p >= 0) {
      encU(enc, probs, this.base, p + 1);
      this.list.splice(p, 1);
    } else {
      encU(enc, probs, this.base, this.list.length + 1);
      encS(enc, probs, this.base + UINT_CTX, name - this.lastNew);
      this.lastNew = name;
    }
    this.list.unshift(name);
  }
  dec(dec: RangeDecoder, probs: Uint16Array): number {
    const s = decU(dec, probs, this.base);
    if (s === 0) return -1;
    let name: number;
    if (s <= this.list.length) {
      name = this.list[s - 1];
      this.list.splice(s - 1, 1);
    } else {
      name = this.lastNew + decS(dec, probs, this.base + UINT_CTX);
      this.lastNew = name;
    }
    this.list.unshift(name);
    return name;
  }
}

class CoordCoder {
  lastX = 0;
  lastY = 0;
  private px = 0;
  private py = 0;
  constructor(private readonly set: number) {}
  begin(): void {
    this.px = 0;
    this.py = 0;
  }
  private ctx(axis: number): number {
    const m = magClass(Math.abs(this.px) + Math.abs(this.py));
    return C_CRD + ((this.set * 2 + axis) * N_MAG + m) * SINT_CTX;
  }
  enc(enc: RangeEncoder, probs: Uint16Array, x: number, y: number): void {
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    const cx = this.ctx(0);
    const cy = this.ctx(1);
    encS(enc, probs, cx, dx - Math.trunc(this.px / 2));
    encS(enc, probs, cy, dy - Math.trunc(this.py / 2));
    this.px = dx;
    this.py = dy;
    this.lastX = x;
    this.lastY = y;
  }
  dec(dec: RangeDecoder, probs: Uint16Array): void {
    const cx = this.ctx(0);
    const cy = this.ctx(1);
    const dx = decS(dec, probs, cx) + Math.trunc(this.px / 2);
    const dy = decS(dec, probs, cy) + Math.trunc(this.py / 2);
    this.px = dx;
    this.py = dy;
    this.lastX += dx;
    this.lastY += dy;
  }
}

/** Reorder (and reverse) lines so each starts where the previous ended when possible. */
export function continuityOrder(lines: InLine[]): InLine[] {
  const n = lines.length;
  if (n < 2) return lines.slice();
  const key = (x: number, y: number) => `${x},${y}`;
  const ends = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const k0 = key(l.pts[0], l.pts[1]);
    const k1 = key(l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]);
    (ends.get(k0) ?? ends.set(k0, []).get(k0)!).push(i);
    if (k1 !== k0) (ends.get(k1) ?? ends.set(k1, []).get(k1)!).push(i);
  });
  const morton = (x: number, y: number) => Math.floor(y / 500) * 1e6 + Math.floor(x / 500);
  const seeds = lines.map((l, i) => i).sort((a, b) => morton(lines[a].pts[0], lines[a].pts[1]) - morton(lines[b].pts[0], lines[b].pts[1]));
  const used = new Uint8Array(n);
  const out: InLine[] = [];
  for (const s of seeds) {
    if (used[s]) continue;
    used[s] = 1;
    let cur = lines[s];
    out.push(cur);
    for (;;) {
      const ex = cur.pts[cur.pts.length - 2];
      const ey = cur.pts[cur.pts.length - 1];
      const cand = ends.get(key(ex, ey));
      let next = -1;
      if (cand) for (const j of cand) if (!used[j]) { next = j; break; }
      if (next < 0) break;
      used[next] = 1;
      const l = lines[next];
      if (l.pts[0] === ex && l.pts[1] === ey) cur = l;
      else {
        const rev: number[] = [];
        for (let k = l.pts.length - 2; k >= 0; k -= 2) rev.push(l.pts[k], l.pts[k + 1]);
        cur = { ...l, pts: rev };
      }
      out.push(cur);
    }
  }
  return out;
}

function encLines(enc: RangeEncoder, probs: Uint16Array, lines: InLine[], kind: 0 | 1, names: NameMtf): void {
  encU(enc, probs, C_COUNT + kind * UINT_CTX, lines.length);
  const cc = new CoordCoder(kind);
  let prevCls = 0;
  for (const l of lines) {
    // attributes
    if (kind === 0) {
      encSym(enc, probs, C_RCLS + prevCls * 16, 4, l.a0);
      for (let b = 0; b < 6; b++) enc.encodeBit(probs, C_RFLG + l.a0 * 8 + b, (l.a1 >> b) & 1);
      if (l.a0 >= 7) encU(enc, probs, C_SAC, l.a2);
    } else {
      encSym(enc, probs, C_WCLS + prevCls * 4, 2, l.a0);
      encSym(enc, probs, C_WHIER + l.a0 * 4, 2, l.a1);
    }
    prevCls = l.a0;
    names.enc(enc, probs, l.name);
    const np = l.pts.length / 2;
    encU(enc, probs, C_NPTS + kind * UINT_CTX, np - 2);
    // first point: continuation flag or jump
    const x0 = l.pts[0];
    const y0 = l.pts[1];
    if (x0 === cc.lastX && y0 === cc.lastY) enc.encodeBit(probs, C_CONT + kind, 0);
    else {
      enc.encodeBit(probs, C_CONT + kind, 1);
      encS(enc, probs, C_JUMP + (kind * 2 + 0) * SINT_CTX, x0 - cc.lastX);
      encS(enc, probs, C_JUMP + (kind * 2 + 1) * SINT_CTX, y0 - cc.lastY);
      cc.lastX = x0;
      cc.lastY = y0;
    }
    cc.begin();
    for (let k = 1; k < np; k++) cc.enc(enc, probs, l.pts[2 * k], l.pts[2 * k + 1]);
  }
}

function decLines(dec: RangeDecoder, probs: Uint16Array, kind: 0 | 1, names: NameMtf): LineSet {
  const n = decU(dec, probs, C_COUNT + kind * UINT_CTX);
  const a0 = new Uint8Array(n);
  const a1 = new Uint8Array(n);
  const a2 = new Uint8Array(n);
  const name = new Int32Array(n);
  const offsets = new Uint32Array(n + 1);
  const bbox = new Int32Array(n * 4);
  let coords = new Int32Array(Math.max(16, n * 8));
  let np = 0;
  const cc = new CoordCoder(kind);
  let prevCls = 0;
  for (let i = 0; i < n; i++) {
    if (kind === 0) {
      a0[i] = decSym(dec, probs, C_RCLS + prevCls * 16, 4);
      let f = 0;
      for (let b = 0; b < 6; b++) f |= dec.decodeBit(probs, C_RFLG + a0[i] * 8 + b) << b;
      a1[i] = f;
      if (a0[i] >= 7) a2[i] = decU(dec, probs, C_SAC);
    } else {
      a0[i] = decSym(dec, probs, C_WCLS + prevCls * 4, 2);
      a1[i] = decSym(dec, probs, C_WHIER + a0[i] * 4, 2);
    }
    prevCls = a0[i];
    name[i] = names.dec(dec, probs);
    const cnt = decU(dec, probs, C_NPTS + kind * UINT_CTX) + 2;
    if ((np + cnt) * 2 > coords.length) {
      const nc = new Int32Array(Math.max(coords.length * 2, (np + cnt) * 2));
      nc.set(coords);
      coords = nc;
    }
    if (dec.decodeBit(probs, C_CONT + kind) === 1) {
      cc.lastX += decS(dec, probs, C_JUMP + (kind * 2 + 0) * SINT_CTX);
      cc.lastY += decS(dec, probs, C_JUMP + (kind * 2 + 1) * SINT_CTX);
    }
    offsets[i] = np;
    let minx = cc.lastX, maxx = cc.lastX, miny = cc.lastY, maxy = cc.lastY;
    coords[np * 2] = cc.lastX;
    coords[np * 2 + 1] = cc.lastY;
    np++;
    cc.begin();
    for (let k = 1; k < cnt; k++) {
      cc.dec(dec, probs);
      const x = cc.lastX;
      const y = cc.lastY;
      coords[np * 2] = x;
      coords[np * 2 + 1] = y;
      np++;
      if (x < minx) minx = x; else if (x > maxx) maxx = x;
      if (y < miny) miny = y; else if (y > maxy) maxy = y;
    }
    bbox[i * 4] = minx; bbox[i * 4 + 1] = miny; bbox[i * 4 + 2] = maxx; bbox[i * 4 + 3] = maxy;
  }
  offsets[n] = np;
  return { n, coords: coords.slice(0, np * 2), offsets, a0, a1, a2, name, bbox };
}

export function encodeChunk(input: ChunkInput): Uint8Array {
  const enc = new RangeEncoder(1 << 16);
  const probs = newProbs(N_VCTX);
  encLines(enc, probs, continuityOrder(input.roads), 0, new NameMtf(C_NAME + 0 * (UINT_CTX + SINT_CTX)));
  encLines(enc, probs, continuityOrder(input.water), 1, new NameMtf(C_NAME + 1 * (UINT_CTX + SINT_CTX)));
  // areas
  const an = new NameMtf(C_NAME + 2 * (UINT_CTX + SINT_CTX));
  encU(enc, probs, C_COUNT + 2 * UINT_CTX, input.areas.length);
  const ac = new CoordCoder(2);
  for (const a of input.areas) {
    encSym(enc, probs, C_ACLS, 2, a.cls);
    an.enc(enc, probs, a.name);
    encU(enc, probs, C_RINGS, a.rings.length - 1);
    for (const ring of a.rings) {
      const np = ring.length / 2;
      encU(enc, probs, C_NPTS + 2 * UINT_CTX, np - 3);
      encS(enc, probs, C_JUMP + 0 * SINT_CTX, ring[0] - ac.lastX);
      encS(enc, probs, C_JUMP + 1 * SINT_CTX, ring[1] - ac.lastY);
      ac.lastX = ring[0];
      ac.lastY = ring[1];
      ac.begin();
      for (let k = 1; k < np; k++) ac.enc(enc, probs, ring[2 * k], ring[2 * k + 1]);
    }
  }
  // pois
  const pn = new NameMtf(C_NAME + 3 * (UINT_CTX + SINT_CTX));
  encU(enc, probs, C_COUNT + 3 * UINT_CTX, input.pois.length);
  let lx = 0, ly = 0;
  const pois = input.pois.slice().sort((p, q) => (p.y - q.y) || (p.x - q.x));
  for (const p of pois) {
    encSym(enc, probs, C_POIT, 4, p.type);
    pn.enc(enc, probs, p.name);
    const e = p.ele === null || !Number.isFinite(p.ele) || p.ele < 0 ? 0 : Math.round(p.ele) + 1;
    encU(enc, probs, C_ELE, e);
    encS(enc, probs, C_POIXY, p.x - lx);
    encS(enc, probs, C_POIXY + SINT_CTX, p.y - ly);
    lx = p.x;
    ly = p.y;
  }
  return enc.finish();
}

export function decodeChunk(buf: Uint8Array, start = 0, end = buf.length): DecodedChunk {
  const dec = new RangeDecoder(buf, start, end);
  const probs = newProbs(N_VCTX);
  const roads = decLines(dec, probs, 0, new NameMtf(C_NAME + 0 * (UINT_CTX + SINT_CTX)));
  const water = decLines(dec, probs, 1, new NameMtf(C_NAME + 1 * (UINT_CTX + SINT_CTX)));
  const an = new NameMtf(C_NAME + 2 * (UINT_CTX + SINT_CTX));
  const na = decU(dec, probs, C_COUNT + 2 * UINT_CTX);
  const cls = new Uint8Array(na);
  const aname = new Int32Array(na);
  const featRings = new Uint32Array(na + 1);
  const ringOff: number[] = [];
  const pts: number[] = [];
  const abbox = new Int32Array(na * 4);
  const ac = new CoordCoder(2);
  let nr = 0;
  for (let i = 0; i < na; i++) {
    cls[i] = decSym(dec, probs, C_ACLS, 2);
    aname[i] = an.dec(dec, probs);
    const rings = decU(dec, probs, C_RINGS) + 1;
    featRings[i] = nr;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let r = 0; r < rings; r++) {
      const np = decU(dec, probs, C_NPTS + 2 * UINT_CTX) + 3;
      ac.lastX += decS(dec, probs, C_JUMP + 0 * SINT_CTX);
      ac.lastY += decS(dec, probs, C_JUMP + 1 * SINT_CTX);
      ringOff.push(pts.length / 2);
      pts.push(ac.lastX, ac.lastY);
      ac.begin();
      for (let k = 1; k < np; k++) {
        ac.dec(dec, probs);
        pts.push(ac.lastX, ac.lastY);
      }
      for (let k = ringOff[ringOff.length - 1]; k < pts.length / 2; k++) {
        const x = pts[2 * k], y = pts[2 * k + 1];
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
      nr++;
    }
    abbox[i * 4] = minx; abbox[i * 4 + 1] = miny; abbox[i * 4 + 2] = maxx; abbox[i * 4 + 3] = maxy;
  }
  featRings[na] = nr;
  ringOff.push(pts.length / 2);
  const areas: AreaSet = {
    n: na, coords: Int32Array.from(pts), ringOffsets: Uint32Array.from(ringOff), featRings, cls, name: aname, bbox: abbox,
  };
  const pn = new NameMtf(C_NAME + 3 * (UINT_CTX + SINT_CTX));
  const npo = decU(dec, probs, C_COUNT + 3 * UINT_CTX);
  const pois: PoiSet = {
    n: npo, x: new Int32Array(npo), y: new Int32Array(npo), type: new Uint8Array(npo), name: new Int32Array(npo), ele: new Float32Array(npo),
  };
  let lx = 0, ly = 0;
  for (let i = 0; i < npo; i++) {
    pois.type[i] = decSym(dec, probs, C_POIT, 4);
    pois.name[i] = pn.dec(dec, probs);
    const e = decU(dec, probs, C_ELE);
    pois.ele[i] = e === 0 ? NaN : e - 1;
    lx += decS(dec, probs, C_POIXY);
    ly += decS(dec, probs, C_POIXY + SINT_CTX);
    pois.x[i] = lx;
    pois.y[i] = ly;
  }
  return { roads, water, areas, pois };
}
