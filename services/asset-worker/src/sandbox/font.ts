/**
 * The check of a font file an administrator adds (BE-048; owner decision 94: TrueType, OpenType
 * and WOFF2, each checked in the sandbox; collections and other formats are refused).
 *
 * The file is not converted: it is read to see that it is what it claims, within limits, and to
 * learn its family, style and embedding flags. The stored font is the upload itself, so the
 * export loader and the editor read the bytes the administrator supplied, named by their hash.
 *
 * What is checked, in the order of the checks:
 * - the byte limit of fonts, and the real format from the first bytes against the declared type;
 * - the table directory of the sfnt (or of the WOFF2 file): at most `fontMaxTables` tables, every
 *   table inside the file, no tag twice, and the tables a usable font has (`head`, `hhea`, `maxp`,
 *   `hmtx`, `cmap`, `name`, and glyph data, `glyf` and `loca` or `CFF `/`CFF2`);
 * - for WOFF2, the compressed block is expanded under the limit `fontMaxExpandedBytes` and its
 *   length must match the table directory (a decompression bomb stops at the limit);
 * - `head` (the magic number and the units per em), `maxp` (at least one glyph), `name` (a family
 *   name) and `OS/2` (`fsType`: a font whose licence restricts embedding is refused, because the
 *   PDF embeds the font).
 *
 * The limits are settings with defaults proposed in docs/adr/0424-w5-BE-048-tenant-fonts.md. A
 * message names a rule and numbers, never the content of the file.
 */
import { brotliDecompressSync } from 'node:zlib';
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';

export const TTF = 'font/ttf';
export const OTF = 'font/otf';
export const WOFF2 = 'font/woff2';
/** What an administrator may upload as a font. */
export const FONT_TYPES = [TTF, OTF, WOFF2] as const;
export type FontType = (typeof FONT_TYPES)[number];

export function isFontType(t: string): t is FontType {
  return (FONT_TYPES as readonly string[]).includes(t);
}

/** What the check learns about a font; the supervisor reads it back as hostile input. */
export interface FontInfo {
  /** The family name (name ID 16, else 1), trimmed. */
  family: string;
  /** The style name (name ID 17, else 2), or an empty string. */
  subfamily: string;
  /** The weight class of `OS/2`, or 700 or 400 from `head` when the font has no `OS/2` table. */
  weight: number;
  bold: boolean;
  italic: boolean;
  /** `truetype` for glyf outlines, `opentype` for CFF outlines, `woff2` for the packed file. */
  format: 'truetype' | 'opentype' | 'woff2';
  glyphs: number;
  unitsPerEm: number;
  /** The `fsType` embedding flags; 0 when the font has no `OS/2` table. */
  fsType: number;
  tables: number;
}

const fail = (
  reason: 'malformed' | 'unsupported_type' | 'unsupported_content' | 'archive_limit',
  msg: string,
) => new AssetError(reason, msg);

const SFNT_TRUETYPE = 0x00010000;
const SFNT_TRUE = 0x74727565; // 'true'
const SFNT_CFF = 0x4f54544f; // 'OTTO'
const COLLECTION = 0x74746366; // 'ttcf'
const WOFF2_SIG = 0x774f4632; // 'wOF2'
const WOFF1_SIG = 0x774f4646; // 'wOFF'

const tagText = (n: number): string =>
  String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

/** The 63 table tags a WOFF2 directory can name by index (W3C WOFF2, section 5.1). */
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
] as const;

/** The tables of a font by tag, each a view into the file or into the expanded block. */
type Tables = Map<string, Uint8Array>;

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/** The sfnt tables of a TrueType or OpenType file. */
function sfntTables(bytes: Uint8Array, limits: ContentLimits): { flavour: number; tables: Tables } {
  if (bytes.length < 12) throw fail('malformed', 'the font is shorter than its header');
  const v = view(bytes);
  const flavour = v.getUint32(0, false);
  const n = v.getUint16(4, false);
  if (n < 1 || n > limits.fontMaxTables)
    throw fail(
      'malformed',
      `the font has ${n} tables; from 1 to ${limits.fontMaxTables} are allowed`,
    );
  if (12 + n * 16 > bytes.length) throw fail('malformed', 'the table directory is cut short');
  const tables: Tables = new Map();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = tagText(v.getUint32(at, false));
    const offset = v.getUint32(at + 8, false);
    const length = v.getUint32(at + 12, false);
    if (tables.has(tag)) throw fail('malformed', `the table ${JSON.stringify(tag)} occurs twice`);
    if (offset < 12 + n * 16 || offset + length > bytes.length)
      throw fail('malformed', `the table ${JSON.stringify(tag)} is outside the file`);
    tables.set(tag, bytes.subarray(offset, offset + length));
  }
  return { flavour, tables };
}

/** A UIntBase128 of the WOFF2 table directory: at most five bytes, no leading zero byte. */
function base128(b: Uint8Array, at: { i: number }): number {
  let acc = 0;
  for (let k = 0; k < 5; k++) {
    if (at.i >= b.length) throw fail('malformed', 'the WOFF2 table directory is cut short');
    const byte = b[at.i++]!;
    if (k === 0 && byte === 0x80) throw fail('malformed', 'a WOFF2 length has a leading zero');
    if (acc > 0x01ffffff) throw fail('malformed', 'a WOFF2 length is too large');
    acc = acc * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return acc;
  }
  throw fail('malformed', 'a WOFF2 length is longer than five bytes');
}

/** The tables of a WOFF2 file, read after the compressed block is expanded under the limit. */
function woff2Tables(
  bytes: Uint8Array,
  limits: ContentLimits,
): { flavour: number; tables: Tables } {
  if (bytes.length < 48) throw fail('malformed', 'the WOFF2 file is shorter than its header');
  const v = view(bytes);
  const flavour = v.getUint32(4, false);
  const total = v.getUint32(8, false);
  const n = v.getUint16(12, false);
  const sfntSize = v.getUint32(16, false);
  const packed = v.getUint32(20, false);
  if (total !== bytes.length)
    throw fail('malformed', 'the WOFF2 length field is not the file size');
  if (n < 1 || n > limits.fontMaxTables)
    throw fail(
      'malformed',
      `the font has ${n} tables; from 1 to ${limits.fontMaxTables} are allowed`,
    );
  if (flavour !== SFNT_TRUETYPE && flavour !== SFNT_CFF)
    throw fail(
      'unsupported_content',
      'the WOFF2 file holds neither TrueType nor OpenType outlines',
    );
  if (sfntSize > limits.fontMaxExpandedBytes)
    throw fail(
      'archive_limit',
      `the font expands to ${sfntSize} bytes, above the limit of ${limits.fontMaxExpandedBytes}`,
    );
  const at = { i: 48 };
  const dir: { tag: string; length: number }[] = [];
  for (let k = 0; k < n; k++) {
    if (at.i >= bytes.length) throw fail('malformed', 'the WOFF2 table directory is cut short');
    const flags = bytes[at.i++]!;
    const index = flags & 0x3f;
    let tag: string;
    if (index === 63) {
      if (at.i + 4 > bytes.length)
        throw fail('malformed', 'the WOFF2 table directory is cut short');
      tag = tagText(v.getUint32(at.i, false));
      at.i += 4;
    } else tag = KNOWN_TAGS[index]!;
    const version = flags >> 6;
    const orig = base128(bytes, at);
    // glyf and loca are transformed unless the version is 3; hmtx only when it is 1.
    const transformed =
      tag === 'glyf' || tag === 'loca' ? version !== 3 : tag === 'hmtx' ? version === 1 : false;
    const length = transformed ? base128(bytes, at) : orig;
    if (dir.some((d) => d.tag === tag))
      throw fail('malformed', `the table ${JSON.stringify(tag)} occurs twice`);
    dir.push({ tag, length });
  }
  if (at.i + packed > bytes.length)
    throw fail('malformed', 'the compressed block is outside the file');
  const need = dir.reduce((s, d) => s + d.length, 0);
  if (need > limits.fontMaxExpandedBytes)
    throw fail(
      'archive_limit',
      `the font expands to ${need} bytes, above the limit of ${limits.fontMaxExpandedBytes}`,
    );
  let expanded: Uint8Array;
  try {
    expanded = brotliDecompressSync(bytes.subarray(at.i, at.i + packed), {
      maxOutputLength: Math.max(need, 1),
    });
  } catch {
    throw fail('malformed', 'the compressed block cannot be expanded within the table sizes');
  }
  if (expanded.length !== need)
    throw fail('malformed', 'the expanded block is not the size the table directory gives');
  const tables: Tables = new Map();
  let off = 0;
  for (const d of dir) {
    tables.set(d.tag, expanded.subarray(off, off + d.length));
    off += d.length;
  }
  return { flavour, tables };
}

/** A name of the `name` table as text, from a Windows (UTF-16BE) or a Macintosh (Roman) record. */
function nameOf(table: Uint8Array, ids: readonly number[]): string {
  if (table.length < 6) throw fail('malformed', 'the name table is cut short');
  const v = view(table);
  const count = v.getUint16(2, false);
  const base = v.getUint16(4, false);
  if (6 + count * 12 > table.length) throw fail('malformed', 'the name table is cut short');
  for (const id of ids) {
    let mac: string | null = null;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = v.getUint16(r, false);
      if (v.getUint16(r + 6, false) !== id) continue;
      const length = v.getUint16(r + 8, false);
      const start = base + v.getUint16(r + 10, false);
      if (start + length > table.length) throw fail('malformed', 'a name lies outside its table');
      const raw = table.subarray(start, start + length);
      if (platform === 3 || platform === 0) {
        if (length % 2 !== 0) continue;
        let s = '';
        for (let k = 0; k < length; k += 2) s += String.fromCharCode((raw[k]! << 8) | raw[k + 1]!);
        return s.trim();
      }
      if (platform === 1 && mac === null) mac = String.fromCharCode(...raw).trim();
    }
    if (mac !== null) return mac;
  }
  return '';
}

/** Checks `bytes` as the font type `declared`; returns what it learns or throws `AssetError`. */
export function processFont(
  bytes: Uint8Array,
  declared: FontType,
  limits: ContentLimits,
): FontInfo {
  if (bytes.length > limits.fontMaxBytes)
    throw new AssetError(
      'too_large',
      `${bytes.length} bytes is above the limit of ${limits.fontMaxBytes} bytes for fonts`,
    );
  if (bytes.length < 4) throw fail('malformed', 'the font is shorter than its signature');
  const sig = view(bytes).getUint32(0, false);
  if (sig === COLLECTION)
    throw fail('unsupported_type', 'font collections are not accepted; add each font by itself');
  if (sig === WOFF1_SIG) throw fail('unsupported_type', 'WOFF 1 is not accepted; use WOFF2');
  const isWoff2 = sig === WOFF2_SIG;
  const sfnt = sig === SFNT_TRUETYPE || sig === SFNT_TRUE || sig === SFNT_CFF;
  if (!isWoff2 && !sfnt)
    throw fail('unsupported_type', 'the file is not a font of an accepted format');
  const detected: FontType = isWoff2 ? WOFF2 : sig === SFNT_CFF ? OTF : TTF;
  // OpenType files with TrueType outlines are usual under `.otf`; the reverse is a mismatch.
  const matches = declared === detected || (declared === OTF && detected === TTF);
  if (!matches) throw new AssetError('type_mismatch', `declared ${declared}, detected ${detected}`);

  const { flavour, tables } = isWoff2 ? woff2Tables(bytes, limits) : sfntTables(bytes, limits);
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name'])
    if (!tables.has(t)) throw fail('malformed', `the font has no ${JSON.stringify(t)} table`);
  const cff = flavour === SFNT_CFF;
  if (cff ? !tables.has('CFF ') && !tables.has('CFF2') : !tables.has('glyf') || !tables.has('loca'))
    throw fail('malformed', cff ? 'the font has no CFF outlines' : 'the font has no glyf outlines');

  const head = tables.get('head')!;
  if (head.length < 54) throw fail('malformed', 'the head table is cut short');
  const hv = view(head);
  if (hv.getUint32(12, false) !== 0x5f0f3cf5) throw fail('malformed', 'the head magic is wrong');
  const unitsPerEm = hv.getUint16(18, false);
  if (unitsPerEm < 16 || unitsPerEm > 16384)
    throw fail('malformed', `units per em ${unitsPerEm} is outside 16 to 16384`);
  const macStyle = hv.getUint16(44, false);
  const maxp = tables.get('maxp')!;
  if (maxp.length < 6) throw fail('malformed', 'the maxp table is cut short');
  const glyphs = view(maxp).getUint16(4, false);
  if (glyphs < 1) throw fail('malformed', 'the font has no glyphs');

  let weight = macStyle & 1 ? 700 : 400;
  let bold = (macStyle & 1) === 1;
  let italic = (macStyle & 2) === 2;
  let fsType = 0;
  const os2 = tables.get('OS/2');
  if (os2) {
    if (os2.length < 68) throw fail('malformed', 'the OS/2 table is cut short');
    const ov = view(os2);
    weight = ov.getUint16(4, false);
    fsType = ov.getUint16(8, false);
    const sel = ov.getUint16(62, false);
    italic = (sel & 0x0201) !== 0;
    bold = (sel & 0x20) === 0x20 || weight >= 600;
    if (weight < 1 || weight > 1000) weight = bold ? 700 : 400;
  }
  // Bit 1 of fsType: the licence forbids embedding, and the PDF embeds the font.
  if ((fsType & 0x0002) !== 0)
    throw fail('unsupported_content', 'the font licence restricts embedding (fsType bit 1)');

  const name = tables.get('name')!;
  const family = nameOf(name, [16, 1]);
  if (family.length < 1 || family.length > 100 || /\p{Cc}/u.test(family))
    throw fail('malformed', 'the font has no usable family name');
  const subfamily = nameOf(name, [17, 2]).slice(0, 100);
  return {
    family,
    subfamily: /\p{Cc}/u.test(subfamily) ? '' : subfamily,
    weight,
    bold,
    italic,
    format: isWoff2 ? 'woff2' : cff ? 'opentype' : 'truetype',
    glyphs,
    unitsPerEm,
    fsType,
    tables: tables.size,
  };
}
