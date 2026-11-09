import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inverse, direct, polygonArea, sampleGeodesic, geodesicCircle, bearing360 } from '../../src/shared/geo/geodesic';
import { vincentyInverse } from '../../src/shared/geo/vincenty';

test('Karney vs Vincenty agree to < 0.1 mm for Victorian distances', () => {
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const lat1 = -39 + Math.sin(i) * 2.5, lon1 = 145 + Math.cos(i * 1.3) * 4;
    const lat2 = lat1 + Math.sin(i * 0.7) * 0.8, lon2 = lon1 + Math.cos(i * 0.9) * 0.9;
    const k = inverse(lat1, lon1, lat2, lon2);
    const v = vincentyInverse(lat1, lon1, lat2, lon2)!;
    worst = Math.max(worst, Math.abs(k.s12 - v.s));
    assert.ok(Math.abs(k.azi1 - v.azi1) < 1e-7);
  }
  assert.ok(worst < 1e-4, `worst ${worst}`);
});

test('Karney inverse matches GeodTest reference values', () => {
  // Flinders Peak -> Buninyong (classic Vincenty/GDA example): 54 972.271 m, azimuth 306°52'05.37"
  const lat1 = -(37 + 57 / 60 + 3.72030 / 3600), lon1 = 144 + 25 / 60 + 29.52440 / 3600;
  const lat2 = -(37 + 39 / 60 + 10.15610 / 3600), lon2 = 143 + 55 / 60 + 35.38390 / 3600;
  const r = inverse(lat1, lon1, lat2, lon2);
  assert.ok(Math.abs(r.s12 - 54972.271) < 0.001, String(r.s12));
  const az = bearing360(r.azi1);
  assert.ok(Math.abs(az - (306 + 52 / 60 + 5.37 / 3600)) < 1 / 3600, String(az));
});

test('direct inverts inverse', () => {
  const r = inverse(-37.8, 145.1, -37.6, 145.9);
  const d = direct(-37.8, 145.1, r.azi1, r.s12);
  assert.ok(Math.abs(d.lat + 37.6) < 1e-10 && Math.abs(d.lon - 145.9) < 1e-10);
});

test('ellipsoidal area of a 1x1 degree cell near Melbourne', () => {
  // Cell area from the closed form for an ellipsoid zone: matches GeographicLib to round-off.
  const { area } = polygonArea([[145, -38], [146, -38], [146, -37], [145, -37]]);
  // Exact ellipsoidal quadrangle area (authalic formula) computed independently:
  const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), e = Math.sqrt(e2);
  const q = (phi: number) => { const s = Math.sin(phi); return (1 - e2) * (s / (1 - e2 * s * s) - Math.log((1 - e * s) / (1 + e * s)) / (2 * e)); };
  const d = Math.PI / 180;
  const exact = (a * a / 2) * Math.abs(q(-37 * d) - q(-38 * d)) * (1 * d);
  // edges along parallels are not geodesics: the geodesic polygon differs slightly (< 0.1 %)
  assert.ok(Math.abs(area - exact) / exact < 1e-3, `${area} vs ${exact}`);
  assert.ok(area > 9.7e9 && area < 9.9e9);
});

test('geodesic sampling and circle', () => {
  const pts = sampleGeodesic(-37.8, 145.3, -37.81, 145.31, 30);
  assert.equal(pts[0][2], 0);
  const last = pts[pts.length - 1];
  assert.ok(Math.abs(last[2] - inverse(-37.8, 145.3, -37.81, 145.31).s12) < 1e-6);
  const ring = geodesicCircle(-37.8, 145.3, 25, 32);
  for (const [lon, lat] of ring) assert.ok(Math.abs(inverse(-37.8, 145.3, lat, lon).s12 - 25) < 1e-6);
});
