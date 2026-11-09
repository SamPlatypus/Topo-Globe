/**
 * Adaptive binary range coder (LZMA style, carry-less via cache byte).
 *
 * Probabilities are 12-bit (P(bit = 0) * 4096) and adapt with a shift of
 * PROB_SHIFT.  The same JavaScript source runs in the Node region builder
 * (encoder) and in the phone's web worker (decoder); only integer-valued
 * double arithmetic and 32-bit unsigned ops are used, so both sides are
 * bit-exact.
 */
export const PROB_BITS = 12;
export const PROB_ONE = 1 << PROB_BITS; // 4096
export const PROB_INIT = PROB_ONE >> 1;
export const PROB_SHIFT = 7;
const TOP = 1 << 24;

export class RangeEncoder {
  private low = 0; // up to 2^33, kept as an exact double
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  private buf: Uint8Array;
  private pos = 0;

  constructor(initialCapacity = 1 << 16) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private out(b: number): void {
    if (this.pos >= this.buf.length) {
      const nb = new Uint8Array(this.buf.length * 2);
      nb.set(this.buf);
      this.buf = nb;
    }
    this.buf[this.pos++] = b;
  }

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.out((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  /** Encode one bit with adaptive probability probs[i] = P(0). */
  encodeBit(probs: Uint16Array, i: number, bit: number): void {
    const p = probs[i];
    const bound = (this.range >>> PROB_BITS) * p;
    if (bit === 0) {
      this.range = bound;
      probs[i] = p + ((PROB_ONE - p) >> PROB_SHIFT);
    } else {
      this.low += bound;
      this.range -= bound;
      probs[i] = p - (p >> PROB_SHIFT);
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.shiftLow();
    }
  }

  /** Encode `n` raw bits (MSB first) with fixed p = 0.5. */
  encodeDirect(value: number, n: number): void {
    for (let k = n - 1; k >= 0; k--) {
      this.range = this.range >>> 1;
      if ((Math.floor(value / 2 ** k) & 1) === 1) this.low += this.range;
      while (this.range < TOP) {
        this.range = (this.range * 256) >>> 0;
        this.shiftLow();
      }
    }
  }

  finish(): Uint8Array {
    for (let i = 0; i < 5; i++) this.shiftLow();
    return this.buf.slice(0, this.pos);
  }
}

export class RangeDecoder {
  private code = 0;
  private range = 0xffffffff;
  private pos: number;
  private readonly end: number;

  constructor(private readonly buf: Uint8Array, start = 0, end = buf.length) {
    this.pos = start;
    this.end = end;
    // first byte is always the initial cache (0)
    for (let i = 0; i < 5; i++) this.code = ((this.code << 8) | this.next()) >>> 0;
  }

  private next(): number {
    return this.pos < this.end ? this.buf[this.pos++] : 0;
  }

  decodeBit(probs: Uint16Array, i: number): number {
    const p = probs[i];
    const bound = (this.range >>> PROB_BITS) * p;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((PROB_ONE - p) >> PROB_SHIFT);
      bit = 0;
    } else {
      this.code -= bound;
      this.range -= bound;
      probs[i] = p - (p >> PROB_SHIFT);
      bit = 1;
    }
    if (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code * 256) + this.next()) >>> 0;
    }
    return bit;
  }

  decodeDirect(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++) {
      this.range = this.range >>> 1;
      let b = 0;
      if (this.code >= this.range) {
        this.code -= this.range;
        b = 1;
      }
      v = v * 2 + b;
      if (this.range < TOP) {
        this.range = (this.range * 256) >>> 0;
        this.code = ((this.code * 256) + this.next()) >>> 0;
      }
    }
    return v;
  }
}
