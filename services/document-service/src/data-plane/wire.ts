/**
 * Close codes, error codes and refusals of the real-time plane (05 §5.2, §5.7, §5.8; PRO-037).
 * Every connection the data plane closes ends with one of the nine close codes of 05 §5.7, after
 * an `error` whose code implies it (decision D25), except a `hello` that never came (4408), which
 * has no code of its own in the registry.
 */
import { DEP1, type ChannelRejected, type ErrorPayload } from '@docedit/protocol';

export const CLOSE = {
  badMessage: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  noVersion: 4406,
  helloTimeout: 4408,
  tooLarge: 4413,
  rateLimited: 4429,
  internal: 4500,
  unavailable: 4503,
} as const;

export type SocketErrorCode = ErrorPayload['code'];

const SOCKET_CODES = new Set<string>(
  DEP1.errors.filter((e) => e.surfaces.includes('socket')).map((e) => e.code),
);

/** The close code a fatal error code implies (D25); 4500 for a code without one. */
export function closeCodeOf(code: SocketErrorCode): number {
  return DEP1.errors.find((e) => e.code === code)?.closeCode ?? CLOSE.internal;
}

/** Whether the registry marks a code as retryable in any way (05 §5.8). */
export function retryable(code: SocketErrorCode): boolean {
  const r = DEP1.errors.find((e) => e.code === code)?.retryable ?? 'no';
  return r !== 'no';
}

/** An error code from a thrown value: its `code` when the registry knows it on the socket. */
export function socketCodeOf(e: unknown): SocketErrorCode | undefined {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && SOCKET_CODES.has(code) ? (code as SocketErrorCode) : undefined;
}

/** A channel that cannot be opened: answered with `ch.rejected` (05 §5.2; PRO-023). */
export class Refusal extends Error {
  override name = 'Refusal';
  readonly code: ChannelRejected['code'];
  constructor(code: ChannelRejected['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** An error the control plane can map to a problem response (05 §6.1): `code` is a registry code. */
export class DataPlaneError extends Error {
  override name = 'DataPlaneError';
  readonly code:
    | 'forbidden'
    | 'not_found'
    | 'unavailable'
    | 'validation_failed'
    | 'conflict'
    | 'too_large'
    | 'workflow_active'
    | 'rate_limited'
    | 'field_invalid';
  /** With `unavailable` or `rate_limited`: how long to wait before retrying. */
  readonly retryAfterMs: number | undefined;
  constructor(code: DataPlaneError['code'], message: string, retryAfterMs?: number) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The room refused a server-authored commit (04 §10): the `sync.reject` it sent the requester,
 * with the REST code a caller answers with (ADR 0053, decision D123).
 */
export class RequestRefused extends DataPlaneError {
  override name = 'RequestRefused';
  readonly rejection: { code: string; action: string; reason: string };
  constructor(rejection: { code: string; action: string; reason: string }) {
    super(restCodeOf(rejection.code), rejection.reason);
    this.rejection = rejection;
  }
}

/** The REST code for a rejection of a server-authored commit (D123). */
export function restCodeOf(syncCode: string): DataPlaneError['code'] {
  switch (syncCode) {
    case 'permission_denied':
    case 'forbidden':
      return 'forbidden';
    case 'read_only':
    case 'conflict':
    case 'stale_base':
    case 'rebase_failed':
      return 'conflict';
    case 'invalid_op':
      return 'validation_failed';
    case 'too_large':
      return 'too_large';
    case 'rate_limited':
      return 'rate_limited';
    case 'field_invalid':
      return 'field_invalid';
    default:
      return 'unavailable';
  }
}
