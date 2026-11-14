/**
 * What processing a file produces inside the sandbox, and the PNG encoder that several formats
 * share. Every output is a fresh file written from decoded pixels or from a parsed drawing, so no
 * byte of the upload (metadata, comments, appended payloads) is copied into it (10 §3.5).
 */
import { PNG as PngJs } from 'pngjs';
import { AssetError } from './errors.ts';
import type { ContentLimits } from './limits.ts';
import type { AcceptedType, OutputType } from './types.ts';

/** `display` is what the editor shows; `print` is what the typesetter includes (09 §2). */
export type OutputRole = 'display' | 'print';

export interface Output {
  role: OutputRole;
  mime: OutputType;
  data: Uint8Array;
}

export interface Processed {
  detected: AcceptedType;
  width?: number;
  height?: number;
  frames?: number;
  /** The upload itself is the asset (a Word file kept unchanged, EXP-108); no outputs. */
  keepOriginal: boolean;
  outputs: Output[];
  /** Short identifiers of what was removed or changed, for tests and diagnostics. */
  notes: string[];
}

export function checkOutput(data: Uint8Array, limits: ContentLimits): Uint8Array {
  if (data.length > limits.outputMaxBytes)
    throw new AssetError(
      'output_limit',
      `a re-encoded output of ${data.length} bytes is above the limit of ${limits.outputMaxBytes}`,
    );
  return data;
}

/** Whether every pixel of RGBA data is opaque. */
export function isOpaque(rgba: Uint8Array): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/** Whether every pixel of RGBA data is grey (R = G = B). */
export function isGrey(rgba: Uint8Array): boolean {
  for (let i = 0; i < rgba.length; i += 4)
    if (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2]) return false;
  return true;
}

/** A new 8-bit PNG of RGBA pixels, in the smallest of grey, grey and alpha, RGB or RGBA. */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) throw new RangeError('RGBA data of the wrong length');
  const png = new PngJs({ width, height });
  png.data = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const opaque = isOpaque(rgba);
  const grey = isGrey(rgba);
  const colorType = grey ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const out = PngJs.sync.write(png, {
    colorType,
    inputColorType: 6,
    inputHasAlpha: true,
    bitDepth: 8,
    deflateLevel: 9,
  });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
