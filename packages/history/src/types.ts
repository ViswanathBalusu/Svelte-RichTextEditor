/**
 * Types shared by the history functions (08; ADR 0051, proposed).
 *
 * Users are the tenant's surrogate identifiers (08 §13); agents are the delegated assistant
 * identities the room stamps from the authenticated connection (04 G6), never a client's claim.
 */

/** Who inserted a stretch of content, and with which commit (08 §7). */
export interface Author {
  user: string;
  /** The commit that inserted the content (0 for the content the document was created with). */
  seq: number;
  /** The assistant that wrote it for `user`, when one acted (08 §7, 13 §6.2). */
  agent?: string;
  /** The user whose restore brought the content back (08 §7). */
  restoredBy?: string;
  /** The restore commit that brought it back. */
  restoredSeq?: number;
}

/** The commit metadata the history list and the comparisons read (08 §2; 06 §4.1). */
export interface CommitMeta {
  seq: number;
  kind: 'steps' | 'control' | 'snapshot';
  user: string;
  /** The session; empty or `system` for a commit the server authored. */
  session: string;
  agent?: string;
  /** Server time, Unix milliseconds. */
  time: number;
  origin: string;
  /** The scopes the commit changed (07 §5.1), as the per-scope table holds them. */
  scopes: readonly string[];
}

/** The kinds of stored versions (08 §4). */
export type VersionKind =
  'named' | 'export' | 'pre-restore' | 'restore' | 'import' | 'sent' | 'completed';

export const VERSION_KINDS: readonly VersionKind[] = [
  'named',
  'export',
  'pre-restore',
  'restore',
  'import',
  'sent',
  'completed',
];

/** A stored version: a pointer to a `seq` with a kind (08 §4). */
export interface StoredVersion {
  seq: number;
  kind: VersionKind;
  name?: string;
  note?: string;
  createdBy: string;
  /** Server time, Unix milliseconds. */
  createdAt: number;
}

/**
 * The caller's history visibility gate (07 §8; ADR 0034, proposed): `min` is `minVisibleSeq`, a
 * single state is visible at or above it, at the head and at a named version, and a run of commits
 * only from a `seq` at or above it.
 */
export interface HistoryGate {
  min: number;
  head: number;
  /** Whether a named version points at `seq`. */
  named?: (seq: number) => boolean;
}

/** Why a history function refused: codes of the DEP registry (05 §5.8; spec/dep/dep-1.registry.json). */
export type HistoryErrorCode =
  'forbidden' | 'not_found' | 'validation_failed' | 'workflow_active' | 'conflict' | 'internal';

export interface HistoryError {
  ok: false;
  code: HistoryErrorCode;
  reason: string;
}

export type HistoryResult<T> = ({ ok: true } & T) | HistoryError;

export function refuse(code: HistoryErrorCode, reason: string): HistoryError {
  return { ok: false, code, reason };
}
