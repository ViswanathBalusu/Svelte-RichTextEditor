/**
 * The byte frames between the supervisor and the sandbox. The sandbox has no network, no mounted
 * path and no credentials, so a job goes in on standard input and comes back on standard output:
 *
 *   frame := magic (4 bytes) | header length (uint32, big-endian) | header (UTF-8 JSON) | body
 *
 * The request's body is the uploaded file; the reply's body is the outputs, one after another, with
 * their lengths in the header. Each side treats what it reads as hostile: the header is bounded and
 * parsed as JSON only, and the body lengths must add up exactly.
 */

export const REQUEST_MAGIC = 'DAW1';
export const REPLY_MAGIC = 'DAR1';
/** Largest header either side accepts. */
export const MAX_HEADER_BYTES = 64 * 1024;

export class FrameError extends Error {
  override name = 'FrameError';
}

function magicBytes(magic: string): Uint8Array {
  const m = new TextEncoder().encode(magic);
  if (m.length !== 4) throw new RangeError('a frame magic is four ASCII bytes');
  return m;
}

/** A frame of `header` (serialised as JSON) and the concatenation of `blobs`. */
export function encodeFrame(
  magic: string,
  header: unknown,
  blobs: readonly Uint8Array[],
): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  if (head.length > MAX_HEADER_BYTES) throw new FrameError('the frame header is too large');
  let size = 8 + head.length;
  for (const b of blobs) size += b.length;
  const out = new Uint8Array(size);
  out.set(magicBytes(magic), 0);
  new DataView(out.buffer).setUint32(4, head.length, false);
  out.set(head, 8);
  let o = 8 + head.length;
  for (const b of blobs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Splits a frame into its parsed header and its body. Throws FrameError on anything unexpected. */
export function decodeFrame(
  data: Uint8Array,
  magic: string,
): { header: unknown; body: Uint8Array } {
  const m = magicBytes(magic);
  if (data.length < 8) throw new FrameError('the frame is shorter than its fixed part');
  for (let i = 0; i < 4; i++)
    if (data[i] !== m[i]) throw new FrameError('the frame does not start with its magic');
  const len = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, false);
  if (len > MAX_HEADER_BYTES) throw new FrameError('the frame header is too large');
  if (8 + len > data.length) throw new FrameError('the frame header is cut short');
  let header: unknown;
  try {
    header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(8, 8 + len)),
    );
  } catch {
    throw new FrameError('the frame header is not JSON');
  }
  return { header, body: data.subarray(8 + len) };
}

/** Splits `body` into blobs of the given lengths, which must cover it exactly. */
export function splitBody(body: Uint8Array, lengths: readonly number[]): Uint8Array[] {
  let total = 0;
  for (const n of lengths) {
    if (!Number.isSafeInteger(n) || n < 0) throw new FrameError('a blob length is not a count');
    total += n;
  }
  if (total !== body.length) throw new FrameError('the blob lengths do not cover the body');
  const out: Uint8Array[] = [];
  let o = 0;
  for (const n of lengths) {
    out.push(body.subarray(o, o + n));
    o += n;
  }
  return out;
}
