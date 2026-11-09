/**
 * .topo region container (format 1)
 *
 *   0  "TOPOGLB1"            magic
 *   8  u32 json length       (little endian)
 *  12  u32 0                 reserved
 *  16  JSON metadata (UTF-8) - ids, bounds, credits, codec parameters, section table
 *  ..  sections, 8-byte aligned (offsets in the JSON are absolute)
 * end-16 "TOPOEND1" u32 crc32(bytes[0, end-16)) u32 total length
 *
 * The trailer lets the phone reject truncated or corrupted downloads with a
 * clear message before anything is stored.
 */
import { crc32 } from './crc32';
import type { DemParams } from './demcodec';

export const MAGIC = 'TOPOGLB1';
export const TRAILER = 'TOPOEND1';
export const FORMAT_VERSION = 1;

export interface SectionRef { offset: number; length: number }

export interface ChunkRef extends SectionRef {
  /** extent of all features in the chunk (grid units) */
  ext: [number, number, number, number];
  roads: number;
  water: number;
  areas: number;
  pois: number;
}

export interface RegionMeta {
  format: number;
  id: string; // e.g. "S38E145"
  name: string;
  /** [west, south, east, north] in degrees */
  bounds: [number, number, number, number];
  created: string;
  sources: Record<string, string>;
  credits: string[];
  dem: {
    /** latitude of row 0 / longitude of column 0 (sample centres, degrees) */
    north: number;
    west: number;
    dLat: number;
    dLon: number;
    unit: number; // metres per stored integer
    minElev: number;
    maxElev: number;
    params: DemParams;
    /** block payload offsets relative to sections.dem.offset (blocks + 1 entries) */
    blockOffsets: number[];
    maxErrorM: number;
  };
  vec: {
    scale: number; // grid units per degree
    chunksX: number;
    chunksY: number;
    chunks: ChunkRef[];
    nameCount: number;
    counts: { roads: number; water: number; areas: number; pois: number; points: number };
  };
  sections: { dem: SectionRef; names: SectionRef; vec: SectionRef };
}

const te = new TextEncoder();
const td = new TextDecoder();

export function writeRegion(meta: Omit<RegionMeta, 'sections'>, dem: Uint8Array, names: Uint8Array, vec: Uint8Array): Uint8Array {
  // two passes: the JSON contains absolute offsets, whose digits change its length
  let jsonLen = 0;
  let json = new Uint8Array(0);
  let sections: RegionMeta['sections'] = { dem: { offset: 0, length: 0 }, names: { offset: 0, length: 0 }, vec: { offset: 0, length: 0 } };
  for (let pass = 0; pass < 4; pass++) {
    const start = align8(16 + jsonLen);
    sections = {
      dem: { offset: start, length: dem.length },
      names: { offset: align8(start + dem.length), length: names.length },
      vec: { offset: align8(align8(start + dem.length) + names.length), length: vec.length },
    };
    json = te.encode(JSON.stringify({ ...meta, sections }));
    if (json.length === jsonLen) break;
    jsonLen = json.length;
  }
  const end = align8(sections.vec.offset + vec.length);
  const total = end + 16;
  const out = new Uint8Array(total);
  out.set(te.encode(MAGIC), 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, json.length, true);
  dv.setUint32(12, 0, true);
  out.set(json, 16);
  out.set(dem, sections.dem.offset);
  out.set(names, sections.names.offset);
  out.set(vec, sections.vec.offset);
  out.set(te.encode(TRAILER), end);
  dv.setUint32(end + 8, crc32(out.subarray(0, end)), true);
  dv.setUint32(end + 12, total, true);
  return out;
}

function align8(n: number): number {
  return (n + 7) & ~7;
}

export class RegionFormatError extends Error {}

/** Parse and verify a region file.  Throws RegionFormatError with a user-facing message. */
export function readRegion(buf: Uint8Array, verifyCrc = true): RegionMeta {
  if (buf.length < 32 || td.decode(buf.subarray(0, 8)) !== MAGIC) {
    throw new RegionFormatError('This is not a Topo Globe region file (.topo).');
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const end = buf.length - 16;
  if (td.decode(buf.subarray(end, end + 8)) !== TRAILER) {
    throw new RegionFormatError('The region file is incomplete - the download was probably cut short. Please download it again.');
  }
  const total = dv.getUint32(end + 12, true);
  if (total !== buf.length) {
    throw new RegionFormatError(`The region file has the wrong size (${buf.length} bytes, expected ${total}). Please download it again.`);
  }
  if (verifyCrc) {
    const want = dv.getUint32(end + 8, true);
    const got = crc32(buf.subarray(0, end));
    if (want !== got) throw new RegionFormatError('The region file is damaged (checksum mismatch). Please download it again.');
  }
  const jsonLen = dv.getUint32(8, true);
  const meta = JSON.parse(td.decode(buf.subarray(16, 16 + jsonLen))) as RegionMeta;
  if (meta.format !== FORMAT_VERSION) {
    throw new RegionFormatError(`Region file format ${meta.format} needs a newer version of the app.`);
  }
  return meta;
}
