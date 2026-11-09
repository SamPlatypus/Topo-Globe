/**
 * Glyph PBF encoder for MapLibre (fontstack/range.pbf format).  Glyph bitmaps
 * are signed distance fields rendered on the phone from its own system font,
 * so no font files are bundled and nothing is downloaded.
 */
import { PbfWriter } from './pbf';

export interface SdfGlyph {
  id: number;
  bitmap: Uint8Array; // (width + 2*3) x (height + 2*3) SDF alpha
  width: number;
  height: number;
  left: number;
  top: number;
  advance: number;
}

export function encodeGlyphs(fontstack: string, start: number, end: number, glyphs: SdfGlyph[]): Uint8Array {
  const w = new PbfWriter(1 << 15);
  w.message(1, (stack) => {
    stack.stringField(1, fontstack);
    stack.stringField(2, `${start}-${end}`);
    for (const g of glyphs) {
      stack.message(3, (gw) => {
        gw.uintField(1, g.id);
        if (g.width > 0 && g.height > 0) gw.bytesField(2, g.bitmap);
        gw.uintField(3, g.width);
        gw.uintField(4, g.height);
        gw.sintField(5, g.left);
        gw.sintField(6, g.top);
        gw.uintField(7, g.advance);
      });
    }
  });
  return w.finish();
}
