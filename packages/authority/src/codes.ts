/**
 * Rejection codes and client actions of 04 §5 and §8, and the limits the authority applies. The
 * full error registry (HTTP statuses, close codes) is the protocol's (PRO-038).
 */

export type RejectCode =
  | 'permission_denied'
  | 'read_only'
  | 'busy'
  | 'invalid_op'
  | 'stale_base'
  | 'rebase_failed'
  | 'too_large'
  | 'rate_limited'
  | 'unavailable'
  | 'conflict'
  | 'field_invalid';

export type RejectAction = 'rebase' | 'drop' | 'reload' | 'retry';

/** Default client action per code (04 §8). `invalid_op` may also carry `reload`. */
export const DEFAULT_ACTION: Readonly<Record<RejectCode, RejectAction>> = {
  stale_base: 'rebase',
  rebase_failed: 'rebase',
  permission_denied: 'drop',
  conflict: 'drop',
  field_invalid: 'drop',
  invalid_op: 'drop',
  too_large: 'drop',
  busy: 'retry',
  rate_limited: 'retry',
  unavailable: 'retry',
  read_only: 'drop',
};

export interface Limits {
  maxStepsPerCommit: number;
  maxCommitBytes: number;
  maxRebaseSteps: number;
  /** Most commits streamed on resume (04 §9; 05 §5.1 `catchUpCommits`); the default when absent. */
  catchUpCommits?: number;
  /** Most bytes streamed on resume (04 §9; 05 §5.1 `catchUpBytes`); the default when absent. */
  catchUpBytes?: number;
}

/** 04 §3.1, §5 step 3 and §9 defaults. */
export const DEFAULT_LIMITS: Limits = {
  maxStepsPerCommit: 500,
  maxCommitBytes: 1024 * 1024,
  maxRebaseSteps: 5000,
  catchUpCommits: 5000,
  catchUpBytes: 5 * 1024 * 1024,
};

/** Origins a client may claim (04 §3.1); recorded, never trusted. */
export const CLIENT_ORIGINS = [
  'input',
  'paste',
  'format',
  'undo',
  'redo',
  'suggestion.accept',
  'suggestion.reject',
  'fill',
  'assistant',
] as const;

/** Origins reserved for commits the server authors (04 §3.1, §10). */
export const SERVER_ORIGINS = [
  'restore',
  'import',
  'migration',
  'repair',
  'sign',
  'rules',
  'prefill',
  'control',
] as const;

export type ClientOrigin = (typeof CLIENT_ORIGINS)[number];
export type ServerOrigin = (typeof SERVER_ORIGINS)[number];
export type Origin = ClientOrigin | ServerOrigin;

/** A result that never throws (SYN-001). */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; code: RejectCode; reason: string; scopes?: string[]; rule?: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(code: RejectCode, reason: string, scopes?: string[]): Result<T> =>
  scopes ? { ok: false, code, reason, scopes } : { ok: false, code, reason };
