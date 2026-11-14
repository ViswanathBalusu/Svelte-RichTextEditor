/**
 * The rules for creating a stored version (08 §4; HIS-006, HIS-007): which kinds exist, which
 * `seq` may be named, and that a second creation for the same document, `seq` and kind returns the
 * version already stored. The service stores what this returns and raises the events (HIS-006 and
 * HIS-007 criteria it owns are not ticked here).
 *
 * A caller passes `canEdit`, whether the requester holds `edit` somewhere in the document (the
 * service computes it with `editsSomewhere`, 08 §9). The gate is the requester's `HistoryGate`
 * (ADR 0034): a `seq` below `gate.min` is refused as `forbidden`, as the rest of 08 does, and a
 * `seq` above the head is a validation failure.
 */
import {
  type HistoryGate,
  type HistoryResult,
  type StoredVersion,
  VERSION_KINDS,
  type VersionKind,
  refuse,
} from './types.ts';

export interface VersionRequest {
  seq: number;
  /** The requested kind, as sent; checked against `VERSION_KINDS`. */
  kind: string;
  name?: string;
  note?: string;
  createdBy: string;
  /** Server time, Unix milliseconds. */
  createdAt: number;
}

export interface VersionRules {
  /** Whether the requester holds `edit` somewhere in the document (08 §9). */
  canEdit: boolean;
  /** The head of the document: the highest `seq` that exists. */
  head: number;
  gate: HistoryGate;
}

export interface VersionCreation {
  version: StoredVersion;
  /** False when a version with the same `seq` and kind already existed and was returned instead. */
  created: boolean;
}

export function isVersionKind(kind: string): kind is VersionKind {
  return (VERSION_KINDS as readonly string[]).includes(kind);
}

/**
 * Creates a version, or returns the stored one with the same `seq` and kind (HIS-007 criterion 5).
 * Checks, in order: the requester may edit; the kind is one of 08 §4's; the `seq` is a sequence
 * number at or below the head; the `seq` is visible to the requester (HIS-006 criterion 3).
 */
export function createVersion(
  existing: readonly StoredVersion[],
  req: VersionRequest,
  rules: VersionRules,
): HistoryResult<VersionCreation> {
  if (!rules.canEdit)
    return refuse('forbidden', 'naming a version needs edit somewhere in the document');
  const kind = req.kind;
  if (!isVersionKind(kind))
    return refuse('validation_failed', `kind ${kind} is not a version kind`);
  if (!Number.isSafeInteger(req.seq) || req.seq < 0)
    return refuse('validation_failed', `seq ${req.seq} is not a sequence number`);
  if (req.seq > rules.head)
    return refuse('validation_failed', `seq ${req.seq} is above the head ${rules.head}`);
  if (req.seq < rules.gate.min)
    return refuse('forbidden', `seq ${req.seq} is below your visibility gate`);
  const found = existing.find((v) => v.seq === req.seq && v.kind === kind);
  if (found) return { ok: true, version: found, created: false };
  const version: StoredVersion = {
    seq: req.seq,
    kind,
    createdBy: req.createdBy,
    createdAt: req.createdAt,
  };
  if (req.name !== undefined) version.name = req.name;
  if (req.note !== undefined) version.note = req.note;
  return { ok: true, version, created: true };
}
