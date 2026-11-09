/**
 * World Magnetic Model (WMM2025) spherical-harmonic synthesis.
 *
 * Implements the algorithm of the WMM technical report (NOAA/BGS):
 * geodetic -> geocentric conversion on WGS84, secular variation to the
 * requested decimal year, Schmidt semi-normalised associated Legendre
 * functions to degree 12, field components in geocentric spherical
 * coordinates rotated back to the geodetic frame.  Verified against the
 * official WMM2025 test values (tests/unit/wmm.test.ts).
 */
import { WMM_COEFFS, WMM_EPOCH, WMM_MAX_N, WMM_VALID_FROM, WMM_VALID_TO } from './wmm2025';

const A_WGS84 = 6378137.0;
const F_WGS84 = 1 / 298.257223563;
const E2 = F_WGS84 * (2 - F_WGS84);
const RE = 6371200.0; // geomagnetic reference radius (m)
const NMAX = WMM_MAX_N;

const G = new Float64Array((NMAX + 1) * (NMAX + 1));
const H = new Float64Array((NMAX + 1) * (NMAX + 1));
const GD = new Float64Array((NMAX + 1) * (NMAX + 1));
const HD = new Float64Array((NMAX + 1) * (NMAX + 1));
for (let i = 0; i < WMM_COEFFS.length; i += 6) {
  const n = WMM_COEFFS[i];
  const m = WMM_COEFFS[i + 1];
  const k = n * (NMAX + 1) + m;
  G[k] = WMM_COEFFS[i + 2];
  H[k] = WMM_COEFFS[i + 3];
  GD[k] = WMM_COEFFS[i + 4];
  HD[k] = WMM_COEFFS[i + 5];
}

export interface MagField {
  /** declination, degrees east of true north */
  decl: number;
  /** inclination (dip), degrees, positive down */
  incl: number;
  /** north, east, down components and totals, nT */
  x: number;
  y: number;
  z: number;
  h: number;
  f: number;
  /** grid variation is computed by callers (declination minus grid convergence) */
  model: string;
  /** true when the date is outside the model's validity window */
  outOfRange: boolean;
}

/** Decimal year of a JS Date (UTC). */
export function decimalYear(d: Date): number {
  const y = d.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - start) / (end - start);
}

/**
 * Magnetic field at geodetic latitude/longitude (degrees), height above the
 * WGS84 ellipsoid (metres) and decimal year.
 */
export function magneticField(latDeg: number, lonDeg: number, heightM: number, year: number): MagField {
  const phi = (latDeg * Math.PI) / 180;
  const lam = (lonDeg * Math.PI) / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  // geodetic -> geocentric spherical
  const rc = A_WGS84 / Math.sqrt(1 - E2 * sinPhi * sinPhi);
  const p = (rc + heightM) * cosPhi;
  const zc = (rc * (1 - E2) + heightM) * sinPhi;
  const r = Math.sqrt(p * p + zc * zc);
  const phiC = Math.asin(zc / r);
  const dt = year - WMM_EPOCH;

  // Schmidt semi-normalised P_n^m(sin phiC) and dP/dphiC via the standard recursions
  // (theta = geocentric colatitude: cos(theta) = sin(phiC), sin(theta) = cos(phiC))
  const ct = Math.sin(phiC);
  const st = Math.cos(phiC);
  const N1 = NMAX + 1;
  const P = new Float64Array(N1 * N1);
  const dP = new Float64Array(N1 * N1);
  P[0] = 1;
  dP[0] = 0;
  for (let n = 1; n <= NMAX; n++) {
    for (let m = 0; m <= n; m++) {
      const k = n * N1 + m;
      if (n === m) {
        const km = (n - 1) * N1 + (m - 1);
        P[k] = st * P[km];
        dP[k] = st * dP[km] + ct * P[km];
      } else if (n === 1 && m === 0) {
        P[k] = ct * P[0];
        dP[k] = ct * dP[0] - st * P[0];
      } else {
        const k1 = (n - 1) * N1 + m;
        const k2 = (n - 2) * N1 + m;
        const kk = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        const p2 = m > n - 2 ? 0 : P[k2];
        const dp2 = m > n - 2 ? 0 : dP[k2];
        P[k] = ct * P[k1] - kk * p2;
        dP[k] = ct * dP[k1] - st * P[k1] - kk * dp2;
      }
    }
  }
  // Gauss -> Schmidt normalisation factors
  const S = new Float64Array(N1 * N1);
  S[0] = 1;
  for (let n = 1; n <= NMAX; n++) {
    S[n * N1] = (S[(n - 1) * N1] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) {
      const j = m === 1 ? 2 : 1;
      S[n * N1 + m] = S[n * N1 + m - 1] * Math.sqrt(((n - m + 1) * j) / (n + m));
    }
  }
  let br = 0; // radial (outward)
  let bt = 0; // theta (southward)
  let bp = 0; // phi (eastward), before division by sin(theta)
  const ar0 = RE / r;
  let arn = ar0 * ar0; // (a/r)^(n+2) built up
  for (let n = 1; n <= NMAX; n++) {
    arn *= ar0;
    for (let m = 0; m <= n; m++) {
      const k = n * N1 + m;
      const g = (G[k] + dt * GD[k]) * S[k];
      const h = (H[k] + dt * HD[k]) * S[k];
      const cm = Math.cos(m * lam);
      const sm = Math.sin(m * lam);
      const t1 = g * cm + h * sm;
      const t2 = g * sm - h * cm;
      br += (n + 1) * arn * t1 * P[k];
      bt -= arn * t1 * dP[k];
      bp += m * arn * t2 * P[k];
    }
  }
  let bphi: number;
  if (Math.abs(st) > 1e-10) bphi = bp / st;
  else bphi = 0; // geographic poles: declination undefined
  // geocentric spherical components (north, east, down)
  const xs = -bt;
  const ys = bphi;
  const zs = -br;
  // rotate to geodetic
  const psi = phiC - phi;
  const x = xs * Math.cos(psi) - zs * Math.sin(psi);
  const y = ys;
  const z = xs * Math.sin(psi) + zs * Math.cos(psi);
  const hh = Math.sqrt(x * x + y * y);
  const f = Math.sqrt(hh * hh + z * z);
  return {
    decl: (Math.atan2(y, x) * 180) / Math.PI,
    incl: (Math.atan2(z, hh) * 180) / Math.PI,
    x, y, z, h: hh, f,
    model: 'WMM2025',
    outOfRange: year < WMM_VALID_FROM || year > WMM_VALID_TO,
  };
}

/** Magnetic declination (degrees, east positive) for a date. */
export function declination(latDeg: number, lonDeg: number, heightM: number, date: Date): number {
  return magneticField(latDeg, lonDeg, heightM, decimalYear(date)).decl;
}
