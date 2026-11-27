/**
 * The conventions of 05 §6.1 for every route (PRO-040 to PRO-042; BE-032): JSON bodies with a
 * size limit, ETags and If-Match, opaque cursors, page limits, CORS headers and the request
 * identifier (D71).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError, problemOf } from './problems.ts';

/**
 * 05 §6.1: the headers a browser may send and read. `DEP-Request-Id` is added by D71,
 * `DEP-Idempotent-Replayed` by D140.
 */
export const CORS_ALLOW_HEADERS = [
  'Authorization',
  'Content-Type',
  'If-Match',
  'Idempotency-Key',
  'DEP-Actor',
  'traceparent',
];
export const CORS_EXPOSE_HEADERS = [
  'ETag',
  'Retry-After',
  'Deprecation',
  'Sunset',
  'DEP-Request-Id',
  'DEP-Idempotent-Replayed',
];
export const REQUEST_ID_HEADER = 'DEP-Request-Id';

/** 05 §6.1: lists have a `limit` of at most 200; 50 when absent (D72). */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/**
 * How much of a refused body is read and thrown away, and for how long. A server that answers 413
 * and closes the socket while the client is still uploading makes the client see a reset instead
 * of the answer (RFC 9110 §15.5.14). The discard is bounded, so a refusal stays cheap. These are
 * design values of this service, not figures of the specification.
 */
export const REFUSED_BODY_DISCARD_BYTES = 32 * 1024 * 1024;
export const REFUSED_BODY_DISCARD_MS = 5_000;

/**
 * Reads a JSON body of at most `maxBytes`; undefined when there is none. A body above the limit
 * is read to its end and dropped (within the discard cap and time), then refused with `too_large`,
 * so the client has finished sending when the 413 goes out. Past the cap the request is destroyed.
 */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  let over = Number.isFinite(declared) && declared > maxBytes;
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const startDiscard = (): void => {
    timer = setTimeout(() => req.destroy(), REFUSED_BODY_DISCARD_MS);
  };
  if (over) startDiscard();
  try {
    for await (const chunk of req) {
      const b = chunk as Buffer;
      size += b.length;
      if (!over && size > maxBytes) {
        over = true;
        chunks.length = 0;
        startDiscard();
      }
      if (over) {
        if (size > REFUSED_BODY_DISCARD_BYTES) req.destroy();
        continue;
      }
      chunks.push(b);
    }
  } catch (e) {
    // Destroyed by the cap or the timer: the refusal still goes out if the socket allows it.
    if (!over) throw e;
  } finally {
    clearTimeout(timer);
  }
  if (over) throw new ApiError('too_large', `the body is larger than ${maxBytes} bytes`);
  if (size === 0) return undefined;
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
  if (type !== 'application/json' && type !== 'application/merge-patch+json')
    throw new ApiError('validation_failed', 'the body must be application/json', {
      violations: [{ path: '', rule: 'Content-Type is application/json' }],
    });
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message quotes the body; report the rule only (BE-088 criterion 3).
    throw new ApiError('validation_failed', 'the body is not valid JSON', {
      violations: [{ path: '', rule: 'valid JSON (RFC 8259)' }],
    });
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  sendBytes(res, status, bytes, { 'Content-Type': 'application/json', ...headers });
}

export function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Buffer | null,
  headers: Record<string, string> = {},
): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (bytes) res.setHeader('Content-Length', String(bytes.length));
  res.statusCode = status;
  res.end(bytes ?? undefined);
}

export function sendProblem(
  res: ServerResponse,
  e: ApiError,
  requestId: string,
  headers: Record<string, string> = {},
): void {
  const extra: Record<string, string> = { ...headers };
  if (e.retryAfterS !== undefined) extra['Retry-After'] = String(e.retryAfterS);
  if (e.code === 'unauthenticated' || e.code === 'token_expired' || e.code === 'revoked')
    extra['WWW-Authenticate'] = e.challenge ?? 'Bearer error="invalid_token"';
  sendJson(res, e.status, problemOf(e, requestId), {
    'Content-Type': 'application/problem+json',
    ...extra,
  });
}

/** The entity tags of `If-Match`: `*`, a list, or null when the header is absent. */
export function ifMatchTags(req: IncomingMessage): '*' | string[] | null {
  const h = req.headers['if-match'];
  if (h === undefined) return null;
  const value = Array.isArray(h) ? h.join(',') : h;
  if (value.trim() === '*') return '*';
  // Strong comparison (RFC 9110 §13.1.1): a weak tag never matches.
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.startsWith('"'));
}

/**
 * The precondition of an update (05 §6.1; D61): 428 with `precondition_failed` when If-Match is
 * missing, 412 when it does not name `current`.
 */
export function checkIfMatch(req: IncomingMessage, current: string, required = true): void {
  const tags = ifMatchTags(req);
  if (tags === null) {
    if (!required) return;
    throw new ApiError('precondition_failed', 'the update needs If-Match with the current ETag', {
      status: 428,
    });
  }
  if (tags === '*' || tags.includes(current)) return;
  throw new ApiError('precondition_failed', 'the resource changed since the ETag was read');
}

/** Opaque, signed cursors (05 §6.1; D72): a cursor the server did not issue is refused. */
export class Cursors {
  readonly #key: Buffer;

  constructor(key: Uint8Array) {
    this.#key = Buffer.from(key);
  }

  #mac(value: string): Buffer {
    return createHmac('sha256', this.#key).update(value, 'utf8').digest().subarray(0, 16);
  }

  issue(route: string, value: string): string {
    const payload = Buffer.from(JSON.stringify([route, value]), 'utf8');
    return `${payload.toString('base64url')}.${this.#mac(`${route}\n${value}`).toString('base64url')}`;
  }

  open(route: string, cursor: string): string {
    const bad = () =>
      new ApiError('validation_failed', 'the cursor was not issued for this list', {
        violations: [{ path: 'cursor', rule: 'a nextCursor of the same list' }],
      });
    const [p, m] = cursor.split('.');
    if (!p || !m) throw bad();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw bad();
    }
    if (!Array.isArray(parsed) || parsed[0] !== route || typeof parsed[1] !== 'string') throw bad();
    const want = this.#mac(`${route}\n${parsed[1]}`);
    const got = Buffer.from(m, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
    return parsed[1];
  }
}

/** `limit` of a list: 1 to 200, 50 when absent (D72). */
export function pageLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > MAX_LIMIT)
    throw new ApiError('validation_failed', `limit is an integer from 1 to ${MAX_LIMIT}`, {
      violations: [{ path: 'limit', rule: `an integer from 1 to ${MAX_LIMIT}` }],
    });
  return n;
}

/** A non-negative integer query parameter, or undefined. */
export function seqParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n))
    throw new ApiError('validation_failed', `${name} is a sequence number`, {
      violations: [{ path: name, rule: 'a non-negative integer' }],
    });
  return n;
}
