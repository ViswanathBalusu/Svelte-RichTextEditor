/**
 * Reconnection (05 §4): exponential backoff from 0.5 seconds, doubling to at most 30 seconds, with
 * full jitter; after `goaway` the client follows the server's hint instead. And what a client does
 * when the socket closes, by close code (05 §5.7) and the error that preceded it (05 §5.8).
 */
import type { ErrorCode, ErrorPayload } from '../generated/types.ts';

export interface BackoffPolicy {
  initialMs: number;
  maxMs: number;
}

/** The figures of 05 §4. */
export const BACKOFF: Readonly<BackoffPolicy> = { initialMs: 500, maxMs: 30_000 };

/**
 * The delay before reconnection attempt `attempt` (0 for the first): uniform in [0, cap), where the
 * cap starts at `initialMs` and doubles up to `maxMs` ("full jitter").
 */
export function backoffDelay(
  attempt: number,
  random: () => number,
  policy: Readonly<BackoffPolicy> = BACKOFF,
): number {
  const cap = Math.min(policy.maxMs, policy.initialMs * 2 ** Math.max(0, Math.min(attempt, 30)));
  const r = random();
  return Math.floor((r >= 0 && r < 1 ? r : 0) * cap);
}

/** What a client does after the socket closed. */
export type Reconnect =
  /** Reconnect after a backoff delay (or the server's hint). */
  | 'backoff'
  /** Reconnect with a new token from the token source (05 §5.8: "after a new token"). */
  | 'new-token'
  /** Do not reconnect: the session cannot be continued without a change on the client's side. */
  | 'no';

export interface CloseVerdict {
  /** The registry code that describes the close, for `de-error` and `PortError`. */
  code: ErrorCode;
  reconnect: Reconnect;
  /** From the preceding `error` (`retryAfterMs`), when it gave one. */
  retryAfterMs?: number;
}

/**
 * Classifies a close (05 §5.7). `lastFatal` is the fatal `error` the server sent before closing,
 * whose code is more precise than the close code (for example `token_expired` under 4401).
 * Codes outside 05 §5.7 (1000, 1001, 1006 and the like) are network or shutdown closes: back off.
 */
export function classifyClose(code: number, lastFatal?: ErrorPayload | null): CloseVerdict {
  const withRetry = (v: CloseVerdict): CloseVerdict =>
    lastFatal?.retryAfterMs !== undefined ? { ...v, retryAfterMs: lastFatal.retryAfterMs } : v;
  switch (code) {
    case 4400:
      // 05 §5.8: `bad_message` is not retryable; the client reports a bug (PRO-039 criterion 6).
      return { code: 'bad_message', reconnect: 'no' };
    case 4401: {
      const c = lastFatal?.code;
      return {
        code: c === 'token_expired' || c === 'revoked' ? c : 'unauthenticated',
        reconnect: 'new-token',
      };
    }
    case 4403:
      return { code: 'forbidden', reconnect: 'no' };
    case 4406:
      return { code: 'unsupported_version', reconnect: 'no' };
    case 4413:
      return withRetry({ code: 'too_large', reconnect: 'backoff' });
    case 4429:
      return withRetry({ code: 'rate_limited', reconnect: 'backoff' });
    case 4500:
      return withRetry({ code: 'internal', reconnect: 'backoff' });
    default:
      // 4408 (hello not received in time), 4503 (unavailable or draining), network closes.
      return withRetry({ code: 'unavailable', reconnect: 'backoff' });
  }
}
