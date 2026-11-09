/** Minimal protobuf writer (varints, length-delimited fields, packed arrays). */
export class PbfWriter {
  buf: Uint8Array;
  pos = 0;
  constructor(size = 4096) {
    this.buf = new Uint8Array(size);
  }
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let len = this.buf.length * 2;
    while (len < this.pos + n) len *= 2;
    const nb = new Uint8Array(len);
    nb.set(this.buf.subarray(0, this.pos));
    this.buf = nb;
  }
  varint(v: number): void {
    this.ensure(10);
    if (v < 0) throw new Error('negative varint');
    while (v >= 0x80) {
      this.buf[this.pos++] = (v & 0x7f) | 0x80;
      v = Math.floor(v / 128);
    }
    this.buf[this.pos++] = v;
  }
  tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }
  uintField(field: number, v: number): void {
    this.tag(field, 0);
    this.varint(v);
  }
  sintField(field: number, v: number): void {
    this.tag(field, 0);
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }
  bytesField(field: number, bytes: Uint8Array): void {
    this.tag(field, 2);
    this.varint(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }
  stringField(field: number, s: string): void {
    this.bytesField(field, utf8(s));
  }
  doubleField(field: number, v: number): void {
    this.tag(field, 1);
    this.ensure(8);
    new DataView(this.buf.buffer, this.buf.byteOffset).setFloat64(this.pos, v, true);
    this.pos += 8;
  }
  packedVarints(field: number, vals: ArrayLike<number>): void {
    const inner = new PbfWriter(vals.length * 2 + 8);
    for (let i = 0; i < vals.length; i++) inner.varint(vals[i]);
    this.bytesField(field, inner.finish());
  }
  /** write a sub-message via callback */
  message(field: number, fn: (w: PbfWriter) => void): void {
    const inner = new PbfWriter(256);
    fn(inner);
    this.bytesField(field, inner.finish());
  }
  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

const enc = new TextEncoder();
export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}
