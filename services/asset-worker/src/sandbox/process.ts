/**
 * What the sandbox does with one upload (BE-043; 10 §3.5): normalise the declared type, refuse
 * types the worker does not accept, apply the byte limit of the type, detect the real type from
 * the bytes and fail on a mismatch, then hand the file to its format's module, which checks its
 * structure against the limits before decoding and writes fresh outputs.
 *
 * `handleRequest` is the whole job as bytes in and bytes out (the frames of frame.ts). It runs
 * inside the Podman sandbox (main.ts), and in-process only in tests and development.
 */
import { AssetError, type FailureReason } from './errors.ts';
import { decodeFrame, encodeFrame, REPLY_MAGIC, REQUEST_MAGIC } from './frame.ts';
import { isFontType, processFont, type FontInfo } from './font.ts';
import { processGif } from './gif.ts';
import { processJpeg } from './jpeg.ts';
import { checkContentLimits, type ContentLimits } from './limits.ts';
import type { OutputRole, Processed } from './output.ts';
import { processPng } from './png.ts';
import { processSvg } from './svg.ts';
import {
  detectType,
  DOCX,
  GIF,
  isAcceptedType,
  JPEG,
  kindOf,
  normaliseMime,
  PNG,
  SVG,
  ZIP,
  type AcceptedType,
  type OutputType,
} from './types.ts';
import { processDocx } from './zip.ts';

export type ProcessResult =
  | ({ ok: true } & Processed)
  | { ok: false; reason: FailureReason; message: string; detected?: string };

/** The byte limit of an accepted type. */
export function byteLimit(t: AcceptedType, limits: ContentLimits): number {
  const kind = kindOf(t);
  return kind === 'svg'
    ? limits.svgMaxBytes
    : kind === 'docx'
      ? limits.docxMaxBytes
      : limits.imageMaxBytes;
}

/** Checks an upload's declared type and size; null when acceptable, otherwise the failure. */
export function checkDeclared(
  declared: string,
  size: number,
  limits: ContentLimits,
): { reason: FailureReason; message: string } | null {
  const t = normaliseMime(declared);
  if (!isAcceptedType(t))
    return { reason: 'unsupported_type', message: `the type ${t.slice(0, 100)} is not accepted` };
  if (!Number.isSafeInteger(size) || size < 1)
    return { reason: 'malformed', message: 'the size must be a positive integer' };
  const max = byteLimit(t, limits);
  if (size > max)
    return {
      reason: 'too_large',
      message: `${size} bytes is above the limit of ${max} bytes for ${t}`,
    };
  return null;
}

/** Processes one upload whose client declared `declared`. Never throws for a bad file. */
export async function processAsset(
  input: Uint8Array,
  declared: string,
  limits: ContentLimits,
): Promise<ProcessResult> {
  let detected: string | undefined;
  try {
    const bad = checkDeclared(declared, input.length, limits);
    if (bad) return { ok: false, ...bad };
    const want = normaliseMime(declared) as AcceptedType;
    detected = detectType(input);
    // A ZIP archive is a Word file only if its directory says so (zip.ts); otherwise compare.
    if (!(want === DOCX && detected === ZIP) && detected !== want)
      return {
        ok: false,
        reason: 'type_mismatch',
        message: `declared ${want}, detected ${detected}`,
        detected,
      };
    let r: Processed;
    switch (want) {
      case PNG:
        r = await processPng(input, limits);
        break;
      case JPEG:
        r = processJpeg(input, limits);
        break;
      case GIF:
        r = processGif(input, limits);
        break;
      case SVG:
        r = processSvg(input, limits);
        break;
      case DOCX:
        r = await processDocx(input, limits);
        break;
    }
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof AssetError)
      return { ok: false, reason: e.reason, message: e.message, ...(detected ? { detected } : {}) };
    // A decoder bug or an exhausted heap: the file fails, the sandbox stays up for the reply.
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : 'error';
    return {
      ok: false,
      reason:
        e instanceof RangeError && /allocat|memory|Array buffer/i.test(msg)
          ? 'pixel_limit'
          : 'decode_failed',
      message: `processing failed (${msg.slice(0, 120)})`,
      ...(detected ? { detected } : {}),
    };
  }
}

/** The request the supervisor sends. */
export interface SandboxRequest {
  v: 1;
  declared: string;
  limits: ContentLimits;
  /** What the upload is for; absent means a document asset. `font` is an administrator's font (BE-048). */
  purpose?: 'asset' | 'font';
}

/** The reply the sandbox sends; the body holds the outputs in order. */
export type SandboxReply =
  | {
      v: 1;
      ok: true;
      detected: AcceptedType;
      width?: number;
      height?: number;
      frames?: number;
      keepOriginal: boolean;
      outputs: { role: OutputRole; mime: OutputType; bytes: number }[];
      notes: string[];
    }
  | { v: 1; ok: false; reason: FailureReason; message: string; detected?: string };

/** The reply to a font check (BE-048): the file is kept as uploaded, so there are no outputs. */
export type FontReply =
  { v: 1; ok: true; font: FontInfo } | { v: 1; ok: false; reason: FailureReason; message: string };

/** Checks one font upload as bytes in and a reply out; never throws for a bad file. */
export function processFontRequest(
  input: Uint8Array,
  declared: string,
  limits: ContentLimits,
): FontReply {
  const t = normaliseMime(declared);
  if (!isFontType(t))
    return {
      v: 1,
      ok: false,
      reason: 'unsupported_type',
      message: `the type ${t.slice(0, 100)} is not a font type`,
    };
  try {
    return { v: 1, ok: true, font: processFont(input, t, limits) };
  } catch (e) {
    if (e instanceof AssetError) return { v: 1, ok: false, reason: e.reason, message: e.message };
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : 'error';
    return {
      v: 1,
      ok: false,
      reason: 'decode_failed',
      message: `processing failed (${msg.slice(0, 120)})`,
    };
  }
}

/** The whole job: a request frame in, a reply frame out. */
export async function handleRequest(frame: Uint8Array): Promise<Uint8Array> {
  let req: SandboxRequest;
  let body: Uint8Array;
  try {
    const d = decodeFrame(frame, REQUEST_MAGIC);
    const h = d.header as Partial<SandboxRequest>;
    if (h.v !== 1 || typeof h.declared !== 'string') throw new Error('bad request');
    checkContentLimits(h.limits);
    if (h.purpose !== undefined && h.purpose !== 'asset' && h.purpose !== 'font')
      throw new Error('bad purpose');
    req = {
      v: 1,
      declared: h.declared,
      limits: h.limits,
      ...(h.purpose ? { purpose: h.purpose } : {}),
    };
    body = d.body;
  } catch {
    const reply: SandboxReply = {
      v: 1,
      ok: false,
      reason: 'malformed',
      message: 'the request was not understood',
    };
    return encodeFrame(REPLY_MAGIC, reply, []);
  }
  if (req.purpose === 'font')
    return encodeFrame(REPLY_MAGIC, processFontRequest(body, req.declared, req.limits), []);
  const r = await processAsset(body, req.declared, req.limits);
  if (!r.ok) {
    const reply: SandboxReply = { v: 1, ok: false, reason: r.reason, message: r.message };
    if (r.detected) reply.detected = r.detected;
    return encodeFrame(REPLY_MAGIC, reply, []);
  }
  const reply: SandboxReply = {
    v: 1,
    ok: true,
    detected: r.detected,
    keepOriginal: r.keepOriginal,
    outputs: r.outputs.map((o) => ({ role: o.role, mime: o.mime, bytes: o.data.length })),
    notes: r.notes,
  };
  if (r.width !== undefined) reply.width = r.width;
  if (r.height !== undefined) reply.height = r.height;
  if (r.frames !== undefined) reply.frames = r.frames;
  return encodeFrame(
    REPLY_MAGIC,
    reply,
    r.outputs.map((o) => o.data),
  );
}
