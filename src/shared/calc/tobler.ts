/**
 * Tobler's hiking function (Tobler 1993): walking speed on footpaths
 *   W = 6 * exp(-3.5 * |S + 0.05|)  km/h,  S = dh/dx (rise over horizontal run)
 * Fastest (6 km/h) on a gentle 5 % downhill; 5.04 km/h on the flat.
 */
export const TOBLER_MAX_KMH = 6;

export function toblerSpeedKmh(slope: number): number {
  return 6 * Math.exp(-3.5 * Math.abs(slope + 0.05));
}

/** Seconds to walk `horizontal` metres while climbing `dh` metres (dh < 0 = descending). */
export function toblerSeconds(horizontal: number, dh: number): number {
  if (horizontal <= 0) return dh === 0 ? 0 : Math.abs(dh) / ((toblerSpeedKmh(Math.sign(dh) * 10) * 1000) / 3600);
  const v = (toblerSpeedKmh(dh / horizontal) * 1000) / 3600; // m/s
  return horizontal / v;
}

export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
