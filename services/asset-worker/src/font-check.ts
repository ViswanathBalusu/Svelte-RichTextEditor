/**
 * The supervisor's side of checking a font an administrator adds (BE-048; owner decision 94). It
 * sends the file to the same sandbox as an asset, with the purpose `font`, and reads the reply as
 * hostile input: the frame, the failure reason, and every field of the font's description are
 * checked for type and range before anything is returned.
 *
 * A font that fails the check is a content failure (the answer says which rule); a sandbox that
 * could not run is an `AssetJobError` the caller may retry, as for assets.
 */
import { AssetJobError } from './worker.ts';
import type { Sandbox } from './sandbox-port.ts';
import { isFailureReason, registryCode, type FailureReason } from './sandbox/errors.ts';
import type { FontInfo } from './sandbox/font.ts';
import {
  decodeFrame,
  encodeFrame,
  FrameError,
  REPLY_MAGIC,
  REQUEST_MAGIC,
} from './sandbox/frame.ts';
import { contentLimits, type ContentLimits } from './sandbox/limits.ts';

export type FontCheck =
  | { ok: true; font: FontInfo }
  | {
      ok: false;
      code: 'too_large' | 'validation_failed';
      reason: FailureReason;
      message: string;
    };

const failed = (reason: FailureReason, message: string): FontCheck => ({
  ok: false,
  code: registryCode(reason),
  reason,
  message,
});

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= lo && v <= hi;

function fontInfoOf(v: unknown): FontInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Record<string, unknown>;
  const text = (x: unknown, max: number): x is string =>
    typeof x === 'string' && x.length <= max && !/\p{Cc}/u.test(x);
  if (!text(f['family'], 100) || f['family'].length < 1) return null;
  if (!text(f['subfamily'], 100)) return null;
  if (!isInt(f['weight'], 1, 1000)) return null;
  if (typeof f['bold'] !== 'boolean' || typeof f['italic'] !== 'boolean') return null;
  if (f['format'] !== 'truetype' && f['format'] !== 'opentype' && f['format'] !== 'woff2')
    return null;
  if (!isInt(f['glyphs'], 1, 65535) || !isInt(f['unitsPerEm'], 16, 16384)) return null;
  if (!isInt(f['fsType'], 0, 65535) || !isInt(f['tables'], 1, 1024)) return null;
  return {
    family: f['family'],
    subfamily: f['subfamily'],
    weight: f['weight'],
    bold: f['bold'],
    italic: f['italic'],
    format: f['format'],
    glyphs: f['glyphs'],
    unitsPerEm: f['unitsPerEm'],
    fsType: f['fsType'],
    tables: f['tables'],
  };
}

/**
 * Checks `bytes` as the font type `declared` in the sandbox. The size is checked first, so that a
 * file above the limit never reaches the sandbox.
 */
export async function checkFontFile(
  sandbox: Sandbox,
  bytes: Uint8Array,
  declared: string,
  options: { limits?: Partial<ContentLimits>; signal?: AbortSignal } = {},
): Promise<FontCheck> {
  const limits = contentLimits(options.limits);
  if (bytes.length < 1) return failed('malformed', 'the font is empty');
  if (bytes.length > limits.fontMaxBytes)
    return failed(
      'too_large',
      `${bytes.length} bytes is above the limit of ${limits.fontMaxBytes} bytes for fonts`,
    );
  const request = encodeFrame(REQUEST_MAGIC, { v: 1, declared, limits, purpose: 'font' }, [bytes]);
  const run = await sandbox.run(request, options.signal ? { signal: options.signal } : {});
  if (run.aborted) throw new AssetJobError('internal', 'the check was stopped', false);
  if (run.engineError)
    throw new AssetJobError(
      'unavailable',
      `the sandbox could not run (${run.engineError.slice(0, 120)})`,
      true,
    );
  if (run.timedOut) return failed('resource_limit', 'the sandbox was stopped at its time limit');
  if (run.outputOverflow)
    return failed('output_limit', 'the sandbox wrote more than its output limit');
  if (run.exitCode !== 0)
    return failed('resource_limit', 'the sandbox was stopped at its memory or time limit');
  let header: Record<string, unknown>;
  try {
    const frame = decodeFrame(run.stdout, REPLY_MAGIC);
    if (frame.body.length !== 0 || typeof frame.header !== 'object' || frame.header === null)
      return failed('bad_reply', 'the sandbox reply was not understood');
    header = frame.header as Record<string, unknown>;
  } catch (e) {
    if (e instanceof FrameError) return failed('bad_reply', 'the sandbox reply was not understood');
    throw e;
  }
  if (header['v'] !== 1) return failed('bad_reply', 'the sandbox reply was not understood');
  if (header['ok'] === false) {
    const reason = header['reason'];
    const message = header['message'];
    if (!isFailureReason(reason) || typeof message !== 'string')
      return failed('bad_reply', 'the sandbox reply was not understood');
    return failed(reason, message.slice(0, 300));
  }
  const font = header['ok'] === true ? fontInfoOf(header['font']) : null;
  if (!font) return failed('bad_reply', 'the sandbox reply described the font wrongly');
  return { ok: true, font };
}
