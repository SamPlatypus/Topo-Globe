/**
 * Ellipsoidal (WGS84) distance, bearing and area - Karney's algorithms via
 * GeographicLib (geographiclib-geodesic, MIT, by C. F. F. Karney).  Accurate to
 * ~15 nm for distances and to the round-off for areas; never flat-map maths.
 */
import * as GL from 'geographiclib-geodesic';

// The package is UMD/CommonJS; normalise default/namespace interop (Vite, Node, workers).
const lib: typeof GL = ((GL as unknown as { default?: typeof GL }).default ?? GL) as typeof GL;
const geod = lib.Geodesic.WGS84;

export interface InverseResult {
  /** distance in metres */
  s12: number;
  /** forward azimuth at point 1, degrees clockwise from true north (-180..180] */
  azi1: number;
  /** azimuth at point 2 (forward direction), degrees */
  azi2: number;
}

export function inverse(lat1: number, lon1: number, lat2: number, lon2: number): InverseResult {
  const r = geod.Inverse(lat1, lon1, lat2, lon2);
  return { s12: r.s12 ?? 0, azi1: r.azi1 ?? 0, azi2: r.azi2 ?? 0 };
}

export function direct(lat1: number, lon1: number, azi1: number, s12: number): { lat: number; lon: number; azi2: number } {
  const r = geod.Direct(lat1, lon1, azi1, s12);
  return { lat: r.lat2 ?? lat1, lon: r.lon2 ?? lon1, azi2: r.azi2 ?? azi1 };
}

/** Normalise an azimuth to [0, 360). */
export function bearing360(az: number): number {
  const b = az % 360;
  return b < 0 ? b + 360 : b;
}

/** Total geodesic length of a polyline [lon, lat][] in metres. */
export function pathLength(pts: [number, number][]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += inverse(pts[i - 1][1], pts[i - 1][0], pts[i][1], pts[i][0]).s12;
  return s;
}

/**
 * Area (m^2, always positive) and perimeter (m) of a closed polygon on the
 * ellipsoid, edges being geodesics.  Points as [lon, lat].
 */
export function polygonArea(pts: [number, number][]): { area: number; perimeter: number } {
  const p = geod.Polygon(false);
  for (const [lon, lat] of pts) p.AddPoint(lat, lon);
  const r = p.Compute(false, true);
  return { area: Math.abs(r.area ?? 0), perimeter: r.perimeter };
}

/**
 * Points every `step` metres along the geodesic from (lat1,lon1) to (lat2,lon2),
 * including both ends.  Returns [lon, lat, distanceFromStart][].
 */
export function sampleGeodesic(lat1: number, lon1: number, lat2: number, lon2: number, step: number): [number, number, number][] {
  const line = geod.InverseLine(lat1, lon1, lat2, lon2);
  const total = line.s13;
  const n = Math.max(1, Math.ceil(total / step));
  const out: [number, number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    const p = line.Position(s);
    out.push([p.lon2 ?? lon1, p.lat2 ?? lat1, s]);
  }
  return out;
}

/** Geodesic circle (accuracy ring) as a closed [lon, lat] ring. */
export function geodesicCircle(lat: number, lon: number, radius: number, segments = 64): [number, number][] {
  const ring: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const p = direct(lat, lon, (360 * i) / segments, radius);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}
