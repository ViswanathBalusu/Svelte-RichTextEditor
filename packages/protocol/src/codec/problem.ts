/**
 * Conformance checks for the problems the protocol carries: a code of the error registry (05 §5.8)
 * on the surface it names, the retry hint a rate or quota problem must give (PRO-038), and the rule
 * a `field_invalid` rejection must name (PRO-028). The conformance kit calls these on every response
 * it receives; the server's own tests call them on what it sends. Universal: no I/O, never throws.
 *
 * The checks read the registry (`definition/errors.ts`) and the channel-reject list. They do not
 * decide which code a server picks; that belongs to the authority and the rules (SYN, PRM, FRW).
 */
import { CHANNEL_REJECT_CODES, ERRORS, ERROR_CODES, type Surface } from '../definition/errors.ts';
import type { Violation } from './validate.ts';

/**
 * Where a problem is carried. `socket`: the `error` message. `rest`: an RFC 9457 problem document.
 * `sync`: `sync.reject`. `channel-close`: `ch.closed`. `channel-reject`: `ch.rejected`, whose codes
 * are a separate list (05 §5.2).
 */
export type ProblemSurface = Surface | 'channel-reject';

export interface ProblemInput {
  surface: ProblemSurface;
  /** The code as it appears on the wire. Anything but a registry code is a violation. */
  code: unknown;
  /** `retryAfterMs` of the socket `error` or of `sync.reject`, when present. */
  retryAfterMs?: unknown;
  /** The `Retry-After` header of a REST problem (seconds, or an HTTP date), when present. */
  retryAfterHeader?: unknown;
  /** The `rule` of `sync.reject`, when present. */
  rule?: unknown;
}

/** Codes whose surface must carry a retry hint: `retryAfterMs` on the socket, `Retry-After` on REST. */
const RETRY_HINT_CODES: readonly string[] = ['rate_limited', 'quota_exceeded'];

const isNonNegativeInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Violations of one problem; empty when it is a valid problem for its surface. */
export function checkProblem(input: ProblemInput): Violation[] {
  const out: Violation[] = [];
  const { surface, code } = input;

  if (surface === 'channel-reject') {
    if (typeof code !== 'string' || !CHANNEL_REJECT_CODES.includes(code))
      out.push({ path: '/code', message: 'is not a code of ch.rejected' });
    return out;
  }

  if (typeof code !== 'string' || !ERROR_CODES.includes(code)) {
    out.push({ path: '/code', message: 'is not a code of the error registry' });
    return out;
  }
  const def = ERRORS.find((e) => e.code === code);
  if (!def || !def.surfaces.includes(surface))
    out.push({ path: '/code', message: `${code} does not appear on the ${surface} surface` });

  if (RETRY_HINT_CODES.includes(code)) {
    if (surface === 'socket' || surface === 'sync') {
      if (input.retryAfterMs === undefined)
        out.push({ path: '/retryAfterMs', message: `${code} needs retryAfterMs` });
      else if (!isNonNegativeInteger(input.retryAfterMs))
        out.push({ path: '/retryAfterMs', message: 'expected a non-negative integer' });
    } else if (surface === 'rest') {
      const h = input.retryAfterHeader;
      const ok = (typeof h === 'string' && h.length > 0) || isNonNegativeInteger(h);
      if (!ok) out.push({ path: '/Retry-After', message: `${code} needs a Retry-After header` });
    }
  }

  if (surface === 'sync' && code === 'field_invalid') {
    if (typeof input.rule !== 'string' || input.rule.length === 0)
      out.push({ path: '/rule', message: 'field_invalid needs the rule that failed' });
  }

  return out;
}
