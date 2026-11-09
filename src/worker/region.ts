/**
 * Region data access inside the tile worker: lazy DEM block decoding with an
 * LRU cache, background overviews for low zooms, bilinear elevation, and
 * lazily decoded vector chunks.
 */
import { inflateSync } from 'fflate';
import { readRegion, type RegionMeta } from '../shared/regionfile';
import { decodeDemBlock, blockCount } from '../shared/demcodec';
import { decodeChunk, type DecodedChunk } from '../shared/vectorcodec';

const MAX_BLOCKS = 72;
const MAX_CHUNKS = 40;

class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  deletePrefix(p: string): void {
    for (const k of [...this.map.keys()]) if (k.startsWith(p)) this.map.delete(k);
  }
}

const blockCache = new Lru<Int16Array>(MAX_BLOCKS);
const chunkCache = new Lru<DecodedChunk>(MAX_CHUNKS);

export class Region {
  readonly key: string;
  readonly meta: RegionMeta;
  readonly buf: Uint8Array;
  readonly rows: number;
  readonly cols: number;
  readonly north: number;
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly dLat: number;
  readonly dLon: number;
  readonly unit: number;
  readonly bs: number;
  readonly nbr: number;
  readonly nbc: number;
  /** overviews: every 4th / 8th sample (box filtered), metres */
  ov4: Float32Array | null = null;
  ov8: Float32Array | null = null;
  readonly ov4w: number;
  readonly ov4h: number;
  readonly ov8w: number;
  readonly ov8h: number;
  private ovSum: Float32Array | null = null;
  private ovCnt: Uint16Array | null = null;
  private ovNext = 0;
  private names: string[] | null = null;

  constructor(key: string, buf: Uint8Array, verify: boolean) {
    this.key = key;
    this.buf = buf;
    this.meta = readRegion(buf, verify);
    const d = this.meta.dem;
    this.rows = d.params.rows;
    this.cols = d.params.cols;
    this.north = d.north;
    this.west = d.west;
    this.dLat = d.dLat;
    this.dLon = d.dLon;
    this.south = this.north - (this.rows - 1) * this.dLat;
    this.east = this.west + (this.cols - 1) * this.dLon;
    this.unit = d.unit;
    this.bs = d.params.blockSize;
    this.nbr = blockCount(this.rows, this.bs);
    this.nbc = blockCount(this.cols, this.bs);
    this.ov4w = Math.floor((this.cols - 1) / 4) + 1;
    this.ov4h = Math.floor((this.rows - 1) / 4) + 1;
    this.ov8w = Math.floor((this.cols - 1) / 8) + 1;
    this.ov8h = Math.floor((this.rows - 1) / 8) + 1;
  }

  dispose(): void {
    blockCache.deletePrefix(this.key + '/');
    chunkCache.deletePrefix(this.key + '/');
  }

  contains(lon: number, lat: number): boolean {
    return lon >= this.west - 1e-9 && lon <= this.east + 1e-9 && lat <= this.north + 1e-9 && lat >= this.south - 1e-9;
  }

  block(br: number, bc: number): Int16Array {
    const k = `${this.key}/${br}/${bc}`;
    let b = blockCache.get(k);
    if (!b) {
      const i = br * this.nbc + bc;
      const off = this.meta.sections.dem.offset;
      const offs = this.meta.dem.blockOffsets;
      b = decodeDemBlock(this.meta.dem.params, br, bc, this.buf, off + offs[i], off + offs[i + 1]).data;
      blockCache.set(k, b);
      this.feedOverview(br, bc, b);
    }
    return b;
  }

  /** height (metres) of grid sample (r, c) */
  sample(r: number, c: number): number {
    const bs = this.bs;
    const br = Math.min(this.nbr - 1, Math.floor(r / bs));
    const bc = Math.min(this.nbc - 1, Math.floor(c / bs));
    const b = this.block(br, bc);
    const r0 = br * bs, c0 = bc * bs;
    const w = bc === this.nbc - 1 ? this.cols - c0 : bs;
    return b[(r - r0) * w + (c - c0)] * this.unit;
  }

  /** Bilinear elevation at lon/lat from the full-resolution 1" grid. */
  elevation(lon: number, lat: number): number {
    const fr = (this.north - lat) / this.dLat;
    const fc = (lon - this.west) / this.dLon;
    if (fr < -1e-6 || fc < -1e-6 || fr > this.rows - 1 + 1e-6 || fc > this.cols - 1 + 1e-6) return NaN;
    let r0 = Math.floor(fr), c0 = Math.floor(fc);
    if (r0 >= this.rows - 1) r0 = this.rows - 2;
    if (c0 >= this.cols - 1) c0 = this.cols - 2;
    if (r0 < 0) r0 = 0;
    if (c0 < 0) c0 = 0;
    const tr = fr - r0, tc = fc - c0;
    const a = this.sample(r0, c0), b = this.sample(r0, c0 + 1), c = this.sample(r0 + 1, c0), d = this.sample(r0 + 1, c0 + 1);
    return (a * (1 - tc) + b * tc) * (1 - tr) + (c * (1 - tc) + d * tc) * tr;
  }

  /** Bilinear on an overview (4 or 8); falls back to full resolution until the overview is ready. */
  elevationLod(lon: number, lat: number, lod: 1 | 4 | 8): number {
    const ov = lod === 8 ? this.ov8 : lod === 4 ? this.ov4 : null;
    if (!ov) return this.elevation(lon, lat);
    const w = lod === 8 ? this.ov8w : this.ov4w;
    const h = lod === 8 ? this.ov8h : this.ov4h;
    const fr = (this.north - lat) / (this.dLat * lod);
    const fc = (lon - this.west) / (this.dLon * lod);
    if (fr < -1e-6 || fc < -1e-6 || fr > h - 1 + 1e-6 || fc > w - 1 + 1e-6) return NaN;
    let r0 = Math.floor(fr), c0 = Math.floor(fc);
    if (r0 >= h - 1) r0 = h - 2;
    if (c0 >= w - 1) c0 = w - 2;
    if (r0 < 0) r0 = 0;
    if (c0 < 0) c0 = 0;
    const tr = fr - r0, tc = fc - c0;
    const i = r0 * w + c0;
    return (ov[i] * (1 - tc) + ov[i + 1] * tc) * (1 - tr) + (ov[i + w] * (1 - tc) + ov[i + w + 1] * tc) * tr;
  }

  /** Value at a lattice point (global row/col on stride `s` lattice), metres, or NaN. */
  latticeValue(r: number, c: number, s: 1 | 2 | 4 | 8): number {
    if (r < 0 || c < 0 || r >= this.rows || c >= this.cols) return NaN;
    if (s === 4 && this.ov4) return this.ov4[(r / 4) * this.ov4w + c / 4];
    if (s === 8 && this.ov8) return this.ov8[(r / 8) * this.ov8w + c / 8];
    return this.sample(r, c);
  }

  get overviewsReady(): boolean {
    return this.ov4 !== null;
  }

  /** Decode one more block for the background overview pass. Returns false when done. */
  overviewStep(): boolean {
    if (this.ov4) return false;
    const total = this.nbr * this.nbc;
    if (this.ovNext >= total) return false;
    const i = this.ovNext;
    const br = Math.floor(i / this.nbc), bc = i % this.nbc;
    const cached = blockCache.get(`${this.key}/${br}/${bc}`);
    if (cached) this.feedOverview(br, bc, cached);
    else {
      // decode without caching, so the background pass does not evict blocks the visible tiles use
      const off = this.meta.sections.dem.offset;
      const offs = this.meta.dem.blockOffsets;
      this.feedOverview(br, bc, decodeDemBlock(this.meta.dem.params, br, bc, this.buf, off + offs[i], off + offs[i + 1]).data);
    }
    return !this.ov4;
  }

  private fed: Uint8Array | null = null;
  private feedOverview(br: number, bc: number, b: Int16Array): void {
    if (this.ov4) return;
    if (!this.ovSum) {
      this.ovSum = new Float32Array(this.ov4w * this.ov4h);
      this.ovCnt = new Uint16Array(this.ov4w * this.ov4h);
      this.fed = new Uint8Array(this.nbr * this.nbc);
    }
    const idx = br * this.nbc + bc;
    if (this.fed![idx]) return;
    this.fed![idx] = 1;
    const r0 = br * this.bs, c0 = bc * this.bs;
    const h = br === this.nbr - 1 ? this.rows - r0 : this.bs;
    const w = bc === this.nbc - 1 ? this.cols - c0 : this.bs;
    const sum = this.ovSum, cnt = this.ovCnt!;
    // each sample contributes to the nearest stride-4 lattice point (4x4 box filter)
    for (let r = 0; r < h; r++) {
      const R = Math.min(this.ov4h - 1, Math.floor((r0 + r + 2) / 4));
      for (let c = 0; c < w; c++) {
        const C = Math.min(this.ov4w - 1, Math.floor((c0 + c + 2) / 4));
        const k = R * this.ov4w + C;
        sum[k] += b[r * w + c] * this.unit;
        cnt[k]++;
      }
    }
    while (this.ovNext < this.nbr * this.nbc && this.fed![this.ovNext]) this.ovNext++;
    if (this.ovNext >= this.nbr * this.nbc) {
      const ov4 = new Float32Array(this.ov4w * this.ov4h);
      for (let k = 0; k < ov4.length; k++) ov4[k] = cnt[k] ? sum[k] / cnt[k] : 0;
      const ov8 = new Float32Array(this.ov8w * this.ov8h);
      for (let R = 0; R < this.ov8h; R++) {
        for (let C = 0; C < this.ov8w; C++) {
          let s = 0, n = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const rr = 2 * R + dr, cc = 2 * C + dc;
            if (rr < 0 || cc < 0 || rr >= this.ov4h || cc >= this.ov4w) continue;
            const wgt = (dr === 0 ? 2 : 1) * (dc === 0 ? 2 : 1);
            s += ov4[rr * this.ov4w + cc] * wgt;
            n += wgt;
          }
          ov8[R * this.ov8w + C] = s / n;
        }
      }
      this.ov4 = ov4;
      this.ov8 = ov8;
      this.ovSum = null;
      this.ovCnt = null;
    }
  }

  nameTable(): string[] {
    if (!this.names) {
      const s = this.meta.sections.names;
      const txt = new TextDecoder().decode(inflateSync(this.buf.subarray(s.offset, s.offset + s.length)));
      this.names = txt.length ? txt.split('\n') : [];
    }
    return this.names;
  }

  chunk(i: number): DecodedChunk {
    const k = `${this.key}/${i}`;
    let c = chunkCache.get(k);
    if (!c) {
      const ref = this.meta.vec.chunks[i];
      const off = this.meta.sections.vec.offset + ref.offset;
      c = decodeChunk(this.buf, off, off + ref.length);
      chunkCache.set(k, c);
    }
    return c;
  }

  /** chunk indices whose feature extent intersects a lon/lat box */
  chunksIn(w: number, s: number, e: number, n: number): number[] {
    const sc = this.meta.vec.scale;
    const out: number[] = [];
    this.meta.vec.chunks.forEach((c, i) => {
      if (!(c.roads + c.water + c.areas + c.pois)) return;
      const [x0, y0, x1, y1] = c.ext;
      if (x1 / sc < w || x0 / sc > e || y1 / sc < s || y0 / sc > n) return;
      out.push(i);
    });
    return out;
  }
}
