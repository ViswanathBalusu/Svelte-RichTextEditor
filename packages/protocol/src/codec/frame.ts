/**
 * Text-frame codec of the real-time plane (05 §4; PRO-004, PRO-017 groundwork).
 *
 * `decodeFrame` never throws and never executes anything from the frame: it parses JSON, checks the
 * envelope, looks the type up and validates the payload against the definition. Its classification
 * follows decision D03:
 * - not JSON, not an object, no `t`, or mistyped envelope members: fatal, close 4400;
 * - larger than `maxMessageBytes`: fatal, close 4413 (05 §5.7);
 * - a known type in the wrong direction or with an invalid payload: a non-fatal `error`
 *   `bad_message`, with `re` when the frame had an `id`;
 * - an unknown type: ignored, and answered with `error` `unknown_type`, `fatal: false`, when it had
 *   an `id` (05 §1 rule 3).
 */
import { DEP1_WIRE, type WireDefinition } from '../definition/wire.ts';
import type { MessageDef } from '../definition/messages.ts';
import type { DepMessage, ErrorMessage } from '../generated/types.ts';
import { ShapeValidator, type Violation } from './validate.ts';

export type Receiver = 'server' | 'client';

export type DecodeResult =
  | { kind: 'message'; message: DepMessage }
  | {
      kind: 'unknown';
      t: string;
      /** The `error` to send back, when the frame carried an `id`. */
      reply?: ErrorMessage;
    }
  | {
      kind: 'invalid';
      code: 'bad_message' | 'too_large';
      fatal: boolean;
      /** Close code for a fatal error (05 §5.7). */
      close?: 4400 | 4413;
      reason: string;
      violations: Violation[];
      /** The `error` to send back (with `re` when the frame had an `id`). */
      reply: ErrorMessage;
    };

export interface DecodeOptions {
  /** Which side is decoding: a server receives client-to-server messages. */
  receiver: Receiver;
  /** The limit announced in `welcome`; frames above it are refused with 4413. */
  maxMessageBytes?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** UTF-8 length of a string without encoding it. */
export function utf8Length(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

export class FrameCodec {
  readonly def: WireDefinition;
  private readonly validator: ShapeValidator;
  private readonly byType: ReadonlyMap<string, MessageDef>;

  constructor(def: WireDefinition = DEP1_WIRE) {
    this.def = def;
    this.validator = new ShapeValidator(def);
    this.byType = new Map(def.messages.map((m) => [m.t, m]));
  }

  /** The definition of a message type, if known. */
  message(t: string): MessageDef | undefined {
    return this.byType.get(t);
  }

  /** Validates a message object (an envelope) against its definition; empty when valid. */
  check(message: unknown, receiver?: Receiver): Violation[] {
    if (!isObject(message)) return [{ path: '', message: 'expected an object' }];
    const env = envelopeViolations(message);
    if (env.length) return env;
    const t = message['t'] as string;
    const def = this.byType.get(t);
    if (!def) return [{ path: '/t', message: `unknown message type ${t}` }];
    const out: Violation[] = [];
    if (receiver && !accepts(def, receiver))
      out.push({ path: '/t', message: `${t} is not sent to a ${receiver}` });
    if (def.id === 'required' && message['id'] === undefined)
      out.push({ path: '/id', message: 'is required' });
    if (def.re === 'required' && message['re'] === undefined)
      out.push({ path: '/re', message: 'is required' });
    if (def.ch === 'required' && message['ch'] === undefined)
      out.push({ path: '/ch', message: 'is required' });
    if (def.payload) {
      if (message['d'] === undefined) out.push({ path: '/d', message: 'is required' });
      else out.push(...this.validator.check(def.payload, message['d'], '/d'));
    }
    return out;
  }

  decode(text: string, opts: DecodeOptions): DecodeResult {
    if (opts.maxMessageBytes !== undefined && utf8Length(text) > opts.maxMessageBytes)
      return invalid(
        'too_large',
        true,
        4413,
        `the frame is larger than ${opts.maxMessageBytes} bytes`,
        [],
        undefined,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return invalid('bad_message', true, 4400, 'the frame is not JSON', [], undefined);
    }
    if (!isObject(parsed))
      return invalid('bad_message', true, 4400, 'the frame is not a JSON object', [], undefined);
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : undefined;
    const env = envelopeViolations(parsed);
    if (env.length) return invalid('bad_message', true, 4400, 'the envelope is malformed', env, id);
    const t = parsed['t'] as string;
    const def = this.byType.get(t);
    if (!def) {
      if (id === undefined) return { kind: 'unknown', t };
      return {
        kind: 'unknown',
        t,
        reply: errorReply('unknown_type', `unknown message type ${t}`, id),
      };
    }
    const violations = this.check(parsed, opts.receiver);
    if (violations.length)
      return invalid('bad_message', false, undefined, `invalid ${t}`, violations, id);
    return { kind: 'message', message: parsed as unknown as DepMessage };
  }

  /**
   * Encodes a message as one text frame, members in the order `t`, `id`, `re`, `ch`, `d`.
   * Validates first unless `validate` is false (tests encode invalid frames on purpose).
   */
  encode(message: DepMessage | Record<string, unknown>, opts: { validate?: boolean } = {}): string {
    const m = message as Record<string, unknown>;
    if (opts.validate !== false) {
      const v = this.check(m);
      if (v.length)
        throw new FrameError(
          `invalid ${String(m['t'])}: ${v.map((x) => `${x.path} ${x.message}`).join('; ')}`,
          v,
        );
    }
    const ordered: Record<string, unknown> = { t: m['t'] };
    for (const k of ['id', 're', 'ch', 'd']) if (m[k] !== undefined) ordered[k] = m[k];
    for (const [k, v] of Object.entries(m)) if (!(k in ordered) && v !== undefined) ordered[k] = v;
    return JSON.stringify(ordered);
  }
}

export class FrameError extends Error {
  readonly violations: readonly Violation[];
  constructor(message: string, violations: readonly Violation[]) {
    super(message);
    this.name = 'FrameError';
    this.violations = violations;
  }
}

function accepts(def: MessageDef, receiver: Receiver): boolean {
  return def.dir === 'both' || (receiver === 'server' ? def.dir === 'c2s' : def.dir === 's2c');
}

/** Envelope member types (05 §4): `t` a non-empty string, `id` and `re` strings, `ch` an integer, `d` an object. */
function envelopeViolations(m: Record<string, unknown>): Violation[] {
  const out: Violation[] = [];
  if (typeof m['t'] !== 'string' || m['t'].length === 0)
    out.push({ path: '/t', message: 'expected a non-empty string' });
  if (m['id'] !== undefined && typeof m['id'] !== 'string')
    out.push({ path: '/id', message: 'expected a string' });
  if (m['re'] !== undefined && typeof m['re'] !== 'string')
    out.push({ path: '/re', message: 'expected a string' });
  const ch = m['ch'];
  if (ch !== undefined && (typeof ch !== 'number' || !Number.isSafeInteger(ch) || ch < 0))
    out.push({ path: '/ch', message: 'expected a non-negative integer' });
  if (m['d'] !== undefined && !isObject(m['d']))
    out.push({ path: '/d', message: 'expected an object' });
  return out;
}

/** 05 §1 rule 3: an unknown type with an `id` is answered with `unknown_type`, `fatal: false`. */
function errorReply(code: 'unknown_type', message: string, re: string): ErrorMessage {
  return { t: 'error', re, d: { code, message, retryable: false, fatal: false } };
}

function invalid(
  code: 'bad_message' | 'too_large',
  fatal: boolean,
  close: 4400 | 4413 | undefined,
  reason: string,
  violations: Violation[],
  id: string | undefined,
): DecodeResult {
  const reply: ErrorMessage = { t: 'error', d: { code, message: reason, retryable: false, fatal } };
  if (id !== undefined) reply.re = id;
  return close === undefined
    ? { kind: 'invalid', code, fatal, reason, violations, reply }
    : { kind: 'invalid', code, fatal, close, reason, violations, reply };
}

let shared: FrameCodec | undefined;

/** The codec of DEP 1.0 with the registered extensions. */
export function depCodec(): FrameCodec {
  shared ??= new FrameCodec(DEP1_WIRE);
  return shared;
}
