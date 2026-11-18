/**
 * One visibility gate wherever a sequence number is supplied (07 §8; 08 §9; HIS-024; ADR 0034 §2).
 * The gate is `minVisibleSeq` of `@docedit/authority`, and its two rules are `stateVisible` (a
 * single state: at or above the gate, at the head) and `rangeVisible` (a run of commits after a
 * `seq`: only from at or above the gate). This module is the one place where the data plane
 * evaluates them: rooms for `resume.seq` (inside the authority's room), and storage-backed reads
 * for content at a `seq` and pages of commits. No caller has a copy of the rule.
 *
 * `SEQ_INPUTS` lists every route parameter and message field that carries a sequence number with
 * the rule that applies or why it is exempt; a test walks the protocol definition and fails on a
 * field that is not listed (HIS-024 criterion 4).
 */
import {
  DEFAULT_HISTORY_VISIBILITY,
  HISTORY_VISIBILITIES,
  editsSomewhere,
  minVisibleSeq,
  rangeVisible,
  regionsOf,
  stateVisible,
  type HistoryVisibility,
  type LogCommit,
  type PermissionState,
  type RoomConnection,
} from '@docedit/authority';

type Doc = Parameters<typeof regionsOf>[0];

export type SeqRule =
  /** A single state at the `seq`: `stateVisible`. */
  | 'state'
  /** The commits after the `seq`: `rangeVisible`. */
  | 'range'
  /** Not gated, with the reason. */
  | 'exempt';

export interface SeqInput {
  /** The message type or the route, as the protocol definition names it. */
  readonly where: string;
  /** The field or parameter, as a path (`resume.seq`, `query.after`). */
  readonly field: string;
  readonly rule: SeqRule;
  /** Who applies it, or why it is exempt. */
  readonly note: string;
}

/**
 * Every place a client supplies a sequence number (07 §8 lists `seq`, `fromSeq`, `toSeq`, `atSeq`,
 * `after`, `baseSeq` and `resume.seq`). Fields the server sends are not inputs and are not listed.
 */
export const SEQ_INPUTS: readonly SeqInput[] = [
  {
    where: 'ch.open',
    field: 'resume.seq',
    rule: 'range',
    note: 'the room: a resume below the gate is answered with reload (ADR 0034 §1)',
  },
  {
    where: 'sync.submit',
    field: 'base',
    rule: 'exempt',
    note: 'a commit reveals nothing: the room rebases it or rejects it with stale_base (04 §5)',
  },
  {
    where: 'presence.update',
    field: 'seq',
    rule: 'exempt',
    note: 'relayed to peers as the sender claims it; it reads nothing (05 §5.4)',
  },
  {
    where: 'GET /documents/{id}/content',
    field: 'query.seq',
    rule: 'state',
    note: 'readContent, and the control plane for reads without a token (service credentials)',
  },
  {
    where: 'GET /documents/{id}/commits',
    field: 'query.after',
    rule: 'range',
    note: 'readCommits (BE-038)',
  },
  {
    where: 'POST /documents/{id}/exports',
    field: 'body.seq',
    rule: 'state',
    note: 'the control plane: export-routes.ts calls minVisibleSeqOf and refuseBelowGate',
  },
  {
    where: 'POST /documents/{id}/versions',
    field: 'body.seq',
    rule: 'state',
    note: 'phase 2 (HIS-026): a named version is created at a visible state',
  },
  {
    where: 'GET /documents/{id}/diff',
    field: 'query.fromSeq',
    rule: 'state',
    note: 'phase 2 (HIS-026): both sides of a comparison are single states (ADR 0034 §2); the route is `diff` in the definition (HIS-024 criterion 4)',
  },
  {
    where: 'GET /documents/{id}/diff',
    field: 'query.toSeq',
    rule: 'state',
    note: 'phase 2 (HIS-026)',
  },
  {
    where: 'GET /documents/{id}/audit-segment',
    field: 'query.fromSeq',
    rule: 'exempt',
    note: 'HIS-037: a start below the gate is raised to the gate, never read; only the chain hash of the record just below it travels (audit-segment-route.ts)',
  },
  {
    where: 'GET /documents/{id}/audit-segment',
    field: 'query.toSeq',
    rule: 'state',
    note: 'HIS-037: an end below the gate is refused with forbidden (auditSegment of @docedit/history)',
  },
  {
    where: 'GET /documents/{id}/history',
    field: 'query.fromSeq',
    rule: 'range',
    note: 'phase 2 (HIS-026): the commits from a seq, grouped (HIS-008); a run, so rangeVisible',
  },
  {
    where: 'GET /documents/{id}/history',
    field: 'query.toSeq',
    rule: 'state',
    note: 'phase 2 (HIS-026): the end of the comparison is a single state',
  },
  {
    where: 'POST /documents/{id}/restore',
    field: 'body.toSeq',
    rule: 'state',
    note: 'phase 2 (HIS-026): restoring reveals the state restored',
  },
  {
    where: 'GET /documents/{id}/threads',
    field: 'query.seq',
    rule: 'state',
    note: 'phase 2 (HIS-026): thread ranges at a state',
  },
  {
    where: 'GET /documents/{id}/field-values',
    field: 'query.seq',
    rule: 'state',
    note: 'packet C (FRW-061): values at a state',
  },
  {
    where: 'POST /documents/{id}/threads',
    field: 'body.target.range.baseSeq',
    rule: 'exempt',
    note: 'mapped forward to the head; reveals nothing older (SYN-033)',
  },
  {
    where: 'GET /documents/{id}/attribution',
    field: 'query.atSeq',
    rule: 'state',
    note: 'phase 2 (HIS-026): the attribution map at a visible state; the member is `atSeq` in the definition since PRO-055 (ADR 0373)',
  },
  {
    where: 'POST /documents/{id}/fork',
    field: 'body.atSeq',
    rule: 'state',
    note: 'phase 2 (HIS-022 criterion 4): a fork at a seq below the caller gate is refused',
  },
  {
    where: 'PUT /documents/{id}/read-marker',
    field: 'body.seq',
    rule: 'exempt',
    note: 'stores the caller own marker and reads nothing; the marker only moves forward (HIS-027 criterion 2)',
  },
];

/** The history setting of a document, with the default for a value the gate does not know. */
export function historySetting(value: string | null | undefined): HistoryVisibility {
  return (HISTORY_VISIBILITIES as readonly string[]).includes(value ?? '')
    ? (value as HistoryVisibility)
    : DEFAULT_HISTORY_VISIBILITY;
}

/** What the gate needs when no room holds the document: the head and the log up to it. */
export interface StoredState {
  setting: HistoryVisibility;
  /** The document at the head (for the regions the user may edit in). */
  head: Doc;
  headSeq: number;
  perms: PermissionState;
  /** The stored commits, or at least their times, by `seq`. */
  log: readonly Pick<LogCommit, 'seq' | 'time'>[];
  now: number;
}

/** `minVisibleSeq(user)` of 07 §8 from stored state (ADR 0034 §2). */
export function gateOf(conn: RoomConnection, s: StoredState): number {
  const times = new Map(s.log.map((c) => [c.seq, c.time]));
  return minVisibleSeq({
    setting: s.setting,
    editsSomewhere: editsSomewhere(conn, regionsOf(s.head), s.perms, s.now),
    accessSince: conn.accessSince,
    head: s.headSeq,
    timeOf: (seq) => times.get(seq),
  });
}

/** Whether the content at `seq` may be read (a single state). */
export function stateAllowed(
  gate: number,
  seq: number,
  head: number,
  named?: (seq: number) => boolean,
): boolean {
  return stateVisible(gate, seq, head, named);
}

/** Whether the commits after `from` may be sent (a run). */
export function rangeAllowed(gate: number, from: number): boolean {
  return rangeVisible(gate, from);
}
