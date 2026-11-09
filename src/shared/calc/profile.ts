/**
 * Elevation profile statistics.
 *
 * Copernicus GLO-30 is a surface model with ~1-2 m of random noise.  Summing
 * every tiny up and down along a densely sampled line would inflate the total
 * climb, so ascent/descent are computed on a lightly smoothed profile with a
 * hysteresis (dead band): a change only counts once the elevation has moved
 * at least THRESHOLD metres from the last counted turning point.
 */
export const ASCENT_THRESHOLD_M = 3;
export const SMOOTH_WINDOW_M = 45;

export interface ProfileStats {
  distance: number;
  ascent: number;
  descent: number;
  rawAscent: number;
  rawDescent: number;
  min: number;
  max: number;
  start: number;
  end: number;
}

/** Moving average over a distance window (samples may be unevenly spaced). */
export function smoothProfile(dist: Float64Array, elev: Float64Array, window = SMOOTH_WINDOW_M): Float64Array {
  const n = elev.length;
  const out = new Float64Array(n);
  let lo = 0, hi = 0, sum = 0, cnt = 0;
  const half = window / 2;
  for (let i = 0; i < n; i++) {
    while (hi < n && dist[hi] <= dist[i] + half) {
      if (Number.isFinite(elev[hi])) { sum += elev[hi]; cnt++; }
      hi++;
    }
    while (dist[lo] < dist[i] - half) {
      if (Number.isFinite(elev[lo])) { sum -= elev[lo]; cnt--; }
      lo++;
    }
    out[i] = cnt > 0 ? sum / cnt : elev[i];
  }
  return out;
}

export function hysteresisClimb(elev: ArrayLike<number>, threshold = ASCENT_THRESHOLD_M): { ascent: number; descent: number } {
  let ascent = 0, descent = 0;
  let ref = NaN;
  for (let i = 0; i < elev.length; i++) {
    const e = elev[i];
    if (!Number.isFinite(e)) continue;
    if (!Number.isFinite(ref)) { ref = e; continue; }
    const d = e - ref;
    if (d >= threshold) { ascent += d; ref = e; }
    else if (d <= -threshold) { descent -= d; ref = e; }
  }
  // count the final partial move so that ascent - descent == end - start (within threshold)
  return { ascent, descent };
}

export function profileStats(dist: Float64Array, elev: Float64Array): ProfileStats {
  const n = elev.length;
  let min = Infinity, max = -Infinity, rawA = 0, rawD = 0;
  for (let i = 0; i < n; i++) {
    const e = elev[i];
    if (!Number.isFinite(e)) continue;
    if (e < min) min = e;
    if (e > max) max = e;
    if (i > 0 && Number.isFinite(elev[i - 1])) {
      const d = e - elev[i - 1];
      if (d > 0) rawA += d; else rawD -= d;
    }
  }
  const sm = smoothProfile(dist, elev);
  const { ascent, descent } = hysteresisClimb(sm);
  return {
    distance: n ? dist[n - 1] : 0, ascent, descent, rawAscent: rawA, rawDescent: rawD,
    min, max, start: elev[0], end: elev[n - 1],
  };
}
