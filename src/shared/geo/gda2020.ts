/**
 * GDA2020 <-> ATRF2014 (time-dependent) via the Australian Plate Motion Model.
 *
 * Phones report positions in WGS84 (G2296 ~ ITRF2020 ~ ATRF2014 at the epoch of
 * observation).  GDA2020 coordinates are fixed to the plate at epoch 2020.0, and
 * the Australian plate moves ~6-7 cm/yr north-north-east, so by late 2026 a raw
 * GPS position sits ~0.45 m NNE of its GDA2020 (MGA2020) coordinate.  The
 * model is a rotation about the plate's Euler pole (ICSM GDA2020 Technical
 * Manual, Plate Motion Model): w = (1.50379, 1.18346, 1.20716) mas/yr.
 */
const MAS = (Math.PI / 180 / 3600) * 1e-3;
const WX = 1.50379 * MAS, WY = 1.18346 * MAS, WZ = 1.20716 * MAS; // rad/yr
const a = 6378137.0;
const f = 1 / 298.257222101;
const e2 = f * (2 - f);
const D = Math.PI / 180;

function toEcef(lat: number, lon: number, h: number): [number, number, number] {
  const sp = Math.sin(lat * D), cp = Math.cos(lat * D);
  const N = a / Math.sqrt(1 - e2 * sp * sp);
  return [(N + h) * cp * Math.cos(lon * D), (N + h) * cp * Math.sin(lon * D), (N * (1 - e2) + h) * sp];
}

function fromEcef(x: number, y: number, z: number): [number, number, number] {
  const lon = Math.atan2(y, x);
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  let h = 0;
  for (let i = 0; i < 6; i++) {
    const sp = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sp * sp);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (e2 * N) / (N + h)));
  }
  return [lat / D, lon / D, h];
}

/** Plate velocity (m/yr) at a point, ECEF. */
function velocity(x: number, y: number, z: number): [number, number, number] {
  return [WY * z - WZ * y, WZ * x - WX * z, WX * y - WY * x];
}

/** Convert an ATRF2014/WGS84 position observed at `epoch` (decimal year) to GDA2020. */
export function atrfToGda2020(lat: number, lon: number, epoch: number, h = 0): { lat: number; lon: number } {
  const [x, y, z] = toEcef(lat, lon, h);
  const dt = epoch - 2020.0;
  const [vx, vy, vz] = velocity(x, y, z);
  const [la, lo] = fromEcef(x - vx * dt, y - vy * dt, z - vz * dt);
  return { lat: la, lon: lo };
}

/** Convert a GDA2020 position to ATRF2014/WGS84 at `epoch`. */
export function gda2020ToAtrf(lat: number, lon: number, epoch: number, h = 0): { lat: number; lon: number } {
  const [x, y, z] = toEcef(lat, lon, h);
  const dt = epoch - 2020.0;
  const [vx, vy, vz] = velocity(x, y, z);
  const [la, lo] = fromEcef(x + vx * dt, y + vy * dt, z + vz * dt);
  return { lat: la, lon: lo };
}
