/**
 * Character coverage of a font file (09 §3.2, Missing glyphs; EXP-026, EXP-047): the Unicode code
 * points its `cmap` table maps to a glyph, as sorted, merged ranges. The converter checks every
 * character of a document against the coverage of the run's font and of the fallback chain before
 * anything is typeset; the class's `\tracinglostchars=3` is the second line.
 *
 * Pure: it reads the bytes of an OpenType or TrueType file (`.otf`, `.ttf`) or of a collection
 * (`.ttc`, `.otc`, first face unless another is named), with no file system access, so that the
 * worker can compute the coverage once when it builds its font directory and record it in the font
 * manifest. Only `cmap` subtables of formats 4 and 12 are read, from the Unicode platform or the
 * Windows platform with Unicode encodings; together they are what every modern font provides.
 */

/** An inclusive range of code points. */
export type CodeRange = readonly [number, number];

export class FontFormatError extends Error {}

function u16(v: DataView, at: number): number {
  if (at + 2 > v.byteLength) throw new FontFormatError('font data ends early');
  return v.getUint16(at);
}

function u32(v: DataView, at: number): number {
  if (at + 4 > v.byteLength) throw new FontFormatError('font data ends early');
  return v.getUint32(at);
}

/** The offset of a face's table directory: 0 for a single font, from the header for a collection. */
function faceOffset(v: DataView, face: number): number {
  if (u32(v, 0) !== 0x74746366) return 0; // 'ttcf'
  const count = u32(v, 8);
  if (face < 0 || face >= count) throw new FontFormatError(`the collection has no face ${face}`);
  return u32(v, 12 + 4 * face);
}

function tableOffset(v: DataView, base: number, tag: string): number | null {
  const tables = u16(v, base + 4);
  for (let i = 0; i < tables; i++) {
    const rec = base + 12 + 16 * i;
    let name = '';
    for (let k = 0; k < 4; k++) name += String.fromCharCode(v.getUint8(rec + k));
    if (name === tag) return u32(v, rec + 8);
  }
  return null;
}

function format4(v: DataView, at: number, out: Array<[number, number]>): void {
  const segments = u16(v, at + 6) / 2;
  const ends = at + 14;
  const starts = ends + 2 * segments + 2;
  const deltas = starts + 2 * segments;
  const offsets = deltas + 2 * segments;
  for (let s = 0; s < segments; s++) {
    const end = u16(v, ends + 2 * s);
    const start = u16(v, starts + 2 * s);
    const delta = u16(v, deltas + 2 * s);
    const rangeOffset = u16(v, offsets + 2 * s);
    if (start === 0xffff) continue;
    if (rangeOffset === 0) {
      // Every code point maps to (c + delta) mod 65536; glyph 0 is .notdef, which is not coverage.
      let runStart = -1;
      for (let c = start; c <= end; c++) {
        const glyph = (c + delta) & 0xffff;
        if (glyph !== 0 && runStart < 0) runStart = c;
        if (glyph === 0 && runStart >= 0) {
          out.push([runStart, c - 1]);
          runStart = -1;
        }
      }
      if (runStart >= 0) out.push([runStart, end]);
      continue;
    }
    let runStart = -1;
    for (let c = start; c <= end; c++) {
      const at2 = offsets + 2 * s + rangeOffset + 2 * (c - start);
      let glyph = u16(v, at2);
      if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      if (glyph !== 0 && runStart < 0) runStart = c;
      if (glyph === 0 && runStart >= 0) {
        out.push([runStart, c - 1]);
        runStart = -1;
      }
    }
    if (runStart >= 0) out.push([runStart, end]);
  }
}

function format12(v: DataView, at: number, out: Array<[number, number]>): void {
  const groups = u32(v, at + 12);
  for (let g = 0; g < groups; g++) {
    const rec = at + 16 + 12 * g;
    const start = u32(v, rec);
    const end = u32(v, rec + 4);
    const glyph = u32(v, rec + 8);
    if (end < start || end > 0x10ffff) throw new FontFormatError('a cmap group is malformed');
    // A group whose first glyph is .notdef covers the rest of its codes only.
    if (glyph === 0) {
      if (end > start) out.push([start + 1, end]);
    } else out.push([start, end]);
  }
}

/** Sorts and merges ranges, joining adjacent ones. */
export function mergeRanges(ranges: readonly CodeRange[]): CodeRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The code points a font maps to a glyph, as sorted, merged ranges. */
export function fontCoverage(data: Uint8Array, face = 0): CodeRange[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const base = faceOffset(v, face);
  const cmap = tableOffset(v, base, 'cmap');
  if (cmap === null) throw new FontFormatError('the font has no cmap table');
  const subtables = u16(v, cmap + 2);
  const out: Array<[number, number]> = [];
  let seen12 = false;
  let seen4 = false;
  for (let i = 0; i < subtables; i++) {
    const rec = cmap + 4 + 8 * i;
    const platform = u16(v, rec);
    const encoding = u16(v, rec + 2);
    const at = cmap + u32(v, rec + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = u16(v, at);
    if (format === 12 && !seen12) {
      format12(v, at, out);
      seen12 = true;
    } else if (format === 4 && !seen4) {
      format4(v, at, out);
      seen4 = true;
    }
  }
  if (!seen4 && !seen12)
    throw new FontFormatError('the font has no Unicode cmap of format 4 or 12');
  return mergeRanges(out);
}

/** Whether a code point is in sorted, merged ranges (binary search). */
export function covers(ranges: readonly CodeRange[], codePoint: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = ranges[mid]!;
    if (codePoint < r[0]) hi = mid - 1;
    else if (codePoint > r[1]) lo = mid + 1;
    else return true;
  }
  return false;
}
