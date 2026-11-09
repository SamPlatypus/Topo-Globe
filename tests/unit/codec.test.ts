import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDem, decodeDemBlock, blockCount, DEM_UNIT_M } from '../../src/shared/demcodec';
import { encodeChunk, decodeChunk, type ChunkInput } from '../../src/shared/vectorcodec';
import { RangeEncoder, RangeDecoder, PROB_INIT } from '../../src/shared/rangecoder';
import { writeRegion, readRegion, RegionFormatError } from '../../src/shared/regionfile';
import { encodeTile, clipLine, clipRing, ringArea } from '../../src/shared/mvt';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';

test('range coder round trip', () => {
  const enc = new RangeEncoder(16);
  const probs = new Uint16Array(4).fill(PROB_INIT);
  const bits: number[] = [];
  let s = 12345;
  for (let i = 0; i < 20000; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bits.push(s % 7 === 0 ? 1 : 0); }
  for (let i = 0; i < bits.length; i++) enc.encodeBit(probs, i & 3, bits[i]);
  enc.encodeDirect(0xabcdef, 24);
  const buf = enc.finish();
  const dec = new RangeDecoder(buf);
  const p2 = new Uint16Array(4).fill(PROB_INIT);
  for (let i = 0; i < bits.length; i++) assert.equal(dec.decodeBit(p2, i & 3), bits[i]);
  assert.equal(dec.decodeDirect(24), 0xabcdef);
});

test('DEM codec: synthetic terrain within the slope-adaptive error bound', () => {
  const rows = 301, cols = 257;
  const data = new Float32Array(rows * cols);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const flat = c < 80; // flat zone, steep zone
    data[r * cols + c] = flat ? 12.3 + rnd() * 0.4 : 200 + Math.sin(r / 9) * 120 + c * 9 + rnd() * 3;
  }
  data[5] = -4.7;
  const res = encodeDem(data, rows, cols, { northLat: -37, dLat: 1 / 3600, dLon: 1 / 3600, blockSize: 120 });
  const nb = blockCount(rows, 120), nc = blockCount(cols, 120);
  assert.equal(res.blocks.length, nb * nc);
  let maxFlat = 0, maxAll = 0;
  for (let br = 0; br < nb; br++) for (let bc = 0; bc < nc; bc++) {
    const b = decodeDemBlock(res.params, br, bc, res.blocks[br * nc + bc]);
    for (let r = 0; r < b.h; r++) for (let c = 0; c < b.w; c++) {
      const cc = b.c0 + c;
      const err = Math.abs(b.data[r * b.w + c] * DEM_UNIT_M - data[(b.r0 + r) * cols + cc]);
      maxAll = Math.max(maxAll, err);
      if (cc > 2 && cc < 78 && b.r0 + r > 4) maxFlat = Math.max(maxFlat, err); // (a pit at row 0 makes its neighbourhood steep)
    }
  }
  assert.ok(maxFlat <= 0.25 + 1e-9, `flat error ${maxFlat}`);
  assert.ok(maxAll <= 1.0 + 1e-9, `max error ${maxAll}`);
});

test('vector chunk codec round trip', () => {
  const input: ChunkInput = {
    roads: [
      { a0: 8, a1: 8, a2: 2, name: 3, pts: [100, 200, 130, 260, 170, 300] },
      { a0: 5, a1: 0, a2: 0, name: -1, pts: [170, 300, 400, 300] },
      { a0: 7, a1: 1 | 32, a2: 0, name: 3, pts: [-50, -40, 100, 200] },
    ],
    water: [{ a0: 1, a1: 2, a2: 0, name: 0, pts: [0, 0, 5, 9, 11, 30, 2, 45] }],
    areas: [{ cls: 0, name: 7, rings: [[0, 0, 100, 0, 100, 100, 0, 100], [10, 10, 20, 10, 20, 20]] }],
    pois: [{ type: 1, name: 9, ele: 633.4, x: 55, y: 66 }, { type: 7, name: -1, ele: null, x: -5, y: 6 }],
  };
  const d = decodeChunk(encodeChunk(input));
  assert.equal(d.roads.n, 3);
  // order may change (continuity ordering) - compare as sets of point lists
  const lines = (s: typeof d.roads) => Array.from({ length: s.n }, (_, i) => Array.from(s.coords.subarray(s.offsets[i] * 2, s.offsets[i + 1] * 2)).join(',')).sort();
  const want = input.roads.map((r) => r.pts.join(','));
  const got = lines(d.roads);
  for (const w of want) {
    const rev: number[] = [];
    const p = w.split(',').map(Number);
    for (let k = p.length - 2; k >= 0; k -= 2) rev.push(p[k], p[k + 1]);
    assert.ok(got.includes(w) || got.includes(rev.join(',')), w);
  }
  assert.equal(d.water.n, 1);
  assert.deepEqual(Array.from(d.water.coords), input.water[0].pts);
  assert.equal(d.areas.n, 1);
  assert.equal(d.areas.featRings[1], 2);
  assert.equal(d.pois.n, 2);
  const peak = Array.from({ length: 2 }, (_, i) => i).find((i) => d.pois.type[i] === 1)!;
  assert.equal(d.pois.ele[peak], 633);
  assert.equal(d.pois.name[peak], 9);
});

test('region container detects truncation and corruption', () => {
  const meta = { format: 1, id: 'T', name: 't', bounds: [0, 0, 1, 1] as [number, number, number, number], created: '', sources: {}, credits: [], dem: {} as never, vec: {} as never };
  const f = writeRegion(meta, new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6]));
  const m = readRegion(f);
  assert.equal(m.id, 'T');
  assert.equal(f[m.sections.vec.offset + 1], 6);
  assert.throws(() => readRegion(f.subarray(0, f.length - 5)), RegionFormatError);
  const bad = f.slice();
  bad[m.sections.dem.offset] ^= 0xff;
  assert.throws(() => readRegion(bad), /damaged/);
});

test('MVT encoder output decodes with @mapbox/vector-tile', () => {
  const bytes = encodeTile([
    { name: 'contours', features: [{ type: 2, geom: [[0, 0, 100, 100, 200, 50]], props: { ele: 120, idx: 1 } }] },
    { name: 'water_areas', features: [{ type: 3, geom: [[0, 0, 0, 100, 100, 100, 100, 0]], props: { cls: 0 } }] },
    { name: 'pois', features: [{ type: 1, geom: [[10, 20]], props: { name: 'Mt Dandenong', ele: 633 } }] },
  ]);
  const vt = new VectorTile(new Pbf(bytes));
  assert.deepEqual(Object.keys(vt.layers).sort(), ['contours', 'pois', 'water_areas']);
  const c = vt.layers.contours.feature(0);
  assert.equal(c.properties.ele, 120);
  assert.deepEqual(c.loadGeometry()[0].map((p) => [p.x, p.y]), [[0, 0], [100, 100], [200, 50]]);
  const p = vt.layers.pois.feature(0);
  assert.equal(p.properties.name, 'Mt Dandenong');
  assert.equal(vt.layers.water_areas.feature(0).type, 3);
  assert.equal(clipLine([-10, 5, 50, 5], 0, 0, 20, 20)[0].join(','), '0,5,20,5');
  const ring = clipRing([-10, -10, 30, -10, 30, 30, -10, 30], 0, 0, 20, 20);
  assert.equal(Math.abs(ringArea(ring)), 400);
});
