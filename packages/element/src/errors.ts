/**
 * Failures as the element reports them: a code of the error registry (05 §5.8) and a message
 * without document content or tokens. Backends reject with a `PortError` (decisions D22, D23); the
 * check is structural, so that a backend built against another copy of `@docedit/protocol` is
 * understood as well, and so that this module imports nothing at run time.
 */
import type { ErrorCode } from '@docedit/protocol';

const CODE = /^[a-z][a-z_]*$/;
const CODE_WORD = /^[A-Za-z][A-Za-z]*$/;

/** The registry code of a failure; `internal` for anything that is not a port error. */
export function codeOf(e: unknown): ErrorCode {
  if (e !== null && typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) return code as ErrorCode;
  }
  return 'internal';
}

/**
 * The wait a refusal asks for, in milliseconds (`retryAfterMs` of a port error, from `Retry-After`
 * or the `error` message of the wire), or null when it gave none.
 */
export function retryAfterMsOf(e: unknown): number | null {
  if (e !== null && typeof e === 'object') {
    const ms = (e as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  return null;
}

/**
 * A short description for logs: the error's own message, at most 300 characters. Backends write
 * these messages; they must not put content or tokens in them (10 §3.1).
 */
export function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : 'unexpected failure';
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Codes that mean the token source failed or the token was refused (05 §5.8). */
export const AUTH_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'unauthenticated',
  'token_expired',
  'revoked',
]);

/**
 * The kind of quota a quota_exceeded refusal names (owner decision 110): the quota of a
 * sync.reject, or of the socket rror or REST problem a port error carries in details. Null
 * when the refusal named none.
 */
export function quotaOf(e: unknown): string | null {
  if (e === null || typeof e !== 'object') return null;
  const own = (e as { quota?: unknown }).quota;
  if (typeof own === 'string' && CODE_WORD.test(own)) return own;
  const details = (e as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const q = (details as { quota?: unknown }).quota;
    if (typeof q === 'string' && CODE_WORD.test(q)) return q;
  }
  return null;
}
