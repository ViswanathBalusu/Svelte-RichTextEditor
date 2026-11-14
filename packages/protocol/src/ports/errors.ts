/**
 * Errors the ports reject with (decisions D22, D23). Both carry a registry code (05 §5.8), so the
 * component reacts to every failure the same way whatever the backend.
 */
import type * as W from '../generated/types.ts';
import type { ErrorCode, SyncReject } from './types.ts';

/** A failure of a port call: a REST problem, a channel refusal, a closed channel. */
export class PortError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  /** The REST problem details or socket error, when the failure came from the server. */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryAfterMs?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.details !== undefined) this.details = opts.details;
  }
}

/**
 * `submit()` rejects with this when the server answers `sync.reject` (decision D22): an `Error`
 * whose own members are those of the payload, so it is also a `SyncReject`.
 */
export class SyncRejectError extends Error implements SyncReject {
  readonly id: string;
  readonly code: SyncReject['code'];
  readonly action: W.RejectAction;
  readonly head: number;
  readonly scopes?: W.ScopeId[];
  readonly rule?: string;
  readonly retryAfterMs?: number;

  constructor(reject: SyncReject) {
    super(reject.message);
    this.name = 'SyncRejectError';
    this.id = reject.id;
    this.code = reject.code;
    this.action = reject.action;
    this.head = reject.head;
    if (reject.scopes !== undefined) this.scopes = reject.scopes;
    if (reject.rule !== undefined) this.rule = reject.rule;
    if (reject.retryAfterMs !== undefined) this.retryAfterMs = reject.retryAfterMs;
  }

  /** The wire payload. */
  toJSON(): SyncReject {
    const out: SyncReject = {
      id: this.id,
      code: this.code,
      message: this.message,
      action: this.action,
      head: this.head,
    };
    if (this.scopes !== undefined) out.scopes = this.scopes;
    if (this.rule !== undefined) out.rule = this.rule;
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    return out;
  }
}

export const isSyncReject = (e: unknown): e is SyncRejectError => e instanceof SyncRejectError;
export const isPortError = (e: unknown): e is PortError => e instanceof PortError;
