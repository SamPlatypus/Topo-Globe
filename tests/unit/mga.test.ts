import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toGrid, fromGrid, gridRef, zoneFor, square100k } from '../../src/shared/geo/mga';
import { inverse } from '../../src/shared/geo/geodesic';

const vectors: { zone: number; lat: number; lon: number; E: number; N: number }[] =
  JSON.parse(readFileSync(new URL('./mga_proj_vectors.json', import.meta.url), 'utf8'));

test('Flinders Peak (GDA2020 Technical Manual example) to MGA55', () => {
  const lat = -(37 + 57 / 60 + 3.7203 / 3600);
  const lon = 144 + 25 / 60 + 29.5244 / 3600;
  const g = toGrid(lat, lon, 55);
  assert.ok(Math.abs(g.easting - 273741.297) < 0.001, String(g.easting));
  assert.ok(Math.abs(g.northing - 5796489.777) < 0.001, String(g.northing));
  assert.ok(Math.abs(g.scale - 1.00023056) < 1e-7, String(g.scale));
  assert.ok(Math.abs(g.convergence - 1.58434646) < 1e-6, String(g.convergence));
});

test('forward projection matches PROJ (EPSG:7844 -> 7854/7855) to < 1 mm', () => {
  let worst = 0;
  for (const v of vectors) {
    const g = toGrid(v.lat, v.lon, v.zone);
    worst = Math.max(worst, Math.abs(g.easting - v.E), Math.abs(g.northing - v.N));
  }
  assert.ok(worst < 0.001, `worst ${worst} m`);
});

test('inverse projection round-trips to < 1e-9 degree', () => {
  for (const v of vectors) {
    const p = fromGrid(v.zone, v.E, v.N);
    assert.ok(Math.abs(p.lat - v.lat) < 1e-9 && Math.abs(p.lon - v.lon) < 1e-9, `${p.lat},${p.lon} vs ${v.lat},${v.lon}`);
  }
});

test('zones and 100 km squares', () => {
  assert.equal(zoneFor(143.9), 54);
  assert.equal(zoneFor(144.0), 55);
  const r = gridRef(-37.8136, 144.9631); // Melbourne GPO area
  assert.equal(r.zone, 55);
  assert.equal(r.band, 'H');
  assert.equal(r.square, 'CU');
  assert.match(r.ref6, /^GR \d{3} \d{3} \(CU\)$/);
  assert.equal(square100k(54, 650000, 5900000).length, 2);
});

test('grid bearing = true bearing - convergence (checked against projected coordinates)', () => {
  const lat1 = -37.5, lon1 = 145.9;
  const lat2 = -37.49, lon2 = 145.915;
  const g1 = toGrid(lat1, lon1, 55), g2 = toGrid(lat2, lon2, 55);
  const gridBearing = (Math.atan2(g2.easting - g1.easting, g2.northing - g1.northing) * 180) / Math.PI;
  const inv = inverse(lat1, lon1, lat2, lon2);
  const midConv = toGrid((lat1 + lat2) / 2, (lon1 + lon2) / 2, 55).convergence;
  const predicted = inv.azi1 - midConv;
  assert.ok(Math.abs(gridBearing - predicted) < 0.01, `${gridBearing} vs ${predicted}`);
});
