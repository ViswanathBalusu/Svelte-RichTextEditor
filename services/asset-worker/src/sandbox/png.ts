/**
 * PNG (BE-043; SEC-038 criteria 1 and 2; SEC-040 criterion 2). The file's structure is read first
 * without decoding: every chunk's length and CRC, the chunk order, the header's dimensions against
 * the pixel limits, the frame count of an animated PNG, and the inflated size of the image data,
 * measured by bounded inflation. Only then does pngjs decode it, and the pixels are written into a
 * new PNG. Ancillary chunks (text, Exif, colour profiles, times) and bytes after IEND are not
 * copied. An animated PNG keeps its default image only.
 */
import { crc32 } from 'node:zlib';
import { PNG as PngJs } from 'pngjs';
import { AssetError } from './errors.ts';
import { scanInflate } from './inflate.ts';
import type { ContentLimits } from './limits.ts';
import { checkOutput, encodePng, type Processed } from './output.ts';
import { PNG } from './types.ts';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per colour type (PNG 11.2.2). */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** Bit depths allowed per colour type. */
const DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export interface PngStructure {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  interlaced: boolean;
  /** Frames announced by acTL, or 1. */
  frames: number;
  /** The IDAT data, concatenated. */
  idat: Uint8Array;
  /** Bytes from the signature to the end of IEND. */
  end: number;
  /** Ancillary chunk types seen (they are not copied). */
  ancillary: string[];
}

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** Checks pixel limits for a decoded image of `width` × `height`. */
export function checkPixels(width: number, height: number, limits: ContentLimits): void {
  if (width < 1 || height < 1) throw new AssetError('malformed', 'an image has no pixels');
  if (width > limits.maxDimension || height > limits.maxDimension)
    throw new AssetError(
      'pixel_limit',
      `${width} × ${height} pixels is beyond the dimension limit of ${limits.maxDimension}`,
    );
  if (width * height > limits.maxPixels)
    throw new AssetError(
      'pixel_limit',
      `${width} × ${height} pixels is beyond the limit of ${limits.maxPixels} pixels`,
    );
}

/** The inflated size of the image data that the header announces (PNG 7.2, 8.2 for Adam7). */
export function expectedRawBytes(
  s: Pick<PngStructure, 'width' | 'height' | 'bitDepth' | 'colourType' | 'interlaced'>,
): number {
  const bits = CHANNELS[s.colourType]! * s.bitDepth;
  const row = (w: number): number => 1 + Math.ceil((w * bits) / 8);
  if (!s.interlaced) return s.height * row(s.width);
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const w = s.width > x0 ? Math.ceil((s.width - x0) / dx) : 0;
    const h = s.height > y0 ? Math.ceil((s.height - y0) / dy) : 0;
    if (w > 0 && h > 0) total += h * row(w);
  }
  return total;
}

/** Reads the chunk structure of a PNG file without decoding it. */
export function parsePng(b: Uint8Array, limits: ContentLimits): PngStructure {
  if (b.length < 8 || !SIGNATURE.every((v, i) => b[i] === v))
    throw new AssetError('malformed', 'not a PNG signature');
  let o = 8;
  let chunks = 0;
  let header: Omit<PngStructure, 'frames' | 'idat' | 'end' | 'ancillary'> | null = null;
  let palette = false;
  let frames = 1;
  let idatState: 'before' | 'in' | 'after' = 'before';
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  const ancillary = new Set<string>();
  for (;;) {
    if (o + 12 > b.length) throw new AssetError('malformed', 'the PNG file is cut short (no IEND)');
    const len = u32(b, o);
    if (len > 0x7fffffff) throw new AssetError('malformed', 'a PNG chunk length is out of range');
    const typeBytes = b.subarray(o + 4, o + 8);
    if (!typeBytes.every((c) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)))
      throw new AssetError('malformed', 'a PNG chunk type is not four letters');
    const type = String.fromCharCode(...typeBytes);
    if (o + 12 + len > b.length)
      throw new AssetError('malformed', `the PNG chunk ${type} is cut short`);
    const data = b.subarray(o + 8, o + 8 + len);
    if (crc32(b.subarray(o + 4, o + 8 + len)) !== u32(b, o + 8 + len))
      throw new AssetError('malformed', `the CRC of the PNG chunk ${type} is wrong`);
    if (++chunks > limits.maxPngChunks)
      throw new AssetError('malformed', `more than ${limits.maxPngChunks} PNG chunks`);
    const next = o + 12 + len;
    if (chunks === 1 && type !== 'IHDR')
      throw new AssetError('malformed', 'the first PNG chunk is not IHDR');
    if (idatState === 'in' && type !== 'IDAT') idatState = 'after';
    switch (type) {
      case 'IHDR': {
        if (header) throw new AssetError('malformed', 'a second IHDR chunk');
        if (len !== 13) throw new AssetError('malformed', 'the IHDR chunk is not 13 bytes');
        const width = u32(data, 0);
        const height = u32(data, 4);
        const bitDepth = data[8]!;
        const colourType = data[9]!;
        if (width > 0x7fffffff || height > 0x7fffffff)
          throw new AssetError('malformed', 'PNG dimensions out of range');
        if (!DEPTHS[colourType]?.includes(bitDepth))
          throw new AssetError(
            'malformed',
            `PNG colour type ${colourType} with bit depth ${bitDepth}`,
          );
        if (data[10] !== 0 || data[11] !== 0)
          throw new AssetError('malformed', 'unknown PNG compression or filter method');
        if (data[12] !== 0 && data[12] !== 1)
          throw new AssetError('malformed', 'unknown PNG interlace method');
        // The pixel limits apply here, before any image data is read or memory is set aside.
        checkPixels(width, height, limits);
        header = { width, height, bitDepth, colourType, interlaced: data[12] === 1 };
        break;
      }
      case 'PLTE':
        if (palette) throw new AssetError('malformed', 'a second PLTE chunk');
        if (idatState !== 'before') throw new AssetError('malformed', 'PLTE after the image data');
        if (len === 0 || len % 3 !== 0 || len > 768)
          throw new AssetError('malformed', 'a PLTE chunk of the wrong size');
        if (header!.colourType === 0 || header!.colourType === 4)
          throw new AssetError('malformed', 'a palette in a grey PNG');
        palette = true;
        break;
      case 'acTL':
        if (idatState !== 'before') throw new AssetError('malformed', 'acTL after the image data');
        if (len !== 8) throw new AssetError('malformed', 'an acTL chunk of the wrong size');
        frames = u32(data, 0);
        if (frames < 1) throw new AssetError('malformed', 'an animated PNG with no frames');
        if (frames > limits.maxFrames)
          throw new AssetError(
            'frame_limit',
            `${frames} frames is beyond the limit of ${limits.maxFrames}`,
          );
        ancillary.add(type);
        break;
      case 'IDAT':
        if (idatState === 'after')
          throw new AssetError('malformed', 'the IDAT chunks are not consecutive');
        idatState = 'in';
        idat.push(data);
        idatBytes += len;
        break;
      case 'IEND': {
        if (len !== 0) throw new AssetError('malformed', 'an IEND chunk with data');
        if (!header) throw new AssetError('malformed', 'no IHDR chunk');
        if (idat.length === 0) throw new AssetError('malformed', 'no image data');
        if (header.colourType === 3 && !palette)
          throw new AssetError('malformed', 'a palette PNG without PLTE');
        const all = new Uint8Array(idatBytes);
        let p = 0;
        for (const d of idat) {
          all.set(d, p);
          p += d.length;
        }
        return { ...header, frames, idat: all, end: next, ancillary: [...ancillary].sort() };
      }
      default:
        // A critical chunk has an upper-case first letter (PNG 5.4); an unknown one cannot be skipped.
        if (!(typeBytes[0]! & 0x20))
          throw new AssetError(
            'unsupported_content',
            `the critical PNG chunk ${type} is not supported`,
          );
        ancillary.add(type);
    }
    o = next;
  }
}

/** Decodes a PNG upload and writes its pixels into a new PNG. */
export async function processPng(b: Uint8Array, limits: ContentLimits): Promise<Processed> {
  const s = parsePng(b, limits);
  const raw = expectedRawBytes(s);
  // pngjs holds the inflated data, the unfiltered data and the RGBA result at once.
  const estimate = 3 * raw + 4 * s.width * s.height;
  if (estimate > limits.maxDecodeMiB * 1024 * 1024)
    throw new AssetError(
      'pixel_limit',
      `decoding would need about ${Math.ceil(estimate / 1048576)} MiB, above the limit of ${limits.maxDecodeMiB} MiB`,
    );
  // A decompression bomb inflates to more than the header announces: stop at that size.
  const scan = await scanInflate(s.idat, { raw: false, cap: raw });
  if (scan.over)
    throw new AssetError(
      'malformed',
      `the image data inflates to more than the ${raw} bytes its header announces`,
    );
  if (!scan.complete || scan.length !== raw)
    throw new AssetError(
      'malformed',
      `the image data inflates to ${scan.length} bytes instead of ${raw}`,
    );
  let decoded: { width: number; height: number; data: Buffer };
  try {
    decoded = PngJs.sync.read(Buffer.from(b.buffer, b.byteOffset, s.end), { checkCRC: true });
  } catch (e) {
    throw new AssetError(
      'decode_failed',
      `the PNG decoder refused the file (${e instanceof Error ? e.message.slice(0, 80) : 'error'})`,
    );
  }
  if (
    decoded.width !== s.width ||
    decoded.height !== s.height ||
    decoded.data.length !== s.width * s.height * 4
  )
    throw new AssetError(
      'decode_failed',
      'the PNG decoder returned other dimensions than the header',
    );
  const rgba = new Uint8Array(
    decoded.data.buffer,
    decoded.data.byteOffset,
    decoded.data.byteLength,
  );
  const out = checkOutput(encodePng(rgba, s.width, s.height), limits);
  const notes = s.ancillary.map((t) => `removed:${t}`);
  if (s.end < b.length) notes.push('trailing_data_removed');
  if (s.frames > 1) notes.push('animation_dropped');
  return {
    detected: PNG,
    width: s.width,
    height: s.height,
    frames: 1,
    keepOriginal: false,
    outputs: [{ role: 'display', mime: PNG, data: out }],
    notes,
  };
}
