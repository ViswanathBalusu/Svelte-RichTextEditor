/**
 * Errors of the control plane as RFC 9457 problem documents (05 §6.1; PRO-038, PRO-040; BE-032).
 * Every code comes from the registry of 05 §5.8 and its HTTP status from the registry too
 * (decision D61), so a handler can only fail with a code the protocol defines.
 */
import { DEP1, type ErrorCode } from '@docedit/protocol';

/** The codes a REST problem may carry: the registry's codes with the REST surface. */
export type RestCode = Extract<
  ErrorCode,
  | 'unauthenticated'
  | 'token_expired'
  | 'revoked'
  | 'forbidden'
  | 'not_found'
  | 'already_open'
  | 'channel_limit'
  | 'conflict'
  | 'field_invalid'
  | 'too_large'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'precondition_failed'
  | 'validation_failed'
  | 'pending_suggestions'
  | 'workflow_active'
  | 'idempotency_mismatch'
  | 'unavailable'
  | 'internal'
>;

const STATUS: ReadonlyMap<string, number> = new Map(
  DEP1.errors.flatMap((e) => (e.httpStatus ? [[e.code, e.httpStatus] as const] : [])),
);

/** The HTTP status of a REST code (D61). */
export function statusOf(code: RestCode): number {
  const s = STATUS.get(code);
  if (s === undefined) throw new Error(`the registry gives ${code} no HTTP status`);
  return s;
}

/** A violation of a request body: where, and which rule; never the offending value (D71; BE-088). */
export interface BodyViolation {
  path: string;
  rule: string;
  /**
   * Only for a field whose value does not match its pattern when a participant completes: the
   * message the author gave in the field's definition (12 §3.2 `validation.message`; FRW-018
   * criterion 4). A text of the document's definitions, never a value.
   */
  message?: string;
}

export interface ApiErrorOptions {
  /** Another status for the same code: 428 for a missing If-Match (D61). */
  status?: number;
  violations?: readonly BodyViolation[];
  /** For `rate_limited`, `quota_exceeded` and `unavailable`: the `Retry-After` header (05 §5.8). */
  retryAfterS?: number;
  /**
   * For `rate_limited`, when the limit's own wait is not a whole number of seconds (the access code
   * of FRW-039): the wait in milliseconds, sent as `retryAfterMs` in the problem and, rounded up,
   * as `Retry-After`.
   */
  retryAfterMs?: number;
  /**
   * For the codes answered with 401: the `WWW-Authenticate` challenge. Default
   * `Bearer error="invalid_token"`; a request without credentials gets a bare `Bearer` (RFC 6750
   * §3).
   */
  challenge?: string;
  cause?: unknown;
}

/**
 * An error a request ends with. `message` is the problem's `detail`: it must name identifiers,
 * positions and rules only, never document text, values or credentials (BE-088).
 */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly code: RestCode;
  readonly status: number;
  readonly violations: readonly BodyViolation[] | undefined;
  readonly retryAfterS: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly challenge: string | undefined;

  constructor(code: RestCode, detail: string, opts: ApiErrorOptions = {}) {
    super(detail, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.status = opts.status ?? statusOf(code);
    this.violations = opts.violations;
    this.retryAfterS =
      opts.retryAfterS ??
      (opts.retryAfterMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(opts.retryAfterMs / 1000)));
    this.retryAfterMs = opts.retryAfterMs;
    this.challenge = opts.challenge;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** The problem document of an error (05 §6.1; D71). */
export function problemOf(e: ApiError, requestId: string): Record<string, unknown> {
  return {
    type: 'about:blank',
    title: REASONS[e.status] ?? 'Error',
    status: e.status,
    detail: e.message,
    code: e.code,
    requestId,
    ...(e.violations?.length ? { violations: e.violations } : {}),
    ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
  };
}
