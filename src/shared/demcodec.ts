/**
 * TGD1 – block-based, slope-adaptive near-lossless DEM codec.
 *
 * Grid values are heights in UNIT (0.25 m) steps.  Each sample is predicted
 * from already-decoded neighbours (8-neighbour least-squares predictor whose
 * integer coefficients are fitted per region), and the prediction residual
 * is quantised with a step chosen from the *local slope* of decoded
 * neighbours:
 *
 *   step  = largest s in {0.5, 1, 2} m with  s <= 2 * D * slope   (D = 3 m)
 *
 * Ground flatter than 1:6 keeps 0.5 m steps (max error 0.25 m); 1:6 to 1:3
 * uses 1 m steps (max error 0.5 m) and steeper ground 2 m steps (max error
 * 1 m).  Wherever the slope exceeds ~8 % the quantisation can therefore move
 * a contour line by at most 3 m horizontally - a tenth of the 30 m grid
 * spacing and well inside the DEM's own accuracy (GLO-30: < 4 m LE90
 * vertical).  The encoder works closed-loop so the decoder reproduces
 * exactly the same values.
 *
 * Residuals are binarised (zero flag, sign, unary magnitude, Exp-Golomb
 * escape) and coded with the adaptive binary range coder using contexts
 * derived from local activity.  Blocks (240 x 240 samples) are independent
 * so the phone only decodes the blocks it needs.
 */
import { RangeDecoder, RangeEncoder, PROB_INIT } from './rangecoder';

export const DEM_UNIT_M = 0.25;
/** quantisation steps in units: 0.5 m, 1 m, 2 m */
export const STEP_SET = [2, 4, 8] as const;
export const CONTOUR_SHIFT_M = 3; // D: max horizontal contour displacement from quantisation
export const COEF_SHIFT = 12;

export interface DemParams {
  rows: number;
  cols: number;
  blockSize: number;
  /** integer predictor coefficients (scaled by 2^COEF_SHIFT) for W,N,NW,NE,WW,NN,NNE,NNW */
  coef: number[];
  /** per block-row slope coefficients: g^2 = kx2[br]*ex^2 + ky2[br]*ey^2 */
  kx2: number[];
  ky2: number[];
  /** initial probabilities (12-bit) for every context bit */
  priors: number[];
}

// ---- context layout -------------------------------------------------------
const N_ACT = 12; // activity buckets
const UNARY = 14; // unary magnitude bits before escape
const EG_PREFIX = 24; // exp-golomb prefix contexts
const N_STEP = STEP_SET.length;
const N_SCTX = N_ACT * N_STEP; // activity x step contexts
const CTX_ZERO = 0;
const CTX_SIGN = CTX_ZERO + N_SCTX;
const CTX_MAG = CTX_SIGN + N_SCTX * 9;
const CTX_EG = CTX_MAG + N_SCTX * UNARY;
export const N_CTX = CTX_EG + EG_PREFIX;

const ACT_EDGES = [1, 2, 3, 4, 6, 8, 11, 15, 21, 30, 45]; // in step units
function actBucket(a: number): number {
  let b = 0;
  while (b < ACT_EDGES.length && a >= ACT_EDGES[b]) b++;
  return b;
}
// bucket lookup table for a = 0..255 (larger values => last bucket)
const ACT_LUT = new Uint8Array(256);
for (let a = 0; a < 256; a++) ACT_LUT[a] = actBucket(a);

// squared slope at which each coarser step becomes allowed: s <= 2*D*g  <=>  g >= s/(2D)
const T1 = ((STEP_SET[1] * DEM_UNIT_M) / (2 * CONTOUR_SHIFT_M)) ** 2; // 1 m step from 1:6
const T2 = ((STEP_SET[2] * DEM_UNIT_M) / (2 * CONTOUR_SHIFT_M)) ** 2; // 2 m step from 1:3

export function blockCount(n: number, bs: number): number {
  return Math.max(1, Math.floor((n - 1) / bs));
}
export function blockRange(index: number, n: number, bs: number): [number, number] {
  const nb = blockCount(n, bs);
  const start = index * bs;
  const end = index === nb - 1 ? n : start + bs;
  return [start, end];
}

/** Ellipsoidal sample spacing (GRS80/WGS84) at latitude phi (deg). */
export function sampleSpacing(latDeg: number, dLatDeg: number, dLonDeg: number): { dx: number; dy: number } {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const phi = (latDeg * Math.PI) / 180;
  const s = Math.sin(phi);
  const w = Math.sqrt(1 - e2 * s * s);
  const N = a / w; // prime vertical radius
  const M = (a * (1 - e2)) / (w * w * w); // meridional radius
  return { dx: N * Math.cos(phi) * (dLonDeg * Math.PI) / 180, dy: M * (dLatDeg * Math.PI) / 180 };
}

/** Shared per-sample core used by both the encoder and the decoder. */
interface Neigh {
  pred: number;
  step: number;
  ctx: number; // activity bucket * N_STEP + step index
  sctx: number; // sign context 0..8 from neighbouring residual signs
}

function neighbourhood(
  rec: Int32Array, err: Int32Array, sgn: Int8Array, w: number, r: number, c: number, coef: number[], kx2: number, ky2: number, out: Neigh,
): void {
  const i = r * w + c;
  out.sctx = 4;
  if (r === 0) {
    out.pred = c === 0 ? 0 : rec[i - 1];
    out.step = STEP_SET[0];
    out.ctx = c === 0 ? (N_ACT - 1) * N_STEP : Math.min(N_ACT - 1, c === 0 ? 0 : ACT_LUT[Math.min(255, err[i - 1] >> 1)]) * N_STEP;
    return;
  }
  if (c === 0) {
    out.pred = rec[i - w];
    out.step = STEP_SET[0];
    out.ctx = ACT_LUT[Math.min(255, err[i - w] >> 1)] * N_STEP;
    return;
  }
  const W = rec[i - 1];
  const N = rec[i - w];
  const NW = rec[i - w - 1];
  const hasNE = c < w - 1;
  const NE = hasNE ? rec[i - w + 1] : N;
  let pred: number;
  let stepIdx = 0;
  if (r >= 2 && c >= 2 && hasNE) {
    const WW = rec[i - 2];
    const NN = rec[i - 2 * w];
    const NNE = rec[i - 2 * w + 1];
    const NNW = rec[i - 2 * w - 1];
    const acc = coef[0] * W + coef[1] * N + coef[2] * NW + coef[3] * NE + coef[4] * WW + coef[5] * NN + coef[6] * NNE + coef[7] * NNW;
    pred = Math.floor((acc + (1 << (COEF_SHIFT - 1))) / (1 << COEF_SHIFT));
    // keep the prediction inside a sane envelope of its neighbours
    let mn = W, mx = W;
    if (N < mn) mn = N; else if (N > mx) mx = N;
    if (NW < mn) mn = NW; else if (NW > mx) mx = NW;
    if (NE < mn) mn = NE; else if (NE > mx) mx = NE;
    const span = mx - mn;
    if (pred < mn - span) pred = mn - span;
    else if (pred > mx + span) pred = mx + span;
    // slope estimate from decoded neighbours
    const ex = NE - NW + 2 * (W - WW);
    const ey = NNW + NN + NNE - (NW + N + NE);
    const g2 = kx2 * ex * ex + ky2 * ey * ey;
    stepIdx = g2 >= T2 ? 2 : g2 >= T1 ? 1 : 0;
  } else {
    pred = W + N - NW;
  }
  const step = STEP_SET[stepIdx];
  // error-energy context: recent prediction errors around the sample
  let act = 2 * err[i - 1] + 2 * err[i - w] + err[i - w - 1] + (hasNE ? err[i - w + 1] : err[i - w]);
  act = Math.floor(act / (2 * step));
  out.pred = pred;
  out.step = step;
  out.ctx = (act > 255 ? N_ACT - 1 : ACT_LUT[act]) * N_STEP + stepIdx;
  out.sctx = (sgn[i - 1] + 1) * 3 + (sgn[i - w] + 1);
}

function encodeResidual(enc: RangeEncoder, probs: Uint16Array, ctx: number, sctx: number, q: number): void {
  if (q === 0) {
    enc.encodeBit(probs, CTX_ZERO + ctx, 0);
    return;
  }
  enc.encodeBit(probs, CTX_ZERO + ctx, 1);
  enc.encodeBit(probs, CTX_SIGN + ctx * 9 + sctx, q < 0 ? 1 : 0);
  let m = Math.abs(q) - 1;
  const base = CTX_MAG + ctx * UNARY;
  for (let k = 0; k < UNARY; k++) {
    if (m === 0) {
      enc.encodeBit(probs, base + k, 0);
      return;
    }
    enc.encodeBit(probs, base + k, 1);
    m--;
  }
  // Exp-Golomb (order 0) escape for m >= 0
  const v = m + 1;
  const nbits = 31 - Math.clz32(v);
  for (let k = 0; k < nbits; k++) enc.encodeBit(probs, CTX_EG + Math.min(k, EG_PREFIX - 1), 1);
  enc.encodeBit(probs, CTX_EG + Math.min(nbits, EG_PREFIX - 1), 0);
  if (nbits > 0) enc.encodeDirect(v - (1 << nbits), nbits);
}

function decodeResidual(dec: RangeDecoder, probs: Uint16Array, ctx: number, sctx: number): number {
  if (dec.decodeBit(probs, CTX_ZERO + ctx) === 0) return 0;
  const neg = dec.decodeBit(probs, CTX_SIGN + ctx * 9 + sctx) === 1;
  const base = CTX_MAG + ctx * UNARY;
  let m = 0;
  let k = 0;
  for (; k < UNARY; k++) {
    if (dec.decodeBit(probs, base + k) === 0) break;
    m++;
  }
  if (k === UNARY) {
    let nbits = 0;
    while (dec.decodeBit(probs, CTX_EG + Math.min(nbits, EG_PREFIX - 1)) === 1) nbits++;
    const v = (1 << nbits) + (nbits > 0 ? dec.decodeDirect(nbits) : 0);
    m += v - 1;
  }
  const mag = m + 1;
  return neg ? -mag : mag;
}

export interface EncodeResult {
  params: DemParams;
  blocks: Uint8Array[];
  /** max |reconstructed - original| in metres (should be <= 1.0) */
  maxErrorM: number;
  rmsErrorM: number;
  stepHistogram: number[];
}

/** Fit integer predictor coefficients by least squares on the (unquantised) data. */
export function fitPredictor(data: Float32Array, rows: number, cols: number): number[] {
  // normal equations on a subsample
  const n = 8;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  const x = new Float64Array(n);
  const stride = 7;
  for (let r = 2; r < rows; r += stride) {
    for (let c = 2; c < cols - 1; c += 3) {
      const i = r * cols + c;
      const v = data[i] / DEM_UNIT_M;
      x[0] = data[i - 1]; x[1] = data[i - cols]; x[2] = data[i - cols - 1]; x[3] = data[i - cols + 1];
      x[4] = data[i - 2]; x[5] = data[i - 2 * cols]; x[6] = data[i - 2 * cols + 1]; x[7] = data[i - 2 * cols - 1];
      for (let k = 0; k < n; k++) x[k] /= DEM_UNIT_M;
      for (let p = 0; p < n; p++) {
        b[p] += x[p] * v;
        for (let q = 0; q < n; q++) A[p * n + q] += x[p] * x[q];
      }
    }
  }
  // solve with Gaussian elimination (partial pivot)
  const M = Array.from({ length: n }, (_, p) => [...Array.from(A.subarray(p * n, p * n + n)), b[p]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const sol = M.map((row, p) => row[n] / row[p]);
  if (sol.some((v) => !Number.isFinite(v))) return [1, 1, -1, 0, 0, 0, 0, 0].map((v) => v << COEF_SHIFT);
  // integerise and force the coefficients to sum to exactly 2^COEF_SHIFT (unbiased on flat ground)
  const scale = 1 << COEF_SHIFT;
  const ints = sol.map((v) => Math.round(v * scale));
  const diff = scale - ints.reduce((s, v) => s + v, 0);
  ints[0] += diff;
  return ints;
}

export function encodeDem(
  data: Float32Array,
  rows: number,
  cols: number,
  opts: { blockSize?: number; northLat: number; dLat: number; dLon: number },
): EncodeResult {
  const bs = opts.blockSize ?? 240;
  const coef = fitPredictor(data, rows, cols);
  const nbr = blockCount(rows, bs);
  const nbc = blockCount(cols, bs);
  const kx2: number[] = [];
  const ky2: number[] = [];
  for (let br = 0; br < nbr; br++) {
    const [r0, r1] = blockRange(br, rows, bs);
    const lat = opts.northLat - ((r0 + r1) / 2) * opts.dLat;
    const { dx, dy } = sampleSpacing(lat, opts.dLat, opts.dLon);
    // ex ~ 4*dx*gx/UNIT, ey ~ 3*dy*gy/UNIT
    kx2.push((DEM_UNIT_M / (4 * dx)) ** 2);
    ky2.push((DEM_UNIT_M / (3 * dy)) ** 2);
  }
  // integer targets in units (closed-loop quantisation happens per sample)
  const run = (priors: Uint16Array | null) => {
    const blocks: Uint8Array[] = [];
    const counts = new Float64Array(N_CTX * 2);
    let maxErr = 0;
    let sumErr2 = 0;
    const stepHist = [0, 0, 0];
    const nb: Neigh = { pred: 0, step: 1, ctx: 0, sctx: 4 };
    for (let br = 0; br < nbr; br++) {
      const [r0, r1] = blockRange(br, rows, bs);
      for (let bc = 0; bc < nbc; bc++) {
        const [c0, c1] = blockRange(bc, cols, bs);
        const h = r1 - r0;
        const w = c1 - c0;
        const rec = new Int32Array(h * w);
        const errm = new Int32Array(h * w);
        const sgn = new Int8Array(h * w);
        const probs = new Uint16Array(N_CTX);
        if (priors) probs.set(priors); else probs.fill(PROB_INIT);
        const enc = new RangeEncoder(h * w);
        // bit statistics tap (for priors): wrap encodeBit
        const origEncodeBit = enc.encodeBit.bind(enc);
        if (!priors) {
          enc.encodeBit = (p: Uint16Array, i: number, bit: number) => {
            counts[i * 2 + bit]++;
            origEncodeBit(p, i, bit);
          };
        }
        for (let r = 0; r < h; r++) {
          for (let c = 0; c < w; c++) {
            neighbourhood(rec, errm, sgn, w, r, c, coef, kx2[br], ky2[br], nb);
            const target = data[(r0 + r) * cols + (c0 + c)] / DEM_UNIT_M;
            const q = Math.round((target - nb.pred) / nb.step);
            let v = nb.pred + q * nb.step;
            // keep the value representable in Int16 storage
            if (v > 32767 || v < -32768) throw new Error('elevation out of range');
            encodeResidual(enc, probs, nb.ctx, nb.sctx, q);
            rec[r * w + c] = v;
            errm[r * w + c] = Math.abs(q) * nb.step;
            sgn[r * w + c] = q > 0 ? 1 : q < 0 ? -1 : 0;
            const err = Math.abs(v - target) * DEM_UNIT_M;
            if (err > maxErr) maxErr = err;
            sumErr2 += err * err;
            stepHist[(STEP_SET as readonly number[]).indexOf(nb.step)]++;
          }
        }
        blocks.push(enc.finish());
      }
    }
    return { blocks, counts, maxErr, rms: Math.sqrt(sumErr2 / (rows * cols)), stepHist };
  };
  // pass 1: learn priors; pass 2: encode with priors
  const p1 = run(null);
  const priors = new Uint16Array(N_CTX);
  for (let i = 0; i < N_CTX; i++) {
    const c0 = p1.counts[i * 2];
    const c1 = p1.counts[i * 2 + 1];
    const p = Math.round(((c0 + 0.5) / (c0 + c1 + 1)) * 4096);
    priors[i] = Math.min(4032, Math.max(64, p));
  }
  const p2 = run(priors);
  return {
    params: { rows, cols, blockSize: bs, coef, kx2, ky2, priors: Array.from(priors) },
    blocks: p2.blocks,
    maxErrorM: p2.maxErr,
    rmsErrorM: p2.rms,
    stepHistogram: p2.stepHist,
  };
}

/** Decode one block into an Int16Array (height units of DEM_UNIT_M). */
export function decodeDemBlock(
  params: DemParams, br: number, bc: number, payload: Uint8Array, start = 0, end = payload.length,
): { data: Int16Array; r0: number; c0: number; h: number; w: number } {
  const [r0, r1] = blockRange(br, params.rows, params.blockSize);
  const [c0, c1] = blockRange(bc, params.cols, params.blockSize);
  const h = r1 - r0;
  const w = c1 - c0;
  const rec = new Int32Array(h * w);
  const errm = new Int32Array(h * w);
  const sgn = new Int8Array(h * w);
  const probs = new Uint16Array(params.priors);
  const dec = new RangeDecoder(payload, start, end);
  const nb: Neigh = { pred: 0, step: 1, ctx: 0, sctx: 4 };
  const kx2 = params.kx2[br];
  const ky2 = params.ky2[br];
  const coef = params.coef;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      neighbourhood(rec, errm, sgn, w, r, c, coef, kx2, ky2, nb);
      const q = decodeResidual(dec, probs, nb.ctx, nb.sctx);
      rec[r * w + c] = nb.pred + q * nb.step;
      errm[r * w + c] = Math.abs(q) * nb.step;
      sgn[r * w + c] = q > 0 ? 1 : q < 0 ? -1 : 0;
    }
  }
  return { data: Int16Array.from(rec), r0, c0, h, w };
}
