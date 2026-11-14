/**
 * GIF (BE-043; SEC-038 criteria 1 and 2; SEC-040 criterion 2). The block structure is read first:
 * the logical screen against the pixel limits, every frame's rectangle, and the frame count and
 * the pixels across frames against their limits, before any image data is decompressed. Each frame
 * is then decoded to palette indices by this module's own bounded LZW decoder and written into a
 * new GIF by omggif's encoder, with its palette, delay, disposal and transparency. Comments,
 * application blocks other than the loop count (XMP among them), plain-text blocks and bytes after
 * the trailer are not copied. A PNG of the first frame is the print rendition, because LuaLaTeX
 * does not read GIF (09 §2).
 */
import { GifWriter } from 'omggif';
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';
import { checkOutput, encodePng, type Processed } from './output.ts';
import { checkPixels } from './png.ts';
import { GIF, PNG } from './types.ts';

export interface GifFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  interlaced: boolean;
  /** RGB triplets: the local palette, or the global one. */
  palette: Uint8Array;
  transparent: number | null;
  delay: number;
  disposal: number;
  minCodeSize: number;
  /** The LZW data with the sub-block lengths removed. */
  data: Uint8Array;
}

export interface GifStructure {
  width: number;
  height: number;
  loop: number | null;
  frames: GifFrame[];
  /** Offset just after the trailer. */
  end: number;
  removed: string[];
}

/** Reads the data sub-blocks starting at `o`; returns their concatenation and the offset after. */
function subBlocks(b: Uint8Array, o: number, keep: boolean): { data: Uint8Array; next: number } {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    if (o >= b.length)
      throw new AssetError('malformed', 'the GIF file is cut short in a data block');
    const n = b[o++]!;
    if (n === 0) break;
    if (o + n > b.length) throw new AssetError('malformed', 'a GIF data block runs past the end');
    if (keep) parts.push(b.subarray(o, o + n));
    total += n;
    o += n;
  }
  if (!keep) return { data: new Uint8Array(0), next: o };
  const data = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    data.set(part, p);
    p += part.length;
  }
  return { data, next: o };
}

/** Reads the block structure of a GIF file without decompressing any frame. */
export function parseGif(b: Uint8Array, limits: ContentLimits): GifStructure {
  if (b.length < 13) throw new AssetError('malformed', 'the GIF file is cut short');
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a')
    throw new AssetError('malformed', 'not a GIF signature');
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  checkPixels(width, height, limits);
  const flags = b[10]!;
  let o = 13;
  let global: Uint8Array | null = null;
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1));
    if (o + n > b.length) throw new AssetError('malformed', 'the GIF palette is cut short');
    global = b.subarray(o, o + n);
    o += n;
  }
  const frames: GifFrame[] = [];
  let totalPixels = 0;
  let loop: number | null = null;
  let control: { transparent: number | null; delay: number; disposal: number } | null = null;
  const removed = new Set<string>();
  for (;;) {
    if (o >= b.length) throw new AssetError('malformed', 'the GIF file is cut short (no trailer)');
    const block = b[o++]!;
    if (block === 0x3b)
      return { width, height, loop, frames, end: o, removed: [...removed].sort() };
    if (block === 0x21) {
      if (o >= b.length) throw new AssetError('malformed', 'the GIF file is cut short');
      const label = b[o++]!;
      if (label === 0xf9) {
        if (o + 6 > b.length || b[o] !== 4 || b[o + 5] !== 0)
          throw new AssetError('malformed', 'a GIF graphic control block of the wrong size');
        const pf = b[o + 1]!;
        control = {
          transparent: pf & 1 ? b[o + 4]! : null,
          delay: b[o + 2]! | (b[o + 3]! << 8),
          disposal: Math.min(3, (pf >> 2) & 7),
        };
        o += 6;
      } else if (label === 0xff) {
        if (o + 12 > b.length || b[o] !== 11)
          throw new AssetError('malformed', 'a GIF application block of the wrong size');
        const app = String.fromCharCode(...b.subarray(o + 1, o + 12));
        const sb = subBlocks(b, o + 12, true);
        if (
          (app === 'NETSCAPE2.0' || app === 'ANIMEXTS1.0') &&
          sb.data.length >= 3 &&
          sb.data[0] === 1
        )
          loop = sb.data[1]! | (sb.data[2]! << 8);
        else removed.add(`application:${app.replace(/[^A-Za-z0-9.]/g, '_')}`);
        o = sb.next;
      } else {
        // Comments (0xFE), plain text (0x01) and unknown extensions are skipped and not copied.
        removed.add(
          label === 0xfe ? 'comment' : label === 0x01 ? 'plain_text' : `extension:${label}`,
        );
        o = subBlocks(b, o, false).next;
      }
      continue;
    }
    if (block !== 0x2c)
      throw new AssetError('malformed', `an unknown GIF block 0x${block.toString(16)}`);
    if (o + 9 > b.length) throw new AssetError('malformed', 'a GIF image descriptor is cut short');
    let x = b[o]! | (b[o + 1]! << 8);
    let y = b[o + 2]! | (b[o + 3]! << 8);
    const w = b[o + 4]! | (b[o + 5]! << 8);
    const h = b[o + 6]! | (b[o + 7]! << 8);
    const pf = b[o + 8]!;
    o += 9;
    if (w < 1 || h < 1) throw new AssetError('malformed', 'a GIF frame without pixels');
    if (x >= width || y >= height)
      throw new AssetError('malformed', 'a GIF frame outside the logical screen');
    let palette = global;
    if (pf & 0x80) {
      const n = 3 * (1 << ((pf & 7) + 1));
      if (o + n > b.length) throw new AssetError('malformed', 'a GIF palette is cut short');
      palette = b.subarray(o, o + n);
      o += n;
    }
    if (!palette) throw new AssetError('malformed', 'a GIF frame without a palette');
    if (frames.length + 1 > limits.maxFrames)
      throw new AssetError('frame_limit', `more than ${limits.maxFrames} GIF frames`);
    totalPixels += w * h;
    if (totalPixels > limits.maxTotalFramePixels)
      throw new AssetError(
        'frame_limit',
        `more than ${limits.maxTotalFramePixels} pixels across GIF frames`,
      );
    if (o >= b.length) throw new AssetError('malformed', 'a GIF frame is cut short');
    const minCodeSize = b[o++]!;
    if (minCodeSize < 2 || minCodeSize > 8)
      throw new AssetError('malformed', 'a GIF LZW code size out of range');
    const sb = subBlocks(b, o, true);
    o = sb.next;
    // A frame that reaches past the logical screen is cropped to it when decoded.
    x = Math.min(x, width - 1);
    y = Math.min(y, height - 1);
    frames.push({
      x,
      y,
      width: w,
      height: h,
      interlaced: (pf & 0x40) !== 0,
      palette,
      transparent: control?.transparent ?? null,
      delay: control?.delay ?? 0,
      disposal: control?.disposal ?? 0,
      minCodeSize,
      data: sb.data,
    });
    control = null;
  }
}

/**
 * Decodes GIF LZW data (GIF89a appendix F) into `out`, one palette index per pixel. Writes at most
 * `out.length` indices whatever the data says; returns how many were written. A stream that ends
 * early leaves the rest at 0; a code that cannot occur fails the frame.
 */
export function decodeLzw(data: Uint8Array, minCodeSize: number, out: Uint8Array): number {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let prev = -1;
  let acc = 0;
  let bits = 0;
  let pos = 0;
  let op = 0;
  while (op < out.length) {
    while (bits < codeSize) {
      if (pos >= data.length) return op;
      acc |= data[pos++]! << bits;
      bits += 8;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev === -1) {
      if (code > clear)
        throw new AssetError('malformed', 'a GIF LZW stream starts with a string code');
      out[op++] = code;
      prev = code;
      continue;
    }
    let cur: number;
    let sp = 0;
    if (code < next) cur = code;
    else if (code === next) {
      stack[sp++] = first[prev]!;
      cur = prev;
    } else throw new AssetError('malformed', 'a GIF LZW code that was never defined');
    while (cur >= clear) {
      if (sp >= stack.length) throw new AssetError('malformed', 'a GIF LZW string is too long');
      stack[sp++] = suffix[cur]!;
      cur = prefix[cur]!;
    }
    stack[sp++] = cur;
    while (sp > 0 && op < out.length) out[op++] = stack[--sp]!;
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first[code === next ? prev : code]!;
      first[next] = first[prev]!;
      next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return op;
}

/** Row order of an interlaced frame (GIF89a appendix E). */
function deinterlace(indices: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  let row = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ] as const) {
    for (let y = start; y < h; y += step) {
      out.set(indices.subarray(row * w, row * w + w), y * w);
      row++;
    }
  }
  return out;
}

const palette24 = (p: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 2 < p.length; i += 3) out.push((p[i]! << 16) | (p[i + 1]! << 8) | p[i + 2]!);
  return out;
};

/** Decodes every frame of a GIF upload and writes them into a new GIF; adds a PNG of frame 1. */
export function processGif(b: Uint8Array, limits: ContentLimits): Processed {
  const s = parseGif(b, limits);
  if (s.frames.length === 0) throw new AssetError('malformed', 'a GIF file without frames');
  let buf = new Uint8Array(Math.min(limits.outputMaxBytes + 1, 64 * 1024));
  const writer = new GifWriter(buf, s.width, s.height, s.loop === null ? {} : { loop: s.loop });
  let firstRgba: Uint8Array | null = null;
  let shortFrames = 0;
  for (const f of s.frames) {
    const raw = new Uint8Array(f.width * f.height);
    if (decodeLzw(f.data, f.minCodeSize, raw) < raw.length) shortFrames++;
    const rows = f.interlaced ? deinterlace(raw, f.width, f.height) : raw;
    const paletteSize = f.palette.length / 3;
    for (let i = 0; i < rows.length; i++)
      if (rows[i]! >= paletteSize)
        throw new AssetError('malformed', 'a GIF pixel outside its palette');
    // Crop to the logical screen.
    const cw = Math.min(f.width, s.width - f.x);
    const ch = Math.min(f.height, s.height - f.y);
    let pixels = rows;
    if (cw !== f.width || ch !== f.height) {
      pixels = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) pixels.set(rows.subarray(y * f.width, y * f.width + cw), y * cw);
    }
    if (!firstRgba) {
      firstRgba = new Uint8Array(s.width * s.height * 4);
      for (let y = 0; y < ch; y++)
        for (let x = 0; x < cw; x++) {
          const idx = pixels[y * cw + x]!;
          if (idx === f.transparent) continue;
          const d = ((f.y + y) * s.width + f.x + x) * 4;
          firstRgba[d] = f.palette[idx * 3]!;
          firstRgba[d + 1] = f.palette[idx * 3 + 1]!;
          firstRgba[d + 2] = f.palette[idx * 3 + 2]!;
          firstRgba[d + 3] = 255;
        }
    }
    // Room for the frame: the LZW codes take at most 12 bits per pixel, plus block overhead.
    const need = writer.getOutputBufferPosition() + Math.ceil(cw * ch * 1.6) + 2048;
    if (need > buf.length) {
      if (need > limits.outputMaxBytes + 4096)
        throw new AssetError(
          'output_limit',
          `the re-encoded GIF would pass ${limits.outputMaxBytes} bytes`,
        );
      const grown = new Uint8Array(
        Math.min(limits.outputMaxBytes + 4096, Math.max(need, buf.length * 2)),
      );
      grown.set(buf.subarray(0, writer.getOutputBufferPosition()));
      buf = grown;
      writer.setOutputBuffer(buf);
    }
    const opts: { palette: number[]; delay: number; disposal: number; transparent?: number } = {
      palette: palette24(f.palette),
      delay: f.delay,
      disposal: f.disposal,
    };
    if (f.transparent !== null && f.transparent < paletteSize) opts.transparent = f.transparent;
    writer.addFrame(f.x, f.y, cw, ch, pixels as unknown as number[], opts);
  }
  const end = writer.end();
  if (end > buf.length)
    throw new AssetError('output_limit', 'the re-encoded GIF overflowed its buffer');
  const gif = checkOutput(buf.slice(0, end), limits);
  const print = checkOutput(encodePng(firstRgba!, s.width, s.height), limits);
  const notes = s.removed.map((t) => `removed:${t}`);
  if (s.end < b.length) notes.push('trailing_data_removed');
  if (shortFrames > 0) notes.push(`short_frames:${shortFrames}`);
  return {
    detected: GIF,
    width: s.width,
    height: s.height,
    frames: s.frames.length,
    keepOriginal: false,
    outputs: [
      { role: 'display', mime: GIF, data: gif },
      { role: 'print', mime: PNG, data: print },
    ],
    notes,
  };
}
