/**
 * Mapbox Vector Tile (v2) encoder used by the on-phone tile generator.
 * Geometry is given in tile pixel space (0..extent), already clipped.
 */
import { PbfWriter } from './pbf';

export const EXTENT = 4096;
export type PropValue = string | number | boolean;

export interface MvtFeature {
  type: 1 | 2 | 3; // point, linestring, polygon
  /** for points: [x, y, x, y...]; lines: array of parts; polygons: array of rings (outer first) */
  geom: number[][];
  props: Record<string, PropValue>;
  id?: number;
}

export interface MvtLayer {
  name: string;
  features: MvtFeature[];
}

const zz = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);

function encodeGeometry(f: MvtFeature): number[] {
  const out: number[] = [];
  let cx = 0, cy = 0;
  if (f.type === 1) {
    const pts = f.geom[0];
    const n = pts.length / 2;
    out.push((1 & 7) | (n << 3));
    for (let i = 0; i < n; i++) {
      const x = Math.round(pts[2 * i]), y = Math.round(pts[2 * i + 1]);
      out.push(zz(x - cx), zz(y - cy));
      cx = x; cy = y;
    }
    return out;
  }
  for (const part of f.geom) {
    // drop repeated points after rounding
    const pts: number[] = [];
    for (let i = 0; i < part.length; i += 2) {
      const x = Math.round(part[i]), y = Math.round(part[i + 1]);
      const m = pts.length;
      if (m >= 2 && pts[m - 2] === x && pts[m - 1] === y) continue;
      pts.push(x, y);
    }
    let n = pts.length / 2;
    if (f.type === 3) {
      if (n > 1 && pts[0] === pts[2 * n - 2] && pts[1] === pts[2 * n - 1]) n--; // drop closing point
      if (n < 3) continue;
    } else if (n < 2) continue;
    out.push(1 | (1 << 3), zz(pts[0] - cx), zz(pts[1] - cy));
    cx = pts[0]; cy = pts[1];
    out.push(2 | ((n - 1) << 3));
    for (let i = 1; i < n; i++) {
      out.push(zz(pts[2 * i] - cx), zz(pts[2 * i + 1] - cy));
      cx = pts[2 * i]; cy = pts[2 * i + 1];
    }
    if (f.type === 3) out.push(7 | (1 << 3));
  }
  return out;
}

/** Signed area in tile space (y down): > 0 means clockwise on screen. */
export function ringArea(r: number[]): number {
  let s = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) s += (r[2 * j] - r[2 * i]) * (r[2 * j + 1] + r[2 * i + 1]);
  return s / 2;
}

export function encodeTile(layers: MvtLayer[]): Uint8Array {
  const tile = new PbfWriter(8192);
  for (const layer of layers) {
    if (!layer.features.length) continue;
    const keys: string[] = [];
    const keyIdx = new Map<string, number>();
    const values: PropValue[] = [];
    const valIdx = new Map<string, number>();
    const feats: { tags: number[]; type: number; geom: number[]; id?: number }[] = [];
    for (const f of layer.features) {
      const geom = encodeGeometry(f);
      if (!geom.length) continue;
      const tags: number[] = [];
      for (const k in f.props) {
        const v = f.props[k];
        let ki = keyIdx.get(k);
        if (ki === undefined) { ki = keys.length; keys.push(k); keyIdx.set(k, ki); }
        const vk = typeof v + ':' + String(v);
        let vi = valIdx.get(vk);
        if (vi === undefined) { vi = values.length; values.push(v); valIdx.set(vk, vi); }
        tags.push(ki, vi);
      }
      feats.push({ tags, type: f.type, geom, id: f.id });
    }
    if (!feats.length) continue;
    tile.message(3, (l) => {
      l.uintField(15, 2);
      l.stringField(1, layer.name);
      for (const f of feats) {
        l.message(2, (fw) => {
          if (f.id !== undefined) fw.uintField(1, f.id);
          if (f.tags.length) fw.packedVarints(2, f.tags);
          fw.uintField(3, f.type);
          fw.packedVarints(4, f.geom);
        });
      }
      for (const k of keys) l.stringField(3, k);
      for (const v of values) {
        l.message(4, (vw) => {
          if (typeof v === 'string') vw.stringField(1, v);
          else if (typeof v === 'boolean') vw.uintField(7, v ? 1 : 0);
          else if (Number.isInteger(v)) vw.sintField(6, v);
          else vw.doubleField(3, v);
        });
      }
      l.uintField(5, EXTENT);
    });
  }
  return tile.finish();
}

// ---------------------------------------------------------------- clipping
/** Clip a polyline (interleaved) to a box; returns parts. */
export function clipLine(pts: number[], x0: number, y0: number, x1: number, y1: number): number[][] {
  const parts: number[][] = [];
  let cur: number[] = [];
  const n = pts.length / 2;
  for (let i = 0; i < n - 1; i++) {
    let ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * i + 2], by = pts[2 * i + 3];
    // Liang-Barsky
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy];
    const q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } }
      else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!ok) {
      if (cur.length >= 4) parts.push(cur);
      cur = [];
      continue;
    }
    const cx0 = ax + t0 * dx, cy0 = ay + t0 * dy, cx1 = ax + t1 * dx, cy1 = ay + t1 * dy;
    if (!cur.length) cur.push(cx0, cy0);
    else if (t0 > 0) { if (cur.length >= 4) parts.push(cur); cur = [cx0, cy0]; }
    cur.push(cx1, cy1);
    if (t1 < 1) { if (cur.length >= 4) parts.push(cur); cur = []; }
    void ax; void ay; void bx; void by;
  }
  if (cur.length >= 4) parts.push(cur);
  return parts;
}

/** Sutherland-Hodgman polygon ring clip to a box. */
export function clipRing(r: number[], x0: number, y0: number, x1: number, y1: number): number[] {
  let pts = r;
  const edges: [number, number, boolean][] = [[0, x0, true], [0, x1, false], [1, y0, true], [1, y1, false]];
  for (const [axis, v, isMin] of edges) {
    const out: number[] = [];
    const n = pts.length / 2;
    if (!n) break;
    for (let i = 0; i < n; i++) {
      const j = (i + n - 1) % n;
      const ci = pts[2 * i + axis], cj = pts[2 * j + axis];
      const inI = isMin ? ci >= v : ci <= v;
      const inJ = isMin ? cj >= v : cj <= v;
      if (inI) {
        if (!inJ) {
          const t = (v - cj) / (ci - cj);
          out.push(pts[2 * j] + t * (pts[2 * i] - pts[2 * j]), pts[2 * j + 1] + t * (pts[2 * i + 1] - pts[2 * j + 1]));
        }
        out.push(pts[2 * i], pts[2 * i + 1]);
      } else if (inJ) {
        const t = (v - cj) / (ci - cj);
        out.push(pts[2 * j] + t * (pts[2 * i] - pts[2 * j]), pts[2 * j + 1] + t * (pts[2 * i + 1] - pts[2 * j + 1]));
      }
    }
    pts = out;
  }
  return pts;
}
