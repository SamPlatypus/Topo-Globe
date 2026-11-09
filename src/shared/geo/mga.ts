/**
 * MGA2020 (Map Grid of Australia) - Transverse Mercator on the GRS80
 * ellipsoid using Krüger's n-series to 8th order (Karney 2011), as
 * recommended in the GDA2020 Technical Manual.  Accuracy is at the
 * nanometre level within a zone, far beyond what a phone needs.
 *
 * Zones: 54 (central meridian 141°E) and 55 (147°E) cover Victoria.
 * False easting 500 000 m, false northing 10 000 000 m, k0 = 0.9996.
 */

const a = 6378137.0;
const f = 1 / 298.257222101; // GRS80
const e2 = f * (2 - f);
const e = Math.sqrt(e2);
const n = f / (2 - f);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n, n7 = n6 * n, n8 = n7 * n;
const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256 + (25 * n8) / 16384);
const K0 = 0.9996;
const FE = 500000;
const FN = 10000000; // southern hemisphere

const alpha = [
  0,
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6 + (72161 / 387072) * n7 - (18975107 / 50803200) * n8,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6 + (13769 / 28800) * n7 + (148003883 / 174182400) * n8,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6 - (67102379 / 29030400) * n7 + (79682431 / 79833600) * n8,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6 + (97445 / 49896) * n7 - (40176129013 / 7664025600) * n8,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6 + (14644087 / 9123840) * n7 + (2605413599 / 622702080) * n8,
  (212378941 / 319334400) * n6 - (30705481 / 10378368) * n7 + (175214326799 / 58118860800) * n8,
  (1522256789 / 1383782400) * n7 - (16759934899 / 3113510400) * n8,
  (1424729850961 / 743921418240) * n8,
];
const beta = [
  0,
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6 - (5406467 / 38707200) * n7 + (7944359 / 67737600) * n8,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6 + (51841 / 1209600) * n7 + (24749483 / 348364800) * n8,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6 + (9261899 / 58060800) * n7 - (6457463 / 17740800) * n8,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6 + (466511 / 2494800) * n7 + (324154477 / 7664025600) * n8,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6 - (8005831 / 63866880) * n7 + (22894433 / 124540416) * n8,
  (20648693 / 638668800) * n6 - (16363163 / 518918400) * n7 - (2204645983 / 12915302400) * n8,
  (219941297 / 5535129600) * n7 - (497323811 / 12454041600) * n8,
  (191773887257 / 3719607091200) * n8,
];

const D2R = Math.PI / 180;

export function centralMeridian(zone: number): number {
  return zone * 6 - 183;
}

/** MGA zone for a longitude (54 west of 144°E, 55 from 144°E; general UTM rule). */
export function zoneFor(lonDeg: number): number {
  return Math.floor((lonDeg + 180) / 6) + 1;
}

function tauPrime(tau: number): number {
  const sig = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  return tau * Math.sqrt(1 + sig * sig) - sig * Math.sqrt(1 + tau * tau);
}

export interface GridPoint {
  zone: number;
  easting: number;
  northing: number;
  /** grid convergence in degrees (angle from true north to grid north, +ve when grid north is east of true north) */
  convergence: number;
  /** point scale factor */
  scale: number;
}

export function toGrid(latDeg: number, lonDeg: number, zone = zoneFor(lonDeg)): GridPoint {
  const phi = latDeg * D2R;
  const omega = (lonDeg - centralMeridian(zone)) * D2R;
  const tau = Math.tan(phi);
  const tp = tauPrime(tau);
  const cw = Math.cos(omega);
  const sw = Math.sin(omega);
  const xiP = Math.atan2(tp, cw);
  const etaP = Math.asinh(sw / Math.sqrt(tp * tp + cw * cw));
  let xi = xiP;
  let eta = etaP;
  let p = 1;
  let q = 0;
  for (let j = 1; j <= 8; j++) {
    const s2 = Math.sin(2 * j * xiP), c2 = Math.cos(2 * j * xiP);
    const sh = Math.sinh(2 * j * etaP), ch = Math.cosh(2 * j * etaP);
    xi += alpha[j] * s2 * ch;
    eta += alpha[j] * c2 * sh;
    p += 2 * j * alpha[j] * c2 * ch;
    q += 2 * j * alpha[j] * s2 * sh;
  }
  const x = K0 * A * eta;
  const y = K0 * A * xi;
  // convergence (Karney 2011 eq. 23)
  const gammaP = Math.atan((tp / Math.sqrt(1 + tp * tp)) * Math.tan(omega));
  const gammaPP = Math.atan2(q, p);
  const gamma = gammaP + gammaPP;
  // point scale (eq. 25)
  const sinPhi = Math.sin(phi);
  const k = K0 * (A / a) * Math.sqrt(p * p + q * q) * (Math.sqrt(1 + tau * tau) * Math.sqrt(1 - e2 * sinPhi * sinPhi)) / Math.sqrt(tp * tp + cw * cw);
  return { zone, easting: FE + x, northing: FN + y, convergence: gamma / D2R, scale: k };
}

export function fromGrid(zone: number, easting: number, northing: number): { lat: number; lon: number } {
  const xi = (northing - FN) / (K0 * A);
  const eta = (easting - FE) / (K0 * A);
  let xiP = xi;
  let etaP = eta;
  for (let j = 1; j <= 8; j++) {
    xiP -= beta[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaP -= beta[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta = Math.sinh(etaP);
  const tp = Math.sin(xiP) / Math.sqrt(sinhEta * sinhEta + Math.cos(xiP) ** 2);
  const omega = Math.atan2(sinhEta, Math.cos(xiP));
  // Newton iteration for tau from tau'
  let tau = tp;
  for (let i = 0; i < 6; i++) {
    const tpi = tauPrime(tau);
    const d = ((tp - tpi) / Math.sqrt(1 + tpi * tpi)) * ((1 + (1 - e2) * tau * tau) / ((1 - e2) * Math.sqrt(1 + tau * tau)));
    tau += d;
    if (Math.abs(d) < 1e-14) break;
  }
  return { lat: Math.atan(tau) / D2R, lon: centralMeridian(zone) + omega / D2R };
}

// ---------------------------------------------------------------- MGRS-style grid references
const BAND = 'CDEFGHJKLMNPQRSTUVWX';
const COLS = ['STUVWXYZ', 'ABCDEFGH', 'JKLMNPQR'];
const ROWS = 'ABCDEFGHJKLMNPQRSTUV';

export function latBand(latDeg: number): string {
  const i = Math.floor((latDeg + 80) / 8);
  return BAND[Math.max(0, Math.min(BAND.length - 1, i))];
}

/** 100 km square identifier, e.g. "CU" (AA lettering scheme, used with GRS80/WGS84). */
export function square100k(zone: number, easting: number, northing: number): string {
  const set = zone % 3; // column sets repeat every 3 zones
  const col = COLS[set][Math.floor(easting / 100000) - 1] ?? '?';
  const rowIndex = (Math.floor(northing / 100000) + (zone % 2 === 0 ? 5 : 0)) % 20;
  return col + ROWS[rowIndex];
}

export interface GridRef {
  zone: number;
  band: string;
  square: string;
  easting: number;
  northing: number;
  convergence: number;
  scale: number;
  /** "55H CU 2071 1283" (10 m) */
  ref8: string;
  /** "GR 207 128 (CU)" 6-figure (100 m) as printed on 1:25k topographic maps */
  ref6: string;
  /** "MGA55 320 712 E 5 812 836 N" */
  full: string;
}

function group3(v: number): string {
  const s = Math.floor(v).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function gridRef(latDeg: number, lonDeg: number, zone = zoneFor(lonDeg)): GridRef {
  const g = toGrid(latDeg, lonDeg, zone);
  const band = latBand(latDeg);
  const sq = square100k(zone, g.easting, g.northing);
  const e5 = Math.floor(g.easting) % 100000;
  const n5 = Math.floor(g.northing) % 100000;
  const p4 = (v: number) => Math.floor(v / 10).toString().padStart(4, '0');
  const p3 = (v: number) => Math.floor(v / 100).toString().padStart(3, '0');
  return {
    zone, band, square: sq, easting: g.easting, northing: g.northing, convergence: g.convergence, scale: g.scale,
    ref8: `${zone}${band} ${sq} ${p4(e5)} ${p4(n5)}`,
    ref6: `GR ${p3(e5)} ${p3(n5)} (${sq})`,
    full: `MGA${zone} ${group3(g.easting)} E ${group3(g.northing)} N`,
  };
}
