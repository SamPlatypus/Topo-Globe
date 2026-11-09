import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toblerSpeedKmh, toblerSeconds } from '../../src/shared/calc/tobler';
import { hysteresisClimb, profileStats } from '../../src/shared/calc/profile';
import { marchingSquares, simplifyLine, contourIntervals } from '../../src/shared/calc/contours';
import { RoadGraph, type RoadInput } from '../../src/shared/calc/routing';
import { atrfToGda2020, gda2020ToAtrf } from '../../src/shared/geo/gda2020';
import { inverse } from '../../src/shared/geo/geodesic';

test("Tobler's hiking function", () => {
  assert.ok(Math.abs(toblerSpeedKmh(-0.05) - 6) < 1e-12);
  assert.ok(Math.abs(toblerSpeedKmh(0) - 5.036742) < 1e-5);
  assert.ok(toblerSpeedKmh(0.2) < toblerSpeedKmh(-0.2));
  // 1 km flat ~ 11.9 min
  assert.ok(Math.abs(toblerSeconds(1000, 0) / 60 - 11.91) < 0.05);
});

test('hysteresis climb ignores noise but counts real hills', () => {
  const noisy = Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i * 1.7) * 1.2);
  assert.equal(hysteresisClimb(noisy).ascent, 0);
  const hill = Array.from({ length: 200 }, (_, i) => 100 + (i < 100 ? i : 200 - i) + Math.sin(i * 2.1));
  const r = hysteresisClimb(hill);
  assert.ok(r.ascent > 95 && r.ascent < 103, String(r.ascent));
  assert.ok(r.descent > 95 && r.descent < 103, String(r.descent));
  const d = Float64Array.from({ length: 200 }, (_, i) => i * 15);
  const st = profileStats(d, Float64Array.from(hill));
  assert.ok(st.rawAscent > st.ascent);
});

test('marching squares: cone gives closed rings at the right radius', () => {
  const w = 101, h = 101;
  const g = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) g[r * w + c] = 100 - Math.hypot(r - 50, c - 50);
  const lines = marchingSquares(g, w, h, [80, 60]);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.ok(l.closed, 'closed');
    const rad = 100 - l.level;
    for (let i = 0; i < l.pts.length; i += 2) {
      const d = Math.hypot(l.pts[i] - 50, l.pts[i + 1] - 50);
      assert.ok(Math.abs(d - rad) < 0.35, `radius ${d} vs ${rad}`);
    }
  }
});

test('marching squares: inclined plane gives one straight open line per level', () => {
  const w = 30, h = 20;
  const g = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) g[r * w + c] = c * 2 + 0.5;
  const lines = marchingSquares(g, w, h, [10, 20, 30]);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.ok(!l.closed);
    assert.equal(l.pts.length / 2, h);
    const s = simplifyLine(l.pts, 0.01);
    assert.equal(s.length, 4);
  }
  assert.deepEqual(contourIntervals(14), { minor: 10, major: 50 });
  assert.equal(contourIntervals(9), null);
});

test('marching squares: saddle cells produce consistent, non-crossing segments', () => {
  const w = 3, h = 3;
  const g = Float32Array.from([10, 0, 10, 0, 6, 0, 10, 0, 10]);
  const lines = marchingSquares(g, w, h, [5]);
  // centre (6) is high -> the high corners connect through the centre: 4 open arcs around the low points
  let total = 0;
  for (const l of lines) total += l.pts.length / 2 - 1;
  assert.equal(total, 8);
});

test('A* finds the faster (flatter) route and respects access', () => {
  const S = 50000; // grid units per degree
  const lat0 = -37.5, lon0 = 145.5;
  const P = (dx: number, dy: number) => [Math.round((lon0 + dx) * S), Math.round((lat0 + dy) * S)];
  // two routes from A to B: straight over a hill, or a longer flat detour
  const A = P(0, 0), B = P(0.02, 0), M1 = P(0.01, 0), D1 = P(0.005, 0.006), D2 = P(0.015, 0.006);
  const chains = [
    [A, M1, B], // over the hill
    [A, D1, D2, B], // detour
  ];
  const coords: number[] = [];
  const offsets = [0];
  for (const c of chains) { for (const p of c) coords.push(...p); offsets.push(coords.length / 2); }
  const input: RoadInput = {
    coords: Int32Array.from(coords), offsets: Uint32Array.from(offsets),
    cls: Uint8Array.from([8, 8]), flags: Uint8Array.from([0, 0]), name: Int32Array.from([0, 1]), names: ['Hill Track', 'Valley Path'], n: 2,
  };
  const hill = (lon: number, lat: number) => {
    const d = Math.hypot((lon - (lon0 + 0.01)) * 88000, (lat - lat0) * 111000);
    return 100 + Math.max(0, 600 - d * 1.2); // 600 m high cone at M1
  };
  const g = new RoadGraph([input], S, hill);
  const r = g.route(lon0 + 0.0001, lat0, lon0 + 0.0199, lat0);
  assert.ok(!('error' in r));
  if (!('error' in r)) {
    assert.ok(r.legs.some((l) => l.name === 'Valley Path'), JSON.stringify(r.legs));
    const flat = new RoadGraph([input], S, () => 100);
    const r2 = flat.route(lon0 + 0.0001, lat0, lon0 + 0.0199, lat0);
    if (!('error' in r2)) assert.equal(r2.legs[0].name, 'Hill Track');
  }
  // private / no-foot ways are not used
  const priv = { ...input, flags: Uint8Array.from([16, 4]) };
  const g3 = new RoadGraph([priv], S, () => 0);
  const r3 = g3.route(lon0, lat0, lon0 + 0.02, lat0);
  assert.ok('error' in r3);
});

test('plate motion: GDA2020 vs ATRF2014 at 2026.85 is ~0.4 m NNE near Melbourne', () => {
  const g = { lat: -37.8, lon: 145.0 };
  const a = gda2020ToAtrf(g.lat, g.lon, 2026.85);
  const inv = inverse(g.lat, g.lon, a.lat, a.lon);
  assert.ok(inv.s12 > 0.35 && inv.s12 < 0.5, String(inv.s12));
  assert.ok(inv.azi1 > 5 && inv.azi1 < 30, String(inv.azi1)); // north-north-east
  const back = atrfToGda2020(a.lat, a.lon, 2026.85);
  assert.ok(Math.abs(back.lat - g.lat) < 1e-10 && Math.abs(back.lon - g.lon) < 1e-10);
});

test('routes join across neighbouring regions through their shared boundary node', () => {
  const S = 50000;
  const P = (lon: number, lat: number) => [Math.round(lon * S), Math.round(lat * S)];
  // region A (west of 146 E) and region B (east of it) each hold their half of a track;
  // both files contain the boundary-crossing segment, so the vertex at 146.0005 appears in both
  const a: RoadInput = {
    coords: Int32Array.from([...P(145.99, -37.6), ...P(145.9995, -37.6), ...P(146.0005, -37.6)]),
    offsets: Uint32Array.from([0, 3]), cls: Uint8Array.from([7]), flags: Uint8Array.from([0]), name: Int32Array.from([0]), names: ['Boundary Track'], n: 1,
  };
  const b: RoadInput = {
    coords: Int32Array.from([...P(145.9995, -37.6), ...P(146.0005, -37.6), ...P(146.01, -37.6)]),
    offsets: Uint32Array.from([0, 3]), cls: Uint8Array.from([7]), flags: Uint8Array.from([0]), name: Int32Array.from([0]), names: ['Boundary Track'], n: 1,
  };
  const g = new RoadGraph([a, b], S, () => 100);
  const r = g.route(145.99, -37.6, 146.01, -37.6);
  assert.ok(!('error' in r), JSON.stringify(r));
  if (!('error' in r)) {
    assert.ok(r.coords[0][0] < 146 && r.coords[r.coords.length - 1][0] > 146);
    const metres = r.legs.reduce((s, l) => s + l.metres, 0);
    assert.ok(Math.abs(metres - 1764) < 15, String(metres)); // 0.02 deg of longitude at 37.6 S
  }
});
