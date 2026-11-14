/**
 * Content limits of the asset worker (BE-043 criterion 4; SEC-038). 06 §4.4 and 10 §3.5 require
 * limits on pixels, frames, archive entries, sizes and ratios but give no numbers (BE and SEC open
 * questions), so every value here is a setting with a default, proposed in ADR 0043 and listed in
 * the package README for operators. None of them is a measurement.
 *
 * The supervisor sends the configured values to the sandbox with each job, so the sandbox and the
 * tests always use the same numbers (SEC-038 criterion 5).
 */

export interface ContentLimits {
  /** Largest upload of a raster image (PNG, JPEG, GIF), bytes. */
  imageMaxBytes: number;
  /** Largest upload of an SVG file, bytes. */
  svgMaxBytes: number;
  /** Largest upload of a Word file, bytes. */
  docxMaxBytes: number;
  /** Largest width × height of an image or of a GIF's logical screen. */
  maxPixels: number;
  /** Largest width or height, pixels. */
  maxDimension: number;
  /** Largest estimated decoder memory for one image, MiB (PNG and JPEG decoding). */
  maxDecodeMiB: number;
  /** Most frames of an animated image (GIF frames, APNG frames). */
  maxFrames: number;
  /** Most pixels decoded across all frames of an animated image. */
  maxTotalFramePixels: number;
  /** Most scans of a progressive JPEG. */
  maxJpegScans: number;
  /** Most chunks of a PNG file. */
  maxPngChunks: number;
  /** Largest re-encoded output, bytes, per output. */
  outputMaxBytes: number;
  /** Most entries of an archive (counted from its directory, before anything is expanded). */
  zipMaxEntries: number;
  /** Largest total uncompressed size of an archive's entries, bytes. */
  zipMaxTotalBytes: number;
  /** Largest uncompressed size of one entry, bytes. */
  zipMaxEntryBytes: number;
  /** Largest ratio of uncompressed to compressed size of one entry. */
  zipMaxRatio: number;
  /** Entries no larger than this (uncompressed) are not held to the ratio limit, bytes. */
  zipRatioFloorBytes: number;
  /** Most elements of an SVG file. */
  svgMaxElements: number;
  /** Deepest element nesting of an SVG file. */
  svgMaxDepth: number;
  /** Most shapes drawn after `<use>` references are expanded (reference bombs). */
  svgMaxDrawn: number;
  /** Most path commands across an SVG file, after `<use>` expansion. */
  svgMaxPathCommands: number;
  /** JPEG re-encoding quality, 1 to 100. */
  jpegQuality: number;
}

export const DEFAULT_CONTENT_LIMITS: Readonly<ContentLimits> = Object.freeze({
  imageMaxBytes: 20 * 1024 * 1024,
  svgMaxBytes: 4 * 1024 * 1024,
  docxMaxBytes: 64 * 1024 * 1024,
  // Chosen so that an image at the limit fits the sandbox's default memory (1024 MiB): see the
  // measurement in ADR 0043. jpeg-js uses more than twice what it accounts for itself.
  maxPixels: 20_000_000,
  maxDimension: 16_384,
  maxDecodeMiB: 448,
  maxFrames: 500,
  maxTotalFramePixels: 200_000_000,
  maxJpegScans: 100,
  maxPngChunks: 65_536,
  outputMaxBytes: 48 * 1024 * 1024,
  zipMaxEntries: 4096,
  zipMaxTotalBytes: 256 * 1024 * 1024,
  zipMaxEntryBytes: 128 * 1024 * 1024,
  zipMaxRatio: 100,
  zipRatioFloorBytes: 64 * 1024,
  svgMaxElements: 20_000,
  svgMaxDepth: 64,
  svgMaxDrawn: 50_000,
  svgMaxPathCommands: 500_000,
  jpegQuality: 90,
});

const KEYS = Object.keys(DEFAULT_CONTENT_LIMITS) as (keyof ContentLimits)[];

/** The defaults with `overrides` applied; every value must be a positive safe integer. */
export function contentLimits(overrides: Partial<ContentLimits> = {}): ContentLimits {
  const out = { ...DEFAULT_CONTENT_LIMITS } as ContentLimits;
  for (const [k, v] of Object.entries(overrides)) {
    if (!(KEYS as string[]).includes(k)) throw new RangeError(`unknown content limit ${k}`);
    if (v === undefined) continue;
    out[k as keyof ContentLimits] = v;
  }
  checkContentLimits(out);
  return out;
}

/** Throws unless `value` is a complete set of limits (used on the request inside the sandbox). */
export function checkContentLimits(value: unknown): asserts value is ContentLimits {
  if (typeof value !== 'object' || value === null) throw new RangeError('limits are an object');
  const rec = value as Record<string, unknown>;
  for (const k of KEYS) {
    const v = rec[k];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1)
      throw new RangeError(`the content limit ${k} must be a positive integer`);
  }
  for (const k of Object.keys(rec))
    if (!(KEYS as string[]).includes(k)) throw new RangeError(`unknown content limit ${k}`);
  if ((rec['jpegQuality'] as number) > 100) throw new RangeError('jpegQuality is at most 100');
}
