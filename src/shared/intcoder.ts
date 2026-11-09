/** Adaptive integer binarisations on top of the binary range coder. */
import { RangeDecoder, RangeEncoder, PROB_INIT } from './rangecoder';

/** Contexts used by one adaptive Exp-Golomb integer model. */
export const UINT_CTX = 24 + 24 * 3; // prefix bits + (top two mantissa bits) per prefix length

export function newProbs(n: number): Uint16Array {
  const p = new Uint16Array(n);
  p.fill(PROB_INIT);
  return p;
}

/** Unsigned v >= 0, adaptive Exp-Golomb (order 0) with modelled prefix and top mantissa bits. */
export function encU(enc: RangeEncoder, probs: Uint16Array, base: number, v: number): void {
  const x = v + 1;
  const nbits = 31 - Math.clz32(x);
  for (let k = 0; k < nbits; k++) enc.encodeBit(probs, base + Math.min(k, 23), 1);
  enc.encodeBit(probs, base + Math.min(nbits, 23), 0);
  if (nbits === 0) return;
  const mb = base + 24 + Math.min(nbits, 23) * 3;
  // top mantissa bit (modelled)
  const b1 = (x >>> (nbits - 1)) & 1;
  enc.encodeBit(probs, mb + 0, b1);
  if (nbits >= 2) {
    const b2 = (x >>> (nbits - 2)) & 1;
    enc.encodeBit(probs, mb + 1 + b1, b2);
    if (nbits > 2) enc.encodeDirect(x & ((1 << (nbits - 2)) - 1), nbits - 2);
  }
}

export function decU(dec: RangeDecoder, probs: Uint16Array, base: number): number {
  let nbits = 0;
  while (dec.decodeBit(probs, base + Math.min(nbits, 23)) === 1) nbits++;
  if (nbits === 0) return 0;
  const mb = base + 24 + Math.min(nbits, 23) * 3;
  let x = 1;
  const b1 = dec.decodeBit(probs, mb + 0);
  x = (x << 1) | b1;
  if (nbits >= 2) {
    const b2 = dec.decodeBit(probs, mb + 1 + b1);
    x = (x << 1) | b2;
    if (nbits > 2) x = x * 2 ** (nbits - 2) + dec.decodeDirect(nbits - 2);
  }
  return x - 1;
}

/** Signed: zero flag, sign, |v|-1 as unsigned.  Needs UINT_CTX + 2 contexts. */
export const SINT_CTX = UINT_CTX + 2;
export function encS(enc: RangeEncoder, probs: Uint16Array, base: number, v: number): void {
  if (v === 0) {
    enc.encodeBit(probs, base, 0);
    return;
  }
  enc.encodeBit(probs, base, 1);
  enc.encodeBit(probs, base + 1, v < 0 ? 1 : 0);
  encU(enc, probs, base + 2, Math.abs(v) - 1);
}
export function decS(dec: RangeDecoder, probs: Uint16Array, base: number): number {
  if (dec.decodeBit(probs, base) === 0) return 0;
  const neg = dec.decodeBit(probs, base + 1) === 1;
  const m = decU(dec, probs, base + 2) + 1;
  return neg ? -m : m;
}

/** Small symbol 0..(2^bits-1) via a binary tree of contexts (needs 2^bits contexts). */
export function encSym(enc: RangeEncoder, probs: Uint16Array, base: number, bits: number, v: number): void {
  let node = 1;
  for (let k = bits - 1; k >= 0; k--) {
    const b = (v >>> k) & 1;
    enc.encodeBit(probs, base + node, b);
    node = (node << 1) | b;
  }
}
export function decSym(dec: RangeDecoder, probs: Uint16Array, base: number, bits: number): number {
  let node = 1;
  for (let k = 0; k < bits; k++) node = (node << 1) | dec.decodeBit(probs, base + node);
  return node - (1 << bits);
}
