/** Tile generators (run inside the worker). */
import type { Region } from './region';
import { marchingSquares, simplifyLine, contourIntervals } from '../shared/calc/contours';
import { encodeTile, clipLine, clipRing, ringArea, EXTENT, type MvtFeature, type MvtLayer } from '../shared/mvt';
import { RC, WC, PT } from '../shared/vectorcodec';

export const TILE = 256;
const BUF = 64; // tile buffer in extent units

export function lonOf(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}
export function latOf(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}
function mercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export class World {
  regions: Region[] = [];

  regionAt(lon: number, lat: number): Region | null {
    for (const r of this.regions) if (r.contains(lon, lat)) return r;
    return null;
  }

  elevation(lon: number, lat: number, lod: 1 | 4 | 8 = 1): number {
    const r = this.regionAt(lon, lat);
    if (!r) return NaN;
    return lod === 1 ? r.elevation(lon, lat) : r.elevationLod(lon, lat, lod);
  }

  intersecting(w: number, s: number, e: number, n: number): Region[] {
    return this.regions.filter((r) => !(r.east < w || r.west > e || r.north < s || r.south > n));
  }
}

function tileBounds(z: number, x: number, y: number) {
  return { w: lonOf(x, z), e: lonOf(x + 1, z), n: latOf(y, z), s: latOf(y + 1, z) };
}

function demLod(z: number): 1 | 4 | 8 {
  return z >= 11 ? 1 : z === 10 ? 4 : 8;
}

/** Terrarium-encoded elevation tile (RGBA). Outside loaded regions: 0 m. */
export function demTile(world: World, z: number, x: number, y: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  const b = tileBounds(z, x, y);
  const regs = world.intersecting(b.w, b.s, b.e, b.n);
  const lod = demLod(z);
  const lons = new Float64Array(TILE);
  const lats = new Float64Array(TILE);
  for (let i = 0; i < TILE; i++) {
    lons[i] = lonOf(x + (i + 0.5) / TILE, z);
    lats[i] = latOf(y + (i + 0.5) / TILE, z);
  }
  for (let j = 0; j < TILE; j++) {
    const lat = lats[j];
    for (let i = 0; i < TILE; i++) {
      const lon = lons[i];
      let e = 0;
      for (const r of regs) {
        if (r.contains(lon, lat)) {
          const v = lod === 1 ? r.elevation(lon, lat) : r.elevationLod(lon, lat, lod);
          if (v === v) e = v;
          break;
        }
      }
      const v = e + 32768;
      const k = (j * TILE + i) * 4;
      const fl = Math.floor(v);
      px[k] = fl >> 8;
      px[k + 1] = fl & 255;
      px[k + 2] = Math.floor((v - fl) * 256);
      px[k + 3] = 255;
    }
  }
  return px;
}

// slope classes (degrees) and colours: steep-ground shading
export const SLOPE_CLASSES: { min: number; rgba: [number, number, number, number]; label: string }[] = [
  { min: 15, rgba: [255, 240, 120, 70], label: '15–20°' },
  { min: 20, rgba: [250, 214, 0, 110], label: '20–25°' },
  { min: 25, rgba: [255, 140, 0, 130], label: '25–30°' },
  { min: 30, rgba: [244, 67, 0, 150], label: '30–35°' },
  { min: 35, rgba: [205, 0, 30, 165], label: '35–40°' },
  { min: 40, rgba: [120, 0, 150, 175], label: '≥ 40°' },
];

const A_ = 6378137.0, F_ = 1 / 298.257223563, E2_ = F_ * (2 - F_);
export function spacing(lat: number, dLat: number, dLon: number): [number, number] {
  const p = (lat * Math.PI) / 180;
  const s = Math.sin(p);
  const w = Math.sqrt(1 - E2_ * s * s);
  const N = A_ / w;
  const M = (A_ * (1 - E2_)) / (w * w * w);
  return [N * Math.cos(p) * ((dLon * Math.PI) / 180), M * ((dLat * Math.PI) / 180)];
}

/** Slope (degrees) and aspect at a point: central differences one grid cell either side, ellipsoidal spacing. */
export function slopeAt(world: World, lon: number, lat: number): { slope: number; aspect: number } {
  const r = world.regionAt(lon, lat);
  if (!r) return { slope: NaN, aspect: NaN };
  const [dx, dy] = spacing(lat, r.dLat, r.dLon);
  const ew = world.elevation(lon - r.dLon, lat), ee = world.elevation(lon + r.dLon, lat);
  const en = world.elevation(lon, lat + r.dLat), es = world.elevation(lon, lat - r.dLat);
  if (!(ew === ew && ee === ee && en === en && es === es)) return { slope: NaN, aspect: NaN };
  const gx = (ee - ew) / (2 * dx);
  const gy = (en - es) / (2 * dy);
  const slope = (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
  // aspect: direction the slope faces (downhill), degrees clockwise from north
  let aspect = (Math.atan2(-gx, -gy) * 180) / Math.PI;
  if (aspect < 0) aspect += 360;
  return { slope, aspect };
}

export function slopeTile(world: World, z: number, x: number, y: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(TILE * TILE * 4);
  const b = tileBounds(z, x, y);
  const regs = world.intersecting(b.w, b.s, b.e, b.n);
  if (!regs.length) return px;
  const lod = z >= 12 ? 1 : 4;
  for (let j = 0; j < TILE; j++) {
    const lat = latOf(y + (j + 0.5) / TILE, z);
    const reg0 = regs[0];
    const [dx, dy] = spacing(lat, reg0.dLat * lod, reg0.dLon * lod);
    const dLon = reg0.dLon * lod, dLat = reg0.dLat * lod;
    for (let i = 0; i < TILE; i++) {
      const lon = lonOf(x + (i + 0.5) / TILE, z);
      const ew = world.elevation(lon - dLon, lat, lod), ee = world.elevation(lon + dLon, lat, lod);
      const en = world.elevation(lon, lat + dLat, lod), es = world.elevation(lon, lat - dLat, lod);
      if (!(ew === ew && ee === ee && en === en && es === es)) continue;
      const g = Math.hypot((ee - ew) / (2 * dx), (en - es) / (2 * dy));
      const deg = (Math.atan(g) * 180) / Math.PI;
      let cls = -1;
      for (let k = SLOPE_CLASSES.length - 1; k >= 0; k--) if (deg >= SLOPE_CLASSES[k].min) { cls = k; break; }
      if (cls < 0) continue;
      const c = SLOPE_CLASSES[cls].rgba;
      const o = (j * TILE + i) * 4;
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
    }
  }
  return px;
}

/** Contour MVT tile: marching squares on the native 1" lattice (or a stride lattice at low zoom). */
export function contourTile(world: World, z: number, x: number, y: number): Uint8Array {
  const iv = contourIntervals(z);
  if (!iv) return new Uint8Array(0);
  const b = tileBounds(z, x, y);
  const regs = world.intersecting(b.w, b.s, b.e, b.n);
  if (!regs.length) return new Uint8Array(0);
  const stride: 1 | 2 | 4 = z >= 12 ? 1 : z === 11 ? 2 : 4;
  const P = 3600 / stride; // lattice points per degree
  // global lattice indices (row increases southward)
  const pad = (BUF / EXTENT) * (b.e - b.w);
  const R0 = Math.floor((90 - (b.n + pad)) * P) - 1;
  const R1 = Math.ceil((90 - (b.s - pad)) * P) + 1;
  const C0 = Math.floor((b.w - pad + 180) * P) - 1;
  const C1 = Math.ceil((b.e + pad + 180) * P) + 1;
  const w = C1 - C0 + 1, h = R1 - R0 + 1;
  const grid = new Float32Array(w * h).fill(NaN);
  let mn = Infinity, mx = -Infinity;
  for (const r of regs) {
    // region lattice offsets
    const rr0 = Math.round((90 - r.north) * P);
    const cc0 = Math.round((r.west + 180) * P);
    const rmax = (r.rows - 1) / stride, cmax = (r.cols - 1) / stride;
    for (let R = Math.max(R0, rr0); R <= Math.min(R1, rr0 + rmax); R++) {
      for (let C = Math.max(C0, cc0); C <= Math.min(C1, cc0 + cmax); C++) {
        const k = (R - R0) * w + (C - C0);
        if (grid[k] === grid[k]) continue;
        const v = r.latticeValue((R - rr0) * stride, (C - cc0) * stride, stride);
        grid[k] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
  }
  if (!Number.isFinite(mn)) return new Uint8Array(0);
  const levels: number[] = [];
  for (let l = Math.ceil(mn / iv.minor) * iv.minor; l <= mx; l += iv.minor) levels.push(l);
  const lines = marchingSquares(grid, w, h, levels);
  const n2 = 2 ** z;
  const ty0 = mercY(b.n), ty1 = mercY(b.s);
  const feats: MvtFeature[] = [];
  for (const line of lines) {
    const pts: number[] = [];
    for (let i = 0; i < line.pts.length; i += 2) {
      const lon = (C0 + line.pts[i]) / P - 180;
      const lat = 90 - (R0 + line.pts[i + 1]) / P;
      pts.push(((lon - b.w) / (b.e - b.w)) * EXTENT, ((mercY(lat) - ty0) / (ty1 - ty0)) * EXTENT);
    }
    const simp = simplifyLine(pts, 3);
    const parts = clipLine(simp, -BUF, -BUF, EXTENT + BUF, EXTENT + BUF);
    if (!parts.length) continue;
    const idx = Math.round(line.level) % iv.major === 0 ? 1 : 0;
    feats.push({ type: 2, geom: parts, props: { ele: Math.round(line.level), idx } });
  }
  void n2;
  return encodeTile([{ name: 'contours', features: feats }]);
}

// ---------------------------------------------------------------- vector features
// minimum zooms per road class
const ROAD_MINZ = [6, 6, 7, 8, 9, 11, 13, 10, 12, 12, 12, 12, 13];
const POI_MINZ: Record<number, number> = { [PT.PEAK]: 11, [PT.SADDLE]: 13, [PT.CAVE]: 13, [PT.HUT]: 11, [PT.SHELTER]: 13, [PT.CAMP]: 12, [PT.WATER]: 13, [PT.VIEWPOINT]: 13, [PT.TOILETS]: 14, [PT.WATERFALL]: 12, [PT.RAPID]: 14, [PT.SPRING]: 13 };

function waterMinZ(cls: number, hier: number): number {
  if (cls === WC.RIVER) return hier >= 1 ? 7 : 9;
  if (cls === WC.CONNECTOR) return hier >= 2 ? 7 : 9;
  if (cls === WC.CHANNEL) return 12;
  return hier >= 2 ? 9 : hier === 1 ? 10 : 12; // streams
}

export function vectorTile(world: World, z: number, x: number, y: number): Uint8Array {
  if (z < 6) return new Uint8Array(0);
  const b = tileBounds(z, x, y);
  const pad = ((BUF / EXTENT) * (b.e - b.w));
  const regs = world.intersecting(b.w - pad, b.s - pad, b.e + pad, b.n + pad);
  if (!regs.length) return new Uint8Array(0);
  const ty0 = mercY(b.n), ty1 = mercY(b.s);
  const kx = EXTENT / (b.e - b.w), ky = EXTENT / (ty1 - ty0);
  const tol = z >= 15 ? 1 : z >= 13 ? 3 : 6;
  const roads: MvtFeature[] = [], water: MvtFeature[] = [], areas: MvtFeature[] = [], pois: MvtFeature[] = [];
  const minArea = z >= 13 ? 0 : (EXTENT / 256) ** 2 * (z >= 11 ? 4 : 16); // in extent units^2
  for (const reg of regs) {
    const sc = reg.meta.vec.scale;
    const names = reg.nameTable();
    const bx0 = (b.w - pad) * sc, bx1 = (b.e + pad) * sc, by0 = (b.s - pad) * sc, by1 = (b.n + pad) * sc;
    const project = (coords: Int32Array, from: number, to: number): number[] => {
      const out: number[] = new Array((to - from) * 2);
      let o = 0;
      for (let k = from; k < to; k++) {
        out[o++] = (coords[2 * k] / sc - b.w) * kx;
        out[o++] = (mercY(coords[2 * k + 1] / sc) - ty0) * ky;
      }
      return out;
    };
    for (const ci of reg.chunksIn(b.w - pad, b.s - pad, b.e + pad, b.n + pad)) {
      const ch = reg.chunk(ci);
      const R = ch.roads;
      for (let i = 0; i < R.n; i++) {
        if (z < ROAD_MINZ[R.a0[i]]) continue;
        const bb = i * 4;
        if (R.bbox[bb + 2] < bx0 || R.bbox[bb] > bx1 || R.bbox[bb + 3] < by0 || R.bbox[bb + 1] > by1) continue;
        const pts = simplifyLine(project(R.coords, R.offsets[i], R.offsets[i + 1]), tol);
        const parts = clipLine(pts, -BUF, -BUF, EXTENT + BUF, EXTENT + BUF);
        if (!parts.length) continue;
        const props: Record<string, string | number | boolean> = { cls: R.a0[i], f: R.a1[i] };
        if (R.a2[i]) props.sac = R.a2[i];
        if (R.name[i] >= 0 && z >= 13) props.name = names[R.name[i]];
        roads.push({ type: 2, geom: parts, props });
      }
      const Wt = ch.water;
      for (let i = 0; i < Wt.n; i++) {
        const cls = Wt.a0[i], hier = Wt.a1[i];
        if (z < waterMinZ(cls, hier) || (cls === WC.CONNECTOR && z >= 13)) continue;
        const bb = i * 4;
        if (Wt.bbox[bb + 2] < bx0 || Wt.bbox[bb] > bx1 || Wt.bbox[bb + 3] < by0 || Wt.bbox[bb + 1] > by1) continue;
        const pts = simplifyLine(project(Wt.coords, Wt.offsets[i], Wt.offsets[i + 1]), tol);
        const parts = clipLine(pts, -BUF, -BUF, EXTENT + BUF, EXTENT + BUF);
        if (!parts.length) continue;
        const props: Record<string, string | number | boolean> = { cls, h: hier };
        if (Wt.name[i] >= 0 && z >= 12) props.name = names[Wt.name[i]];
        water.push({ type: 2, geom: parts, props });
      }
      const A = ch.areas;
      for (let i = 0; i < A.n; i++) {
        const bb = i * 4;
        if (A.bbox[bb + 2] < bx0 || A.bbox[bb] > bx1 || A.bbox[bb + 3] < by0 || A.bbox[bb + 1] > by1) continue;
        const rings: number[][] = [];
        for (let rr = A.featRings[i]; rr < A.featRings[i + 1]; rr++) {
          let ring = project(A.coords, A.ringOffsets[rr], A.ringOffsets[rr + 1]);
          ring = clipRing(ring, -BUF, -BUF, EXTENT + BUF, EXTENT + BUF);
          if (ring.length < 6) { if (rr === A.featRings[i]) break; continue; }
          const ar = ringArea(ring);
          const outer = rr === A.featRings[i];
          if (outer && Math.abs(ar) < minArea) break;
          // MVT: exterior rings clockwise in screen space (positive area), holes negative
          if ((outer && ar < 0) || (!outer && ar > 0)) {
            const rev: number[] = [];
            for (let k = ring.length - 2; k >= 0; k -= 2) rev.push(ring[k], ring[k + 1]);
            ring = rev;
          }
          rings.push(ring);
        }
        if (!rings.length) continue;
        const props: Record<string, string | number | boolean> = { cls: A.cls[i] };
        if (A.name[i] >= 0) props.name = names[A.name[i]];
        areas.push({ type: 3, geom: rings, props });
      }
      const P = ch.pois;
      for (let i = 0; i < P.n; i++) {
        const t = P.type[i];
        if (z < (POI_MINZ[t] ?? 14)) continue;
        if (t === PT.PEAK && z < 13 && P.name[i] < 0) continue;
        const lon = P.x[i] / sc, lat = P.y[i] / sc;
        if (lon < b.w || lon > b.e || lat < b.s || lat > b.n) continue;
        const props: Record<string, string | number | boolean> = { t };
        if (P.name[i] >= 0) props.name = names[P.name[i]];
        if (P.ele[i] === P.ele[i]) props.ele = P.ele[i];
        pois.push({ type: 1, geom: [[(lon - b.w) * kx, (mercY(lat) - ty0) * ky]], props });
      }
    }
  }
  const layers: MvtLayer[] = [
    { name: 'water_areas', features: areas },
    { name: 'water_lines', features: water },
    { name: 'roads', features: roads },
    { name: 'pois', features: pois },
  ];
  void RC;
  return encodeTile(layers);
}
