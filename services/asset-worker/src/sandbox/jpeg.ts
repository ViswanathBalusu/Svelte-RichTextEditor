/**
 * JPEG (BE-043; SEC-038 criterion 1; SEC-040 criterion 2). The marker structure is read first: one
 * baseline, extended or progressive frame of 8-bit samples whose dimensions pass the pixel limits,
 * at most `maxJpegScans` scans, and an end-of-image marker. Then jpeg-js decodes it with its own
 * resolution and memory limits set from the same settings, the Exif orientation is applied to the
 * pixels (the tag itself is not kept), and the pixels are written into a new baseline JPEG. Exif,
 * XMP, ICC profiles, comments, thumbnails and bytes after the end marker are not copied.
 */
import jpeg from 'jpeg-js';
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';
import { checkOutput, type Processed } from './output.ts';
import { checkPixels } from './png.ts';
import { JPEG } from './types.ts';

export interface JpegStructure {
  width: number;
  height: number;
  components: number;
  progressive: boolean;
  scans: number;
  /** Exif orientation, 1 to 8 (1 when absent or unreadable). */
  orientation: number;
  /** Offset just after the end-of-image marker. */
  end: number;
  /** Segment kinds seen that are not copied (APPn, COM). */
  removed: string[];
}

const SUPPORTED_SOF = new Set([0xc0, 0xc1, 0xc2]);
const OTHER_SOF = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** The orientation tag of an Exif APP1 payload (after "Exif\0\0"), or 1. Bounded throughout. */
export function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = (o: number): number =>
    o + 2 > tiff.length ? -1 : le ? tiff[o]! | (tiff[o + 1]! << 8) : (tiff[o]! << 8) | tiff[o + 1]!;
  const u32 = (o: number): number =>
    o + 4 > tiff.length
      ? -1
      : le
        ? (tiff[o]! | (tiff[o + 1]! << 8) | (tiff[o + 2]! << 16) | (tiff[o + 3]! << 24)) >>> 0
        : ((tiff[o]! << 24) | (tiff[o + 1]! << 16) | (tiff[o + 2]! << 8) | tiff[o + 3]!) >>> 0;
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd < 8 || ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count && i < 512; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > tiff.length) return 1;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Reads the marker structure of a JPEG file without decoding it. */
export function parseJpeg(b: Uint8Array, limits: ContentLimits): JpegStructure {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8)
    throw new AssetError('malformed', 'not a JPEG start-of-image marker');
  let o = 2;
  let frame: Pick<JpegStructure, 'width' | 'height' | 'components' | 'progressive'> | null = null;
  let scans = 0;
  let orientation = 1;
  let sawExif = false;
  const removed = new Set<string>();
  for (;;) {
    // Markers may be preceded by fill bytes (0xFF).
    if (o >= b.length || b[o] !== 0xff)
      throw new AssetError('malformed', 'a JPEG marker was expected');
    while (o < b.length && b[o] === 0xff) o++;
    if (o >= b.length) throw new AssetError('malformed', 'the JPEG file is cut short');
    const m = b[o++]!;
    if (m === 0xd9) {
      if (!frame || scans === 0)
        throw new AssetError('malformed', 'a JPEG file without image data');
      return { ...frame, scans, orientation, end: o, removed: [...removed].sort() };
    }
    if (m === 0xd8) throw new AssetError('malformed', 'a second start-of-image marker');
    if (m === 0x00 || (m >= 0xd0 && m <= 0xd7))
      throw new AssetError('malformed', 'a stray JPEG marker outside the image data');
    if (m === 0x01) continue; // TEM has no length.
    if (o + 2 > b.length) throw new AssetError('malformed', 'the JPEG file is cut short');
    const len = (b[o]! << 8) | b[o + 1]!;
    if (len < 2 || o + len > b.length)
      throw new AssetError('malformed', 'a JPEG segment runs past the end');
    const seg = b.subarray(o + 2, o + len);
    if (SUPPORTED_SOF.has(m)) {
      if (frame) throw new AssetError('unsupported_content', 'more than one JPEG frame');
      if (seg.length < 6) throw new AssetError('malformed', 'a short JPEG frame header');
      const precision = seg[0]!;
      const height = (seg[1]! << 8) | seg[2]!;
      const width = (seg[3]! << 8) | seg[4]!;
      const components = seg[5]!;
      if (precision !== 8)
        throw new AssetError(
          'unsupported_content',
          `${precision}-bit JPEG samples are not supported`,
        );
      if (height === 0)
        throw new AssetError(
          'unsupported_content',
          'a JPEG whose height is given later (DNL) is not supported',
        );
      checkPixels(width, height, limits);
      if (components !== 1 && components !== 3 && components !== 4)
        throw new AssetError(
          'unsupported_content',
          `a JPEG with ${components} components is not supported`,
        );
      if (seg.length !== 6 + 3 * components)
        throw new AssetError('malformed', 'a JPEG frame header of the wrong size');
      for (let c = 0; c < components; c++) {
        const hv = seg[7 + 3 * c]!;
        const h = hv >> 4;
        const v = hv & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4)
          throw new AssetError('malformed', 'a JPEG sampling factor out of range');
      }
      frame = { width, height, components, progressive: m === 0xc2 };
    } else if (OTHER_SOF.has(m)) {
      throw new AssetError(
        'unsupported_content',
        'lossless, hierarchical and arithmetic-coded JPEG files are not supported',
      );
    } else if (m === 0xda) {
      if (!frame) throw new AssetError('malformed', 'JPEG image data before the frame header');
      if (++scans > limits.maxJpegScans)
        throw new AssetError('scan_limit', `more than ${limits.maxJpegScans} JPEG scans`);
      // Skip the entropy-coded data: it ends at a marker other than a stuffed zero or a restart.
      let p = o + len;
      for (;;) {
        if (p + 1 >= b.length)
          throw new AssetError('malformed', 'the JPEG image data is cut short');
        if (b[p] === 0xff) {
          const n = b[p + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) {
            p += n === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        p++;
      }
      o = p;
      continue;
    } else if (m >= 0xe0 && m <= 0xef) {
      removed.add(`APP${m - 0xe0}`);
      if (
        m === 0xe1 &&
        !sawExif &&
        seg.length > 6 &&
        String.fromCharCode(...seg.subarray(0, 6)) === 'Exif\0\0'
      ) {
        sawExif = true;
        orientation = exifOrientation(seg.subarray(6));
      }
    } else if (m === 0xfe) {
      removed.add('COM');
    }
    o += len;
  }
}

/** Applies an Exif orientation to RGBA pixels; returns the new pixels and dimensions. */
export function orient(
  rgba: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { data: Uint8Array; width: number; height: number } {
  if (orientation === 1) return { data: rgba, width, height };
  const swap = orientation >= 5;
  const w2 = swap ? height : width;
  const h2 = swap ? width : height;
  const out = new Uint8Array(rgba.length);
  const src32 = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const dst32 = new Uint32Array(out.buffer, out.byteOffset, width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dx: number;
      let dy: number;
      switch (orientation) {
        case 2:
          dx = width - 1 - x;
          dy = y;
          break;
        case 3:
          dx = width - 1 - x;
          dy = height - 1 - y;
          break;
        case 4:
          dx = x;
          dy = height - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = height - 1 - y;
          dy = x;
          break;
        case 7:
          dx = height - 1 - y;
          dy = width - 1 - x;
          break;
        default:
          dx = y;
          dy = width - 1 - x;
          break; // 8
      }
      dst32[dy * w2 + dx] = src32[y * width + x]!;
    }
  }
  return { data: out, width: w2, height: h2 };
}

/** Decodes a JPEG upload and writes its pixels, upright, into a new JPEG. */
export function processJpeg(b: Uint8Array, limits: ContentLimits): Processed {
  const s = parseJpeg(b, limits);
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = jpeg.decode(b.subarray(0, s.end), {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: true,
      maxResolutionInMP: limits.maxPixels / 1_000_000,
      maxMemoryUsageInMB: limits.maxDecodeMiB,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : '';
    if (/maxMemoryUsageInMB|maxResolutionInMP/.test(msg))
      throw new AssetError('pixel_limit', 'decoding the JPEG would pass the decoder memory limit');
    throw new AssetError(
      'decode_failed',
      `the JPEG decoder refused the file (${msg.slice(0, 80)})`,
    );
  }
  if (
    decoded.width !== s.width ||
    decoded.height !== s.height ||
    decoded.data.length !== s.width * s.height * 4
  )
    throw new AssetError(
      'decode_failed',
      'the JPEG decoder returned other dimensions than the header',
    );
  const upright = orient(decoded.data, s.width, s.height, s.orientation);
  let encoded: Uint8Array;
  try {
    const e = jpeg.encode(
      { data: upright.data, width: upright.width, height: upright.height },
      limits.jpegQuality,
    );
    encoded = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  } catch (e) {
    throw new AssetError(
      'decode_failed',
      `the JPEG encoder failed (${e instanceof Error ? e.message.slice(0, 80) : 'error'})`,
    );
  }
  const notes = s.removed.map((t) => `removed:${t}`);
  if (s.end < b.length) notes.push('trailing_data_removed');
  if (s.orientation !== 1) notes.push(`orientation_applied:${s.orientation}`);
  return {
    detected: JPEG,
    width: upright.width,
    height: upright.height,
    frames: 1,
    keepOriginal: false,
    outputs: [{ role: 'display', mime: JPEG, data: checkOutput(encoded, limits) }],
    notes,
  };
}
