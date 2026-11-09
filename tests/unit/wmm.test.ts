import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { magneticField } from '../../src/shared/geo/wmm';

const values: number[][] = JSON.parse(readFileSync(new URL('./wmm2025_testvalues.json', import.meta.url), 'utf8'));

test('WMM2025 matches all official test values', () => {
  assert.equal(values.length, 100);
  let worstD = 0, worstX = 0;
  for (const [year, altKm, lat, lon, D, I, Hh, X, Y, Z, F] of values) {
    const m = magneticField(lat, lon, altKm * 1000, year);
    worstD = Math.max(worstD, Math.abs(m.decl - D));
    worstX = Math.max(worstX, Math.abs(m.x - X), Math.abs(m.y - Y), Math.abs(m.z - Z));
    assert.ok(Math.abs(m.decl - D) < 0.01, `D at ${lat},${lon},${year}: ${m.decl} vs ${D}`);
    assert.ok(Math.abs(m.incl - I) < 0.01, `I at ${lat},${lon}`);
    assert.ok(Math.abs(m.x - X) < 0.1 && Math.abs(m.y - Y) < 0.1 && Math.abs(m.z - Z) < 0.1, `XYZ at ${lat},${lon}`);
    assert.ok(Math.abs(m.h - Hh) < 0.1 && Math.abs(m.f - F) < 0.1);
  }
  console.log(`worst |dD| ${worstD.toExponential(2)} deg, worst |dXYZ| ${worstX.toExponential(2)} nT`);
});

test('Melbourne declination is about 12 degrees east in late 2026', () => {
  const m = magneticField(-37.8136, 144.9631, 0, 2026.85);
  assert.ok(m.decl > 11 && m.decl < 13, String(m.decl));
});
