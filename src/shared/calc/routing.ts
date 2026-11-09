/**
 * Walking routes: A* over the mapped road/track/path network.
 *
 * Graph: road chains from all loaded regions; a vertex is a graph node when it
 * is a chain end or shared by more than one chain (exact grid-coordinate
 * equality, which also joins neighbouring regions).  Edge cost is walking time
 * from Tobler's hiking function, using elevations sampled from the 30 m DEM
 * (bilinear) at <= 30 m spacing along the edge, so climbs inside long edges
 * count.  Costs are asymmetric (uphill != downhill) and computed lazily.
 * The heuristic (straight-line distance at Tobler's 6 km/h maximum) is
 * admissible, so A* returns the minimum-cost route.
 */
import { toblerSeconds, TOBLER_MAX_KMH } from './tobler';

export interface RoadInput {
  coords: Int32Array; // x,y grid units
  offsets: Uint32Array; // n+1
  cls: Uint8Array;
  flags: Uint8Array;
  name: Int32Array; // name index or -1
  names: string[]; // name table for this input
  n: number;
}

export type ElevFn = (lon: number, lat: number) => number;

const NOFOOT = 4, PRIVATE = 16;
// cost multipliers by road class (route preference only; displayed time is pure Tobler)
const CLASS_PENALTY = [Infinity, 2.5, 1.7, 1.4, 1.2, 1.05, 1.05, 1.0, 1.0, 1.0, 1.05, 1.0, 1.0];

const A_ = 6378137.0, F_ = 1 / 298.257223563, E2_ = F_ * (2 - F_);
/** metres per grid unit in x and y at latitude (ellipsoidal radii of curvature) */
function unitScale(latDeg: number, scale: number): [number, number] {
  const p = (latDeg * Math.PI) / 180;
  const s = Math.sin(p);
  const w = Math.sqrt(1 - E2_ * s * s);
  const N = A_ / w;
  const M = (A_ * (1 - E2_)) / (w * w * w);
  const rad = Math.PI / 180 / scale;
  return [N * Math.cos(p) * rad, M * rad];
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p];
      i = p;
    }
    k[i] = key; v[i] = val;
  }
  peekKey(): number { return this.k[0]; }
  pop(): number {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c];
        i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export interface RouteResult {
  coords: [number, number][]; // lon, lat
  seconds: number;
  /** route legs by name for the summary */
  legs: { name: string; cls: number; metres: number }[];
}

export class RoadGraph {
  readonly scale: number;
  nodeX!: Int32Array;
  nodeY!: Int32Array;
  // edges
  eU!: Uint32Array;
  eV!: Uint32Array;
  eFrom!: Uint32Array; // point index (global) of the U end
  eTo!: Uint32Array; // point index of the V end (inclusive), eFrom<eTo
  eCls!: Uint8Array;
  eName!: Int32Array;
  eFwd!: Float32Array; // seconds U->V (NaN = not computed)
  eBwd!: Float32Array;
  adjStart!: Uint32Array;
  adj!: Uint32Array;
  px!: Int32Array; // all points
  py!: Int32Array;
  names: string[] = [];
  // spatial index of edges
  private cellSize = 0;
  private cells = new Map<number, number[]>();
  readonly nodes: number;
  readonly edges: number;

  constructor(inputs: RoadInput[], scale: number, private readonly elev: ElevFn) {
    this.scale = scale;
    // 1. gather walkable chains into global point arrays
    let totalPts = 0;
    for (const r of inputs) for (let i = 0; i < r.n; i++) if (walkable(r, i)) totalPts += r.offsets[i + 1] - r.offsets[i];
    const px = new Int32Array(totalPts);
    const py = new Int32Array(totalPts);
    const chainStart: number[] = [];
    const chainCls: number[] = [];
    const chainName: number[] = [];
    const nameMap = new Map<string, number>();
    let p = 0;
    for (const r of inputs) {
      for (let i = 0; i < r.n; i++) {
        if (!walkable(r, i)) continue;
        chainStart.push(p);
        chainCls.push(r.cls[i]);
        const nm = r.name[i] >= 0 ? r.names[r.name[i]] : '';
        let ni = nameMap.get(nm);
        if (ni === undefined) { ni = this.names.length; this.names.push(nm); nameMap.set(nm, ni); }
        chainName.push(ni);
        for (let k = r.offsets[i]; k < r.offsets[i + 1]; k++) {
          px[p] = r.coords[2 * k];
          py[p] = r.coords[2 * k + 1];
          p++;
        }
      }
    }
    chainStart.push(p);
    this.px = px;
    this.py = py;
    // 2. vertex use counts
    const key = (x: number, y: number) => (x + 10_000_000) * 33_554_432 + (y + 10_000_000);
    const count = new Map<number, number>();
    const nChains = chainStart.length - 1;
    for (let c = 0; c < nChains; c++) {
      const s = chainStart[c], e = chainStart[c + 1];
      for (let k = s; k < e; k++) {
        const kk = key(px[k], py[k]);
        const isEnd = k === s || k === e - 1;
        count.set(kk, (count.get(kk) ?? 0) + (isEnd ? 2 : 1));
      }
    }
    // 3. node ids
    const nodeId = new Map<number, number>();
    const nx: number[] = [], ny: number[] = [];
    for (let k = 0; k < p; k++) {
      const kk = key(px[k], py[k]);
      if ((count.get(kk) ?? 0) >= 2 && !nodeId.has(kk)) {
        nodeId.set(kk, nx.length);
        nx.push(px[k]); ny.push(py[k]);
      }
    }
    this.nodeX = Int32Array.from(nx);
    this.nodeY = Int32Array.from(ny);
    this.nodes = nx.length;
    // 4. edges
    const eU: number[] = [], eV: number[] = [], eF: number[] = [], eT: number[] = [], eC: number[] = [], eN: number[] = [];
    for (let c = 0; c < nChains; c++) {
      const s = chainStart[c], e = chainStart[c + 1];
      let from = s;
      let u = nodeId.get(key(px[s], py[s]))!;
      for (let k = s + 1; k < e; k++) {
        const id = nodeId.get(key(px[k], py[k]));
        if (id === undefined) continue;
        if (!(id === u && k - from === 1)) {
          eU.push(u); eV.push(id); eF.push(from); eT.push(k); eC.push(chainCls[c]); eN.push(chainName[c]);
        }
        u = id;
        from = k;
      }
    }
    this.edges = eU.length;
    this.eU = Uint32Array.from(eU);
    this.eV = Uint32Array.from(eV);
    this.eFrom = Uint32Array.from(eF);
    this.eTo = Uint32Array.from(eT);
    this.eCls = Uint8Array.from(eC);
    this.eName = Int32Array.from(eN);
    this.eFwd = new Float32Array(this.edges).fill(NaN);
    this.eBwd = new Float32Array(this.edges).fill(NaN);
    // 5. CSR adjacency
    const deg = new Uint32Array(this.nodes + 1);
    for (let i = 0; i < this.edges; i++) { deg[this.eU[i]]++; deg[this.eV[i]]++; }
    const start = new Uint32Array(this.nodes + 1);
    for (let i = 0; i < this.nodes; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice(0, this.nodes);
    const adj = new Uint32Array(this.edges * 2);
    for (let i = 0; i < this.edges; i++) { adj[fill[this.eU[i]]++] = i; adj[fill[this.eV[i]]++] = i; }
    this.adjStart = start;
    this.adj = adj;
    // 6. spatial index (cells of ~0.004 deg)
    this.cellSize = Math.round(0.004 * scale);
    for (let i = 0; i < this.edges; i++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = this.eFrom[i]; k <= this.eTo[i]; k++) {
        if (px[k] < x0) x0 = px[k]; if (px[k] > x1) x1 = px[k];
        if (py[k] < y0) y0 = py[k]; if (py[k] > y1) y1 = py[k];
      }
      const cs = this.cellSize;
      for (let cy = Math.floor(y0 / cs); cy <= Math.floor(y1 / cs); cy++) {
        for (let cx = Math.floor(x0 / cs); cx <= Math.floor(x1 / cs); cx++) {
          const ck = cx * 100003 + cy;
          let list = this.cells.get(ck);
          if (!list) { list = []; this.cells.set(ck, list); }
          list.push(i);
        }
      }
    }
  }

  private lonlat(k: number): [number, number] {
    return [this.px[k] / this.scale, this.py[k] / this.scale];
  }

  /** Walking time along points k0..k1 (inclusive, either direction) with Tobler. */
  private timeAlong(k0: number, k1: number, extraStart?: [number, number], extraEnd?: [number, number]): number {
    const pts: [number, number][] = [];
    if (extraStart) pts.push(extraStart);
    const step = k1 >= k0 ? 1 : -1;
    for (let k = k0; k !== k1 + step; k += step) pts.push(this.lonlat(k));
    if (extraEnd) pts.push(extraEnd);
    return timeOfPolyline(pts, this.elev, this.scale);
  }

  private edgeTime(e: number, forward: boolean): number {
    const arr = forward ? this.eFwd : this.eBwd;
    let t = arr[e];
    if (t !== t) {
      const f = this.timeAlong(this.eFrom[e], this.eTo[e]);
      const b = this.timeAlong(this.eTo[e], this.eFrom[e]);
      this.eFwd[e] = f;
      this.eBwd[e] = b;
      t = forward ? f : b;
    }
    return t * CLASS_PENALTY[this.eCls[e]];
  }

  /** Nearest point on any edge within maxMetres. */
  snap(lon: number, lat: number, maxMetres = 1500): { edge: number; seg: number; t: number; lon: number; lat: number; dist: number } | null {
    const x = lon * this.scale, y = lat * this.scale;
    const [kx, ky] = unitScale(lat, this.scale);
    const cs = this.cellSize;
    const cx = Math.floor(x / cs), cy = Math.floor(y / cs);
    const ring = Math.ceil(maxMetres / (cs * Math.min(kx, ky))) + 1;
    type Snap = { edge: number; seg: number; t: number; lon: number; lat: number; dist: number };
    let best = null as Snap | null;
    const seen = new Set<number>();
    for (let r = 0; r <= ring; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const list = this.cells.get((cx + dx) * 100003 + (cy + dy));
          if (!list) continue;
          for (const e of list) {
            if (seen.has(e)) continue;
            seen.add(e);
            for (let k = this.eFrom[e]; k < this.eTo[e]; k++) {
              const ax = (this.px[k] - x) * kx, ay = (this.py[k] - y) * ky;
              const bx = (this.px[k + 1] - x) * kx, by = (this.py[k + 1] - y) * ky;
              const vx = bx - ax, vy = by - ay;
              const L2 = vx * vx + vy * vy;
              let t = L2 > 0 ? -(ax * vx + ay * vy) / L2 : 0;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const qx = ax + t * vx, qy = ay + t * vy;
              const d = Math.hypot(qx, qy);
              if (!best || d < best.dist) {
                best = {
                  edge: e, seg: k, t, dist: d,
                  lon: (this.px[k] + t * (this.px[k + 1] - this.px[k])) / this.scale,
                  lat: (this.py[k] + t * (this.py[k + 1] - this.py[k])) / this.scale,
                };
              }
            }
          }
        }
      }
      // stop once the searched ring is beyond the best distance found
      if (best && (r * cs * Math.min(kx, ky)) > best.dist + cs * Math.max(kx, ky)) break;
    }
    return best && best.dist <= maxMetres ? best : null;
  }

  route(fromLon: number, fromLat: number, toLon: number, toLat: number): RouteResult | { error: string } {
    const s = this.snap(fromLon, fromLat);
    const t = this.snap(toLon, toLat);
    if (!s) return { error: 'The start is more than 1.5 km from any mapped track, path or road.' };
    if (!t) return { error: 'The end is more than 1.5 km from any mapped track, path or road.' };
    const sP: [number, number] = [s.lon, s.lat];
    const tP: [number, number] = [t.lon, t.lat];
    const pen = (e: number) => CLASS_PENALTY[this.eCls[e]];
    // costs from the snapped start to both ends of its edge
    const sToU = this.timeAlong(s.seg, this.eFrom[s.edge], sP) * pen(s.edge);
    const sToV = this.timeAlong(s.seg + 1, this.eTo[s.edge], sP) * pen(s.edge);
    const uToT = this.timeAlong(this.eFrom[t.edge], t.seg, undefined, tP) * pen(t.edge);
    const vToT = this.timeAlong(this.eTo[t.edge], t.seg + 1, undefined, tP) * pen(t.edge);
    const N = this.nodes;
    const g = new Float64Array(N).fill(Infinity);
    const via = new Int32Array(N).fill(-1); // edge used to reach node
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const vmax = (TOBLER_MAX_KMH * 1000) / 3600;
    const h = (n: number) => {
      const lat = this.nodeY[n] / this.scale;
      const [kx, ky] = unitScale(lat, this.scale);
      const d = Math.hypot((this.nodeX[n] - tP[0] * this.scale) * kx, (this.nodeY[n] - tP[1] * this.scale) * ky);
      return (d * 0.995) / vmax;
    };
    const U0 = this.eU[s.edge], V0 = this.eV[s.edge];
    g[U0] = sToU; g[V0] = Math.min(g[V0], sToV);
    heap.push(g[U0] + h(U0), U0);
    heap.push(g[V0] + h(V0), V0);
    let best = Infinity;
    let bestEnd = -1; // node from which we enter the target edge
    // same-edge direct option
    let direct = Infinity;
    if (s.edge === t.edge) {
      const a = s.seg + s.t, b = t.seg + t.t;
      direct = (a <= b ? this.timeAlong(s.seg + 1, t.seg, sP, tP) : this.timeAlong(s.seg, t.seg + 1, sP, tP)) * pen(s.edge);
      best = direct;
    }
    const tU = this.eU[t.edge], tV = this.eV[t.edge];
    let expanded = 0;
    while (heap.size) {
      if (heap.peekKey() >= best) break;
      const n = heap.pop();
      if (closed[n]) continue;
      closed[n] = 1;
      expanded++;
      if (n === tU && g[n] + uToT < best) { best = g[n] + uToT; bestEnd = n; }
      if (n === tV && g[n] + vToT < best) { best = g[n] + vToT; bestEnd = n; }
      for (let a = this.adjStart[n]; a < this.adjStart[n + 1]; a++) {
        const e = this.adj[a];
        const fwd = this.eU[e] === n;
        const m = fwd ? this.eV[e] : this.eU[e];
        if (closed[m]) continue;
        const ng = g[n] + this.edgeTime(e, fwd);
        if (ng < g[m]) {
          g[m] = ng;
          via[m] = e;
          heap.push(ng + h(m), m);
        }
      }
    }
    void expanded;
    if (!Number.isFinite(best)) return { error: 'No connected route along mapped tracks and paths between these points.' };
    // reconstruct
    const coords: [number, number][] = [];
    const legs: RouteResult['legs'] = [];
    let seconds = 0;
    const addLeg = (name: string, cls: number, pts: [number, number][]) => {
      let m = 0;
      for (let i = 1; i < pts.length; i++) m += segMetres(pts[i - 1], pts[i]);
      const last = legs[legs.length - 1];
      if (last && last.name === name) last.metres += m; else legs.push({ name, cls, metres: m });
    };
    const ptsAlong = (k0: number, k1: number) => {
      const out: [number, number][] = [];
      const st = k1 >= k0 ? 1 : -1;
      for (let k = k0; k !== k1 + st; k += st) out.push(this.lonlat(k));
      return out;
    };
    if (best === direct && bestEnd < 0) {
      const a = s.seg + s.t, b = t.seg + t.t;
      const pts = [sP, ...(a <= b ? ptsAlong(s.seg + 1, t.seg) : ptsAlong(s.seg, t.seg + 1)), tP];
      coords.push(...pts);
      addLeg(this.names[this.eName[s.edge]], this.eCls[s.edge], pts);
      seconds = timeOfPolyline(pts, this.elev, this.scale);
      return { coords, seconds, legs };
    }
    // node path from the start edge to bestEnd (via[] is -1 only at the seeded start nodes)
    const edgesRev: number[] = [];
    let n = bestEnd;
    for (let guard = 0; via[n] >= 0 && guard < this.edges; guard++) {
      const e = via[n];
      edgesRev.push(e);
      n = this.eU[e] === n ? this.eV[e] : this.eU[e];
    }
    const startNode = n;
    const first = startNode === U0 ? [sP, ...ptsAlong(s.seg, this.eFrom[s.edge])] : [sP, ...ptsAlong(s.seg + 1, this.eTo[s.edge])];
    coords.push(...first);
    addLeg(this.names[this.eName[s.edge]], this.eCls[s.edge], first);
    let cur = startNode;
    for (let i = edgesRev.length - 1; i >= 0; i--) {
      const e = edgesRev[i];
      const fwd = this.eU[e] === cur;
      const pts = fwd ? ptsAlong(this.eFrom[e], this.eTo[e]) : ptsAlong(this.eTo[e], this.eFrom[e]);
      coords.push(...pts.slice(1));
      addLeg(this.names[this.eName[e]], this.eCls[e], pts);
      cur = fwd ? this.eV[e] : this.eU[e];
    }
    const last = cur === tU ? [...ptsAlong(this.eFrom[t.edge], t.seg), tP] : [...ptsAlong(this.eTo[t.edge], t.seg + 1), tP];
    coords.push(...last.slice(1));
    addLeg(this.names[this.eName[t.edge]], this.eCls[t.edge], last);
    seconds = timeOfPolyline(coords, this.elev, this.scale);
    return { coords, seconds, legs };
  }
}

function walkable(r: RoadInput, i: number): boolean {
  const f = r.flags[i];
  return r.cls[i] !== 0 && (f & (NOFOOT | PRIVATE)) === 0;
}

function segMetres(a: [number, number], b: [number, number]): number {
  const lat = (a[1] + b[1]) / 2;
  const [kx, ky] = unitScale(lat, 1);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
}

/** Tobler time along a polyline, sampling elevation at <= 30 m steps. */
export function timeOfPolyline(pts: [number, number][], elev: ElevFn, _scale = 1): number {
  let t = 0;
  let prevE = NaN;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = segMetres(a, b);
    const steps = Math.max(1, Math.ceil(d / 30));
    let ea = Number.isFinite(prevE) ? prevE : elev(a[0], a[1]);
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const eb = elev(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f);
      const dh = Number.isFinite(ea) && Number.isFinite(eb) ? eb - ea : 0;
      t += toblerSeconds(d / steps, dh);
      ea = eb;
    }
    prevE = ea;
  }
  return t;
}
