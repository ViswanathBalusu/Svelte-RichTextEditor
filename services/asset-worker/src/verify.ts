/**
 * Reads the sandbox's reply as hostile input (10 §2: "assume a worker can be fully compromised by
 * the input it processes, and treat its outputs as hostile"). The reply frame is bounded and
 * parsed as JSON only; its shape, the outputs a type may have, their sizes, their leading and
 * trailing bytes and the reported dimensions are checked against the configured limits. A
 * sanitised SVG must consist of the elements and attributes the writer produces and nothing else;
 * a PDF rendition must not name actions, scripts, links or embedded files.
 */
import { decodeFrame, FrameError, REPLY_MAGIC, splitBody } from './sandbox/frame.ts';
import { isFailureReason, type FailureReason } from './sandbox/errors.ts';
import type { ContentLimits } from './sandbox/limits.ts';
import type { OutputRole } from './sandbox/output.ts';
import {
  DOCX,
  GIF,
  JPEG,
  PDF,
  PNG,
  SVG,
  type AcceptedType,
  type OutputType,
} from './sandbox/types.ts';

export interface VerifiedOutput {
  role: OutputRole;
  mime: OutputType;
  data: Uint8Array;
}

export type VerifiedReply =
  | {
      ok: true;
      detected: AcceptedType;
      width: number | null;
      height: number | null;
      frames: number | null;
      keepOriginal: boolean;
      outputs: VerifiedOutput[];
      notes: string[];
    }
  | { ok: false; reason: FailureReason; message: string };

/** The outputs each accepted type must produce, by role. */
const EXPECTED: Readonly<Record<AcceptedType, readonly (readonly [OutputRole, OutputType])[]>> = {
  [PNG]: [['display', PNG]],
  [JPEG]: [['display', JPEG]],
  [GIF]: [
    ['display', GIF],
    ['print', PNG],
  ],
  [SVG]: [
    ['display', SVG],
    ['print', PDF],
  ],
  [DOCX]: [],
};

class BadReply extends Error {}

function bad(msg: string): never {
  throw new BadReply(msg);
}

const isCount = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

const startsWith = (b: Uint8Array, sig: readonly number[]): boolean =>
  b.length >= sig.length && sig.every((v, i) => b[i] === v);
const endsWith = (b: Uint8Array, sig: readonly number[]): boolean =>
  b.length >= sig.length && sig.every((v, i) => b[b.length - sig.length + i] === v);
const bytesOf = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

const SVG_TAGS = new Set([
  'svg',
  'defs',
  'path',
  'g',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
]);
const SVG_ATTRS = new Set([
  'xmlns',
  'width',
  'height',
  'viewBox',
  'd',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'id',
  'gradientUnits',
  'gradientTransform',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'fx',
  'fy',
  'fr',
  'offset',
  'stop-color',
  'clip-path',
  'clipPathUnits',
  'clip-rule',
]);

/** Whether `text` is an SVG of only the writer's own elements, attributes and value characters. */
export function isSanitisedSvg(text: string): boolean {
  if (!text.startsWith('<svg xmlns="http://www.w3.org/2000/svg" ')) return false;
  const tag = /<(\/?)([A-Za-z]+)((?:\s+[A-Za-z][A-Za-z0-9-]*="[^"<>&]*")*)\s*(\/?)>/y;
  let i = 0;
  let depth = 0;
  while (i < text.length) {
    if (text[i] === '\n' && i === text.length - 1) return depth === 0;
    tag.lastIndex = i;
    const m = tag.exec(text);
    if (!m) return false;
    i = tag.lastIndex;
    if (!SVG_TAGS.has(m[2]!)) return false;
    for (const a of m[3]!.matchAll(/([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g)) {
      if (!SVG_ATTRS.has(a[1]!)) return false;
      const v = a[2]!;
      if (a[1] === 'xmlns') {
        if (v !== 'http://www.w3.org/2000/svg') return false;
      } else if (!/^[-#a-zA-Z0-9 .,()]*$/.test(v)) return false;
    }
    if (m[1]) depth--;
    else if (!m[4]) depth++;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const PDF_FORBIDDEN =
  /\/(JavaScript|JS|OpenAction|AA|Launch|URI|SubmitForm|ImportData|GoToR|GoToE|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|AcroForm)\b/;

function checkOutputBytes(mime: OutputType, data: Uint8Array): void {
  switch (mime) {
    case PNG:
      if (!startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        bad('a PNG output without its signature');
      if (!endsWith(data, [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]))
        bad('a PNG output without IEND at its end');
      break;
    case JPEG:
      if (!startsWith(data, [0xff, 0xd8, 0xff]) || !endsWith(data, [0xff, 0xd9]))
        bad('a JPEG output without its markers');
      break;
    case GIF:
      if (!startsWith(data, bytesOf('GIF89a')) || !endsWith(data, [0x3b]))
        bad('a GIF output without its signature or trailer');
      break;
    case PDF: {
      if (!startsWith(data, bytesOf('%PDF-1.')) || !endsWith(data, bytesOf('%%EOF\n')))
        bad('a PDF output without its header or end');
      // The writer emits one stream (the page content) and keeps every dictionary outside it, so
      // the dictionaries can be read without inflating anything.
      const text = new TextDecoder('latin1').decode(data);
      if (text.split('\nstream\n').length !== 2) bad('a PDF output with other than one stream');
      const outside = text.replace(/\nstream\n[\s\S]*?\nendstream/, '\nstream\nendstream');
      if (PDF_FORBIDDEN.test(outside) || /\/(ObjStm|XRefStm)\b/.test(outside))
        bad('a PDF output that names actions, links, forms or embedded files');
      break;
    }
    case SVG: {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        return bad('an SVG output that is not UTF-8');
      }
      if (!isSanitisedSvg(text)) bad('an SVG output with something the writer does not produce');
      break;
    }
  }
}

/** Checks a reply against the declared type and the limits; never throws. */
export function readReply(
  stdout: Uint8Array,
  declared: AcceptedType,
  limits: ContentLimits,
): VerifiedReply {
  try {
    const { header, body } = decodeFrame(stdout, REPLY_MAGIC);
    if (typeof header !== 'object' || header === null)
      return bad('the reply header is not an object');
    const h = header as Record<string, unknown>;
    if (h['v'] !== 1) bad('an unknown reply version');
    if (h['ok'] === false) {
      if (body.length !== 0) bad('a failure reply with outputs');
      const reason = h['reason'];
      if (!isFailureReason(reason)) bad('a failure reply without a known reason');
      const message = typeof h['message'] === 'string' ? h['message'].slice(0, 300) : '';
      return { ok: false, reason: reason as FailureReason, message };
    }
    if (h['ok'] !== true) bad('a reply that is neither a success nor a failure');
    if (h['detected'] !== declared) bad('the sandbox reports another type than the one declared');
    const dims = (k: string): number | null => {
      const v = h[k];
      if (v === undefined) return null;
      if (!isCount(v)) return bad(`a reply ${k} that is not a count`);
      return v;
    };
    const width = dims('width');
    const height = dims('height');
    const frames = dims('frames');
    if (width !== null && (width > limits.maxDimension * 2 || width < 1))
      bad('a reported width beyond the limits');
    if (height !== null && (height > limits.maxDimension * 2 || height < 1))
      bad('a reported height beyond the limits');
    if (frames !== null && frames > limits.maxFrames)
      bad('a reported frame count beyond the limit');
    const keepOriginal = h['keepOriginal'];
    if (typeof keepOriginal !== 'boolean') bad('a reply without keepOriginal');
    if (keepOriginal !== (declared === DOCX)) bad('keepOriginal does not fit the type');
    const notes = h['notes'];
    if (
      !Array.isArray(notes) ||
      notes.length > 64 ||
      !notes.every((n) => typeof n === 'string' && /^[a-z0-9_:.-]{1,80}$/i.test(n))
    )
      bad('reply notes that are not short identifiers');
    const outs = h['outputs'];
    if (!Array.isArray(outs)) return bad('a reply without outputs');
    const expected = EXPECTED[declared];
    if (outs.length !== expected.length) bad('the reply has the wrong number of outputs');
    const lengths: number[] = [];
    outs.forEach((o: unknown, i) => {
      const rec = (typeof o === 'object' && o !== null ? o : {}) as Record<string, unknown>;
      const [role, mime] = expected[i]!;
      if (rec['role'] !== role || rec['mime'] !== mime) bad('an output of the wrong role or type');
      if (!isCount(rec['bytes']) || rec['bytes'] < 1 || rec['bytes'] > limits.outputMaxBytes)
        bad('an output of the wrong size');
      lengths.push(rec['bytes'] as number);
    });
    const blobs = splitBody(body, lengths);
    const outputs: VerifiedOutput[] = blobs.map((data, i) => {
      const [role, mime] = expected[i]!;
      checkOutputBytes(mime, data);
      return { role, mime, data };
    });
    return {
      ok: true,
      detected: declared,
      width,
      height,
      frames,
      keepOriginal,
      outputs,
      notes: notes as string[],
    };
  } catch (e) {
    if (e instanceof BadReply || e instanceof FrameError)
      return {
        ok: false,
        reason: 'bad_reply',
        message: `the sandbox's reply was refused (${e.message.slice(0, 120)})`,
      };
    return { ok: false, reason: 'bad_reply', message: "the sandbox's reply could not be read" };
  }
}
