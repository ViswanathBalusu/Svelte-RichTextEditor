/**
 * The room's messages and storage contract (04 §5, §7 to §9; 05 §5). Message names follow DEP
 * (`sync.ack`, `sync.commit`, `sync.reject`, `sync.reset`, `ch.opened`, `sync.caughtUp`,
 * `perm.changed`, `ch.closed`) in a compact in-process form; the wire format is PRO's.
 *
 * Every change since spike S3 is additive: new optional fields, new message and outcome variants,
 * and the snapshot commit as a type of its own (`SnapshotCommit`), so that code written against
 * `StoredCommit` keeps compiling.
 */
import type { RejectAction, RejectCode } from '../codes.ts';
import type { Access } from '../permissions/access.ts';
import type { Connection, PermissionState } from '../permissions/model.ts';
import type { StepJson } from '../steps.ts';
import type { ThreadAnchor } from './threads.ts';
import type { WorkflowStatusMessage } from '../workflow/state-view.ts';

export const ENGINE = 'pm-steps/1';

/**
 * The session recorded for commits the server authors: control commits and the commits of 04 §10.
 * DEP renders it as a null session (`author.session`, 05 §5.3).
 */
export const SERVER_SESSION = 'system';

/** The user recorded for server-authored commits that no user requested (04 §10). */
export const SYSTEM_USER = 'system';

export interface CommitInput {
  id: string;
  base: number;
  steps: unknown;
  origin?: string;
}

export interface StoredCommit {
  seq: number;
  id: string;
  kind: 'steps' | 'control';
  /** The steps as applied (after rebasing). Empty for control commits. */
  steps: StepJson[];
  user: string;
  session: string;
  /** The delegated assistant identity of the connection, when it has one (G6); never the client's claim. */
  agent?: string;
  /** Server time, Unix milliseconds (G6). */
  time: number;
  origin: string;
  /** Scopes the commit changed (07 §5.1), recorded for history and for P9. */
  scopes: string[];
  /** Grants revision the commit was checked against (G7). */
  revision: number;
  cdm: number;
  engine: string;
  /** Region identifiers this commit removed; retired for good (I3). */
  retired: string[];
  /** Suggestion identifiers first used by this commit (P4). */
  claimed: string[];
  /** The `base` the commit was submitted with (08 §2); absent for control commits. */
  base?: number;
  /** Whether the commit was rebased before it was applied (08 §2); absent for control commits. */
  rebased?: boolean;
  /** The `jti` of the token the submitting channel was opened with (08 §2), when the host passed it. */
  jti?: string;
  /**
   * The document's `requires` after this commit, present only when the commit added a feature
   * (03 §11.1; CDM-047; ADR 0050 item 5). A host that enables `RoomInit.requiresGrowth` stores it
   * with the commit and in the document's record; a room replaying the log applies it.
   */
  requires?: string[];
  /**
   * The salted hash of the workflow evidence of one signing or completion, on a control commit that
   * only anchors it (12 §7; ADR 0013; FRW-041). Never the evidence and never the salt. Such a
   * control commit does not record a grants revision.
   */
  evidence?: EvidenceAnchor;
}

/** What a control commit carries of workflow evidence: the origin and the salted hash. */
export interface EvidenceAnchor {
  readonly origin: 'sign' | 'rules' | 'decline';
  /** SHA-256 over the salt and the canonical evidence, lower-case hex. */
  readonly evidenceHash: string;
}

/** Why a snapshot commit replaced the document (04 §3.2; 05 §5.3 `sync.reset`). */
export type SnapshotReason = 'import' | 'restore' | 'migration' | 'repair';

export const SNAPSHOT_REASONS: readonly SnapshotReason[] = [
  'import',
  'restore',
  'migration',
  'repair',
];

/**
 * A snapshot commit (04 §3.2; SYN-005): it replaces the document with the content of a checkpoint
 * instead of listing steps. Its payload is the checkpoint reference (08 §2). Clients receive
 * `sync.reset` for it, never `sync.commit`.
 */
export interface SnapshotCommit extends Omit<StoredCommit, 'kind' | 'steps'> {
  kind: 'snapshot';
  /** Always empty: the content is in the checkpoint. */
  steps: [];
  snapshot: {
    /** The checkpoint that holds the new content (08 §3); opaque to the room. */
    checkpoint: string;
    reason: SnapshotReason;
  };
}

/** Any commit of the log. */
export type LogCommit = StoredCommit | SnapshotCommit;

export function isSnapshot(c: LogCommit): c is SnapshotCommit {
  return c.kind === 'snapshot';
}

export interface Resume {
  seq: number;
  incarnation: string;
  inflight: string | null;
  /**
   * The view token of the `ch.opened` the client's confirmed document came from (read
   * restrictions, ADR 0019). A resume under another view becomes a reload.
   */
  view?: string;
}

/**
 * Claims of the connection's token that the room records or uses besides those of `Connection`
 * (05 §3.1). Both are optional, so a plain `Connection` is a `RoomConnection`.
 */
export interface SessionClaims {
  /** The token's `jti`, recorded with every commit the channel submits (08 §2). */
  jti?: string;
  /** The token's `access_since` claim, Unix milliseconds, for the `since_access` setting (08 §9). */
  accessSince?: number;
  /**
   * The CDM features the client announced in `ch.open` (03 §11.1; 05 §5.2; CDM-047). When given,
   * the room refuses a channel whose client lacks a feature the document requires, and counts the
   * channel when a commit would add a feature. When absent, the room checks nothing on open.
   */
  features?: readonly string[];
}

export type RoomConnection = Connection & SessionClaims;

/** Content at a sequence number, as the room sends it inline (DEP serves it over REST, 05 §6.2). */
export interface InlineContent {
  seq: number;
  doc: unknown;
  requires: string[];
  /** The log incarnation `seq` belongs to (04 §1; SYN-029). */
  incarnation?: string;
}

/** Why the room closed a channel; a DEP close reason (05 §5.2) can be derived from it. */
export type CloseReason =
  /** Another writer holds the document (04 §5, "When a write fails"). */
  | 'fenced'
  /** The outcome of a write is unknown and the log could not be read back. */
  | 'lost'
  /** The host stopped the room (eviction, shutdown, a storage failure it could not settle). */
  | 'stopped'
  /**
   * The reader's visibility class changed (ADR 0019, decision item 6). PRO-130 gives it a close
   * code of its own; until then it travels as this reason with code `unavailable`.
   */
  | 'access_changed';

export type ToClient =
  | { t: 'sync.ack'; id: string; seq: number; time: number; rebased: boolean; steps?: StepJson[] }
  | { t: 'sync.commit'; commit: StoredCommit }
  | {
      t: 'sync.reject';
      id: string;
      code: RejectCode;
      action: RejectAction;
      head: number;
      reason: string;
      scopes?: string[];
      /** With `rate_limited`: how long the client waits before it resubmits (04 §12; SYN-037). */
      retryAfterMs?: number;
      /**
       * With `permission_denied` for a fill: the identifier of the rule that hid or disabled the
       * field, so that the editor can explain it (12 §5.3; 05 §5.3 `rule`; FRW-022).
       */
      rule?: string;
    }
  | {
      /** A snapshot commit was stored (04 §3.2, §8): the client replaces its confirmed document. */
      t: 'sync.reset';
      seq: number;
      reason: SnapshotReason;
      /** Content at `seq` (REST in DEP, `GET …/content?seq`; inline here, as in `ch.opened`). */
      content: InlineContent;
      /** The view token of the projection the content belongs to (ADR 0019). */
      view?: string;
    }
  | {
      t: 'ch.opened';
      head: number;
      incarnation: string;
      /**
       * `stream`: the missing commits follow, then `sync.caughtUp`. `page`: the client reads them
       * over REST (`GET …/commits?after=`); live commits from `head + 1` follow. `reload`: the
       * client replaces its confirmed document with `content` (04 §9; ADR 0034).
       */
      catchUp: 'stream' | 'page' | 'reload';
      inflight: null | { state: 'accepted'; seq: number } | { state: 'unknown' };
      access: Access;
      /**
       * The workflow of the document, for this connection (12 §10; FRW-035): its state and the
       * connection's own participant status. Present only when the document has a workflow.
       */
      workflow?: WorkflowStatusMessage;
      /** Content at `head` when the client has none or must reload (REST in DEP; inline here). */
      content?: InlineContent;
      /** The view token of the projection this channel serves (ADR 0019); echoed in a later resume. */
      view?: string;
    }
  | { t: 'sync.caughtUp'; head: number }
  /**
   * The divergence check (04 §13; SYN-043): the SHA-256 of the canonical form of the durable
   * document at `seq`. A client whose confirmed document is at `seq` compares it with its own.
   */
  | { t: 'sync.check'; seq: number; hash: string }
  /**
   * `refresh` marks the access sent ahead of a `permission_denied` rejection (04 §8; SYN-020): no
   * control commit follows it, so a bridge that holds `perm.changed` for one sends it at once.
   */
  | { t: 'perm.changed'; revision: number; access: Access; refresh?: true }
  /**
   * The workflow state or the connection's own participant status changed (12 §10; FRW-035): a
   * complete object, sent like `perm.changed`. When the change alters what the connection may do,
   * `perm.changed` is sent as well, ahead of it.
   */
  | { t: 'wf.changed'; workflow: WorkflowStatusMessage }
  | { t: 'ch.closed'; code: 'unavailable'; reason?: CloseReason };

export interface Outbound {
  channel: string;
  msg: ToClient;
}

/** A write of a batch of commits, conditional on the ownership epoch and the grants revision (04 §5 step 9). */
export interface WriteRequest {
  epoch: number;
  revision: number;
  fromSeq: number;
  commits: StoredCommit[];
  /**
   * A snapshot commit (04 §3.2), always written alone: when it is present, `commits` is empty and
   * `fromSeq` is its `seq`. Only a host that calls `Room.snapshot` makes the room write one, so a
   * store without snapshot support never receives it.
   */
  snapshot?: SnapshotCommit;
}

export type WriteResult =
  | { status: 'ok' }
  | { status: 'failed' }
  /** The outcome is unknown; `tail` is the log after the room's durable head, read back from storage. */
  | { status: 'unknown'; tail: LogCommit[] }
  /** The grants revision moved; `perms` is the current permission state read back from storage. */
  | { status: 'revision_moved'; perms: PermissionState }
  /** The ownership epoch or the primary key shows another writer. */
  | { status: 'fenced' }
  /**
   * A commit of the batch has an identifier that is already stored (04 §5: a conflict on the
   * commit identifier alone is a duplicate, never another writer). `stored` is the stored commit;
   * nothing of the batch was written.
   */
  | { status: 'duplicate'; stored: LogCommit }
  /** The outcome is unknown and the log could not be read back: the room stops serving. */
  | { status: 'lost' };

/** A checkpoint the host should write from the durable state (08 §3; BE-020). */
export interface CheckpointRequest {
  seq: number;
  /** The durable document at `seq` (a ProseMirror node; serialise it with `toJSON()`). */
  doc: unknown;
  /** `snapshot`: the checkpoint right before a snapshot commit, so that replays need not cross it. */
  reason: 'snapshot';
  /** The comment anchors at `seq`, saved with the checkpoint (ADR 0015; SYN-032). */
  threads?: ThreadAnchor[];
}

export interface Effects {
  send: Outbound[];
  write: WriteRequest | null;
  /** Checkpoints to write from the durable state (08 §3: "around every snapshot commit"). */
  checkpoints?: CheckpointRequest[];
  /**
   * A channel the room would not open, and why (03 §11.1; CDM-047): the host answers the client
   * with `ch.rejected` and the code. Nothing else is sent to the channel.
   */
  refused?: { channel: string; code: 'unsupported_feature'; missing: string[] };
}

export interface ChannelInfo {
  conn: Connection;
}
