/**
 * The room: the authority algorithm of 04 §5 as a deterministic state machine (SYN-006 to SYN-016,
 * SYN-005, SYN-026, SYN-029, SYN-030, SYN-037).
 *
 * It holds the durable state (as of the last stored commit) and the tentative state (including
 * commits waiting to be stored). Every method is synchronous and returns effects: messages to send,
 * in order, at most one write for the caller to perform, and checkpoints to write. The caller
 * reports the write's outcome with writeCompleted(). Nothing here reads a clock, a random source or
 * the network on its own: time comes from `now`, so the property tests can replay any schedule.
 *
 * Commits come from three sources: clients (`submit`), the control plane on a user's behalf
 * (`author` for steps, `snapshot` for a whole document; 04 §10), and the room itself (control
 * commits for a new grants revision). All of them pass the same steps of 04 §5.
 */
import { isUuid7 } from '@docedit/model';
import { mayAddFeatures, mayOpen } from '@docedit/model/definition';
import type { Node, Schema } from 'prosemirror-model';
import { Step, type StepMap } from 'prosemirror-transform';
import {
  CLIENT_ORIGINS,
  DEFAULT_ACTION,
  DEFAULT_LIMITS,
  SERVER_ORIGINS,
  fail,
  type Limits,
  type RejectAction,
  type RejectCode,
  type Result,
} from '../codes.ts';
import { checkInvariants, type InvariantOutcome } from '../invariants.ts';
import type { ScopeDiff } from '../permissions/scopes.ts';
import {
  type Access,
  type RegionInfo,
  canSubmitAnything,
  computeAccess,
  nextExpiry as earliestExpiry,
  sameAccess,
} from '../permissions/access.ts';
import { regionCanonicalText } from '../permissions/states.ts';
import {
  type Connection,
  type DocumentState,
  type PermissionState,
  type RegionState,
  operationNeeds,
  regionPolicyOf,
  sameRestrictions,
} from '../permissions/model.ts';
import { outcomeCheck } from '../permissions/outcome.ts';
import { authoriseThread, type ThreadAction } from '../permissions/comments.ts';
import { PermissionIndex } from '../permissions/indexes.ts';
import { NodeIndex } from './node-index.ts';
import { suggestionsOn } from '../permissions/suggestions.ts';
import { mapRanges } from '../ranges.ts';
import { applySteps, mapsOf, rebaseOver } from '../rebase.ts';
import { commitBytes, parseSteps, stepsToJson } from '../steps.ts';
import { Admission, type AdmissionConfig } from './admission.ts';
import { featuresUsed } from './features.ts';
import { DEFAULT_RULE_BUDGET, ruleGate } from './rules.ts';
import type { WorkflowRecord } from '../workflow/lifecycle.ts';
import { connectionInWorkflow } from '../workflow/binding.ts';
import { workflowStatus } from '../workflow/state-view.ts';
import {
  type ThreadAnchor,
  type ThreadState,
  cloneAnchor,
  findBlock,
  mapThread,
  rangeScopes,
  threadScopes,
} from './threads.ts';
import {
  DEFAULT_HISTORY_VISIBILITY,
  type HistoryVisibility,
  editsSomewhere,
  minVisibleSeq,
  rangeVisible,
} from './gate.ts';
import {
  ENGINE,
  SERVER_SESSION,
  SNAPSHOT_REASONS,
  SYSTEM_USER,
  type CloseReason,
  type CommitInput,
  type Effects,
  type EvidenceAnchor,
  type LogCommit,
  type Resume,
  type RoomConnection,
  type SnapshotCommit,
  type SnapshotReason,
  type StoredCommit,
  type ToClient,
  type WriteResult,
  isSnapshot,
} from './types.ts';

interface Pending {
  stored: LogCommit;
  /** The author's channel; null for control commits and for server-authored commits. */
  channel: string | null;
  /** Channels of the same user that resubmitted the same commit (04 §5 step 2). */
  waiters: Set<string>;
  /** Requesters of a server-authored commit (04 §10): they get the answer, never broadcasts. */
  requesters: Set<string>;
  rebased: boolean;
  docAfter: Node;
  maps: StepMap[];
  /** The user, or import label, each suggestion identifier the commit claimed belongs to. */
  claimedBy?: ReadonlyMap<string, string>;
  /** The permission indexes after the commit (PRM-016). */
  index?: PermissionIndex;
}

interface Channel {
  id: string;
  conn: RoomConnection;
  access: Access;
  inflight: string | null;
  /** The workflow object last sent on the channel, as JSON (FRW-035), or null when none was. */
  workflow?: string | null;
}

/** What the control plane relied on when it authorised a server-authored commit (04 §5, §10). */
export interface Preconditions {
  /** The grants revision it checked against. */
  revision?: number;
  /** The head it saw: nothing may have been accepted since. */
  head?: number;
  documentState?: DocumentState;
  workflowActive?: boolean;
  /** Region states that must still hold, by region identifier. */
  regionStates?: Readonly<Record<string, RegionState>>;
}

/** Who a server-authored commit is for: the requesting user, or `system` (04 §10). */
export type Requester = Connection | 'system';

/** A step commit the control plane authors on a user's behalf (04 §10; SYN-030). */
export interface AuthoredRequest {
  /** A deterministic UUID version 7 (08 §2), so that a retry cannot apply it twice. */
  id: string;
  base: number;
  steps: unknown;
  /** A reserved origin (04 §3.1) other than `control`. */
  origin: string;
  as: Requester;
  preconditions?: Preconditions;
  /**
   * For a region restore (07 §13; 08 §8; PRM-049): the region restored. The commit may then change
   * only that region, the values of its fields and definitions (which need `structure`, 07 §13);
   * anything else is refused with `permission_denied`, however the steps were computed.
   */
  region?: string;
}

/**
 * A control commit that anchors the workflow evidence of one signing or completion (12 §7; ADR 0013;
 * FRW-041). It carries the origin and the salted hash and nothing else, and records no revision.
 */
export interface AnchorRequest {
  /** A deterministic UUID version 7, so that a retry cannot anchor the same evidence twice. */
  id: string;
  evidence: EvidenceAnchor;
}

/** A snapshot commit the control plane authors (04 §3.2, §10; SYN-005). */
export interface SnapshotRequest {
  /** A deterministic UUID version 7 (08 §2). */
  id: string;
  /** Also the commit's origin. */
  reason: SnapshotReason;
  /** The new content, in the room's schema. */
  content: Node;
  /** The checkpoint, already written, that holds `content` (08 §3); the commit references it. */
  checkpoint: string;
  as: Requester;
  preconditions?: Preconditions;
}

/** The stages of the commit procedure that the benchmark times (04 §5 steps 2 to 7; SYN-040). */
export type CommitStage =
  'dedupe' | 'base' | 'validate' | 'rebase' | 'apply' | 'invariants' | 'permissions';

export interface StageProfile {
  clock: () => number;
  record: (stage: CommitStage, ms: number) => void;
}

export interface RoomInit {
  schema: Schema;
  /** Content at sequence number `initialSeq` (0 unless given). */
  initial: Node;
  requires: readonly string[];
  /** Stored commits from sequence number `initialSeq + 1`, in order. */
  log: readonly LogCommit[];
  perms: PermissionState;
  /**
   * The document's workflow, when it has one (FRW-035). The room then derives `access.fill.active`
   * of a connection that carries a `participant` from it, sends the workflow object on `ch.opened`
   * and keeps it current through `workflowChanged`.
   */
  workflow?: WorkflowRecord;
  /** The grants revision in force at `initialSeq` (when the document was created, for 0). */
  initialRevision: number;
  epoch: number;
  incarnation: string;
  now: () => number;
  /**
   * Times the stages of 04 §5 for one commit (SYN-040). The benchmark gives a high-resolution clock
   * and a recorder; a host leaves it out, and then the room reads no clock for this.
   */
  stageProfile?: StageProfile;
  limits?: Limits;
  attachedAssets?: ReadonlySet<string>;
  mathGate?: (latex: string, display: boolean) => string | null;
  /**
   * The sequence number of `initial`: 0 for the content the document was created with, or the
   * `seq` of a checkpoint the host loaded (BE-020). The room cannot rebase a commit, stream a resume
   * or recognise a commit identifier from before it; storage reports the last as `duplicate`.
   */
  initialSeq?: number;
  /** The content of a snapshot commit's checkpoint, needed when `log` holds one. */
  snapshotContent?: (c: SnapshotCommit) => Node;
  /** Who may see history (08 §9; ADR 0034). Default `editors`. */
  historyVisibility?: HistoryVisibility;
  /**
   * Whether the host serves `GET /documents/{id}/commits` (05 §6.2). Beyond the catch-up limits
   * the room then answers `page`, and otherwise `reload` (04 §9 step 4; ADR 0034).
   */
  commitsResource?: boolean;
  /** Admission control (04 §12; SYN-037). Without it every commit is admitted. */
  admission?: AdmissionConfig;
  /**
   * Rule evaluation steps one commit may spend before it is refused with `rate_limited` (04 §12;
   * ADR 0030 §7). Default `DEFAULT_RULE_BUDGET` (ADR 0034, proposed).
   */
  ruleBudget?: number;
  /**
   * Region identifiers retired before `initialSeq` (07 §3; I3), for a room started from a
   * checkpoint: they come from storage (`GrantStore.retired`), since no commit the room replays
   * records them. The room adds those its own log retires.
   */
  retiredRegionIds?: Iterable<string>;
  /**
   * Suggestion identifiers known before `initialSeq` and the user (or import label) each belongs
   * to (03 §5: the service indexes them). The room also reads those of the initial content.
   */
  suggestionOwners?: Iterable<readonly [string, string]>;
  /** Comment anchors to keep and map (ADR 0015; SYN-032), each at the `seq` it refers to. */
  threads?: readonly ThreadAnchor[];
  /** The most threads a document may hold (07 §6: 5,000). */
  threadLimit?: number;
  /**
   * Whether a commit may add a feature to `requires` (03 §11.1; CDM-047; ADR 0050 item 5). Off by
   * default, so that a host that does not store `StoredCommit.requires` never loses a feature: a
   * commit that needs one is then refused as before, with `invalid_op` (I1).
   */
  requiresGrowth?: boolean;
}

/** The most comment threads a document may hold (07 §6), a target. */
export const DEFAULT_THREAD_LIMIT = 5000;

/** Why a thread request was refused (07 names no codes; ADR 0050 item 6). */
export type ThreadRefusalCode =
  | 'permission_denied'
  | 'read_only'
  | 'stale_base'
  | 'not_found'
  | 'invalid_op'
  | 'conflict'
  | 'quota_exceeded'
  | 'unavailable';

export type ThreadOutcome =
  | { ok: true; thread: ThreadAnchor }
  | { ok: false; code: ThreadRefusalCode; reason: string; scopes?: string[] };

/** A request to start a thread (07 §6; 05 §6.2 `POST /documents/{id}/threads`). */
export interface ThreadRequest {
  /** The thread's identifier, a UUID version 7; a retry with the same identifier is answered again. */
  id: string;
  as: Connection;
  /** A range of the content at `baseSeq`, or a block by identifier. */
  target: { range: { from: number; to: number; baseSeq: number } } | { block: string };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether the connection holds `fill` somewhere and `edit` nowhere: the user P7 (12 §4.2) restricts
 * to the values of fields. Its wrongly typed values are `field_invalid`.
 */
function fillOnly(access: Access): boolean {
  const sets = [
    access.docRole,
    access.body,
    access.structureScopes,
    access.newRegion,
    ...access.regions.values(),
  ];
  const edit = sets.some((c) => c.has('edit'));
  const fill = sets.some((c) => c.has('fill'));
  return fill && !edit;
}

/** The identity of `system` for the outcome check: the capabilities of an owner, never exempt. */
const SYSTEM_CONN: Connection = {
  sub: SYSTEM_USER,
  session: SERVER_SESSION,
  role: 'owner',
  groups: [],
  participantRoles: [],
  participantActive: false,
};

const AUTHORED_ORIGINS: readonly string[] = SERVER_ORIGINS.filter((o) => o !== 'control');

/** Every suggestion identifier of a document and the user (or import label) it names (03 §5). */
function suggestionUsers(doc: Node): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: Node) => {
    for (const m of suggestionsOn(n))
      if (!out.has(String(m.attrs['id']))) out.set(String(m.attrs['id']), String(m.attrs['user']));
  };
  visit(doc);
  doc.descendants((n) => {
    visit(n);
    return true;
  });
  return out;
}

/** The suggestion marks in step JSON, by identifier: the users of the identifiers a commit claims. */
function stepSuggestionUsers(json: unknown, ids: ReadonlySet<string>, out: Map<string, string>) {
  if (Array.isArray(json)) {
    for (const x of json) stepSuggestionUsers(x, ids, out);
    return;
  }
  if (!json || typeof json !== 'object') return;
  const o = json as Record<string, unknown>;
  const attrs = o['attrs'] as Record<string, unknown> | undefined;
  if (
    (o['type'] === 'ins' || o['type'] === 'del' || o['type'] === 'fmt') &&
    attrs &&
    ids.has(String(attrs['id'])) &&
    !out.has(String(attrs['id']))
  )
    out.set(String(attrs['id']), String(attrs['user']));
  for (const v of Object.values(o)) stepSuggestionUsers(v, ids, out);
}

/**
 * Who the identifiers a stored commit claimed belong to, read back from the commit (its steps, or
 * the content of a snapshot): the user its marks name, which is an import label for an import.
 */
function claimUsers(c: LogCommit, after: Node): Map<string, string> | undefined {
  if (!c.claimed.length) return undefined;
  const ids = new Set(c.claimed);
  const out = new Map<string, string>();
  stepSuggestionUsers(c.steps, ids, out);
  if (out.size < ids.size)
    for (const [id, user] of suggestionUsers(after))
      if (ids.has(id) && !out.has(id)) out.set(id, user);
  return out;
}

/**
 * The regions of a document's body with their policies, read as the permissions module reads them
 * (an unknown policy is the strictest, `confidential`).
 */
export function regionsOf(doc: Node): RegionInfo[] {
  const out: RegionInfo[] = [];
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region')
      out.push({ id: String(c.attrs['id']), policy: regionPolicyOf(c.attrs['policy']) });
  });
  return out;
}

/** What one submission brings to the shared pipeline of steps 2 to 9. */
interface Submission {
  fx: Effects;
  /** `rule`: the rule that hid or disabled a refused fill (12 §5.3; FRW-022). */
  reject: (
    code: RejectCode,
    reason: string,
    action?: RejectAction,
    scopes?: string[],
    rule?: string,
  ) => Effects;
  id: string;
  base: number;
  steps: unknown;
  origin: string;
  conn: RoomConnection;
  access: Access;
  serverAuthored: boolean;
  /** The client channel, or null for a server-authored commit. */
  channel: string | null;
  /** The requester of a server-authored commit. */
  requester: string | null;
  session: string;
  /** A region restore: the only region the commit may change (07 §13). */
  restoreRegion?: string;
  /**
   * The preconditions of a server-authored commit (04 §5, closing paragraph). They are checked
   * after step 2, so that a redelivered commit that is already stored is acknowledged at its seq
   * rather than refused because its own commit moved the head (BE-039).
   */
  preconditions?: Preconditions;
}

/** The region list as a comparable key: each region's identifier and policy, in document order. */
function regionListKey(list: readonly RegionInfo[]): string {
  return list.map((r) => `${r.id}\u0000${r.policy}`).join('\u0001');
}

export class Room {
  readonly schema: Schema;
  readonly epoch: number;
  readonly incarnation: string;
  private readonly now: () => number;
  private readonly stageProfile: StageProfile | undefined;
  private readonly limits: Limits;
  private readonly attachedAssets: ReadonlySet<string> | undefined;
  private readonly mathGate: RoomInit['mathGate'];
  private readonly baseSeq: number;
  private historyVisibility: HistoryVisibility;
  private readonly commitsResource: boolean;
  private readonly admission: Admission | null;
  private readonly ruleBudget: number;
  private readonly threadLimit: number;
  private readonly requiresGrowth: boolean;
  /** `requires` as of the durable head, and as of the tentative head (03 §11.1). */
  private durableRequires: string[];
  private tentativeRequires: string[];
  /** Comment anchors at the durable head (SYN-032). */
  private readonly threads = new Map<string, ThreadState>();
  /** The permission indexes at the durable head (PRM-016). */
  private durableIndex: PermissionIndex;
  private tentativeIndex: PermissionIndex;
  /** The node-identifier index, and the head it was built at (BE-019 criterion 2). */
  private nodeIdx: NodeIndex | null = null;
  private nodeIdxSeq = -1;

  private durableDoc: Node;
  private durableSeq: number;
  /** Stored commits from `baseSeq + 1`. */
  private readonly log: LogCommit[] = [];
  private readonly byId = new Map<string, LogCommit>();
  /** Step maps of every stored commit, by `seq - baseSeq - 1`. */
  private readonly maps: StepMap[][] = [];
  /** Steps stored up to each commit, by `seq - baseSeq` (index 0 is the start). */
  private readonly cumSteps: number[] = [0];
  /** Sequence numbers of stored snapshot commits. */
  private readonly snapshotSeqs: number[] = [];
  /** Serialised size of stored commits, computed when a catch-up needs it. */
  private readonly sizes = new Map<number, number>();
  private readonly retired = new Set<string>();
  private readonly owners = new Map<string, string>();
  private perms: PermissionState;
  private workflow: WorkflowRecord | null;
  private recordedRevision = 0;

  private tentativeDoc: Node;
  private tentativeSeq: number;
  private writing: Pending[] | null = null;
  private queued: Pending[] = [];
  private readonly channels = new Map<string, Channel>();
  private stopped = false;
  private thrownCommits = 0;

  constructor(init: RoomInit) {
    this.schema = init.schema;
    this.epoch = init.epoch;
    this.incarnation = init.incarnation;
    this.now = init.now;
    this.stageProfile = init.stageProfile;
    this.limits = init.limits ?? DEFAULT_LIMITS;
    this.attachedAssets = init.attachedAssets;
    this.mathGate = init.mathGate;
    this.perms = init.perms;
    this.workflow = init.workflow ?? null;
    this.recordedRevision = init.initialRevision;
    this.baseSeq = init.initialSeq ?? 0;
    this.historyVisibility = init.historyVisibility ?? DEFAULT_HISTORY_VISIBILITY;
    this.commitsResource = init.commitsResource ?? false;
    this.admission = init.admission ? new Admission(init.admission) : null;
    this.ruleBudget = init.ruleBudget ?? DEFAULT_RULE_BUDGET;
    this.threadLimit = init.threadLimit ?? DEFAULT_THREAD_LIMIT;
    this.requiresGrowth = init.requiresGrowth ?? false;
    this.durableRequires = [...init.requires];
    this.durableSeq = this.baseSeq;
    for (const r of init.retiredRegionIds ?? []) this.retired.add(r);
    for (const [id, user] of init.suggestionOwners ?? []) this.owners.set(id, user);
    // 03 §5: an identifier belongs to the user who first used it, also in the content the room
    // starts from (an import, or a checkpoint).
    for (const [id, user] of suggestionUsers(init.initial))
      if (!this.owners.has(id)) this.owners.set(id, user);
    for (const a of init.threads ?? []) {
      if (!Number.isSafeInteger(a.seq) || a.seq < this.baseSeq)
        throw new Error(`thread ${a.id} refers to ${a.seq}, before the room's first state`);
      this.threads.set(a.id, { anchor: cloneAnchor(a), blockPos: null });
    }
    let doc = init.initial;
    const mapThreads = (seq: number, maps: StepMap[] | null, before: Node, after: Node) => {
      for (const [id, t] of this.threads)
        if (t.anchor.seq < seq) this.threads.set(id, mapThread(t, maps, before, after, seq));
    };
    for (const c of init.log) {
      if (c.seq !== this.durableSeq + 1) throw new Error(`log gap at ${c.seq}`);
      const before = doc;
      if (isSnapshot(c)) {
        if (!init.snapshotContent)
          throw new Error(`stored snapshot commit ${c.seq} needs the content of its checkpoint`);
        doc = init.snapshotContent(c);
        this.record(c, [], claimUsers(c, doc));
        mapThreads(c.seq, null, before, doc);
        continue;
      }
      const steps = c.steps.map((s) => Step.fromJSON(this.schema, s));
      const r = applySteps(doc, steps);
      if (!r.ok) throw new Error(`stored commit ${c.seq} does not apply: ${r.reason}`);
      doc = r.value.doc;
      this.record(c, mapsOf(steps), claimUsers(c, doc));
      mapThreads(c.seq, mapsOf(steps), before, doc);
    }
    for (const a of init.threads ?? [])
      if (a.seq > this.durableSeq)
        throw new Error(`thread ${a.id} refers to ${a.seq}, after the head ${this.durableSeq}`);
    this.durableDoc = doc;
    this.tentativeDoc = doc;
    this.tentativeSeq = this.durableSeq;
    this.tentativeRequires = [...this.durableRequires];
    // The indexes are built once from the content the room starts with (PRM-016 criterion 4).
    this.durableIndex = PermissionIndex.build(doc);
    this.tentativeIndex = this.durableIndex;
    // BE-019 criterion 2: the node-identifier index is built as the room opens.
    this.nodeIdx = NodeIndex.build(doc);
    this.nodeIdxSeq = this.durableSeq;
  }

  get head(): number {
    return this.durableSeq;
  }

  get document(): Node {
    return this.durableDoc;
  }

  get permissions(): PermissionState {
    return this.perms;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** The permission indexes at the durable head (PRM-016), for diagnostics and tests. */
  get indexes(): PermissionIndex {
    return this.durableIndex;
  }

  /**
   * The node-identifier index at the durable head (03 §9; BE-019). The room builds it when it opens
   * and rebuilds it when the head has moved, so a read never sees an older content.
   */
  get nodeIndex(): NodeIndex {
    if (this.nodeIdx === null || this.nodeIdxSeq !== this.durableSeq) {
      this.nodeIdx = NodeIndex.build(this.durableDoc);
      this.nodeIdxSeq = this.durableSeq;
    }
    return this.nodeIdx;
  }

  /** The features the document requires at the durable head (03 §2, §11.1). */
  get requiresList(): readonly string[] {
    return this.durableRequires;
  }

  /**
   * A stored commit older than the commits the room holds, which the host found in the log by its
   * identifier (04 §5 step 2, "then in the log"). The room then answers a retry of it from step 2,
   * as it does for a duplicate the write reports (BE-039). A commit after the durable head is not
   * one the room can know, and is ignored.
   */
  rememberStored(c: LogCommit): void {
    if (c.seq <= this.durableSeq && !this.byId.has(c.id)) this.byId.set(c.id, c);
  }

  /** Commits waiting to be stored, in order. */
  get pendingCount(): number {
    return (this.writing?.length ?? 0) + this.queued.length;
  }

  /** Estimated cost units charged by admission control so far (SYN-037, SYN-049). */
  get admissionCharged(): number {
    return this.admission?.charged ?? 0;
  }

  /** The estimate admission control makes for a commit, for the fuzzing report (SYN-049). */
  estimateCost(input: { steps: number; base: number; bytes: number }): number {
    const est =
      this.admission ?? new Admission({ connection: { capacity: 1, refillPerSecond: 1 } });
    return est.estimate({
      steps: input.steps,
      rebaseSteps: this.rebaseWork(input.base),
      bytes: input.bytes,
    });
  }

  private logAt(seq: number): LogCommit | undefined {
    return this.log[seq - this.baseSeq - 1];
  }

  /**
   * Records a stored commit in the durable indexes. `claimedBy` names the user or import label
   * each claimed suggestion identifier belongs to; without it, the committing user.
   */
  private record(c: LogCommit, maps: StepMap[], claimedBy?: ReadonlyMap<string, string>): void {
    this.log.push(c);
    this.byId.set(c.id, c);
    this.maps.push(maps);
    this.cumSteps.push(this.cumSteps[this.cumSteps.length - 1]! + maps.length);
    this.durableSeq = c.seq;
    for (const r of c.retired) this.retired.add(r);
    for (const id of c.claimed)
      if (!this.owners.has(id)) this.owners.set(id, claimedBy?.get(id) ?? c.user);
    // A control commit that only anchors evidence records no grants revision.
    if (c.kind === 'control' && c.evidence === undefined) this.recordedRevision = c.revision;
    if (isSnapshot(c)) this.snapshotSeqs.push(c.seq);
    if (c.requires) this.durableRequires = [...c.requires];
  }

  private fx(): Effects {
    return { send: [], write: null };
  }

  private pending(): Pending[] {
    return [...(this.writing ?? []), ...this.queued];
  }

  private access(conn: Connection): Access {
    // Computed afresh for every check, from the tentative document, so that a region created,
    // removed or re-policied by an earlier commit, and any expiry, is always taken into account.
    // The region list comes from the index, not from a scan of the body (PRM-016).
    return computeAccess(
      this.withWorkflow(conn),
      this.tentativeIndex.regionList(),
      this.perms,
      this.now(),
    );
  }

  /**
   * The connection as the workflow sees it (FRW-035): a participant of the workflow is active
   * exactly when the record says so, whatever the token claimed when it was issued. A connection
   * with no participant, or one the record does not list, is left as it is.
   */
  private withWorkflow(conn: Connection): Connection {
    // FRW-038: a token with `wfp` fills only as the participant it binds to in this workflow, with
    // that participant's roles, and while the workflow lets them. Anything else: no fill.
    return connectionInWorkflow(conn, this.workflow);
  }

  /**
   * The connection as the room's workflow binds it: the one its access is computed from. What a
   * connection may read is decided from the same connection (ADR 0019; owner decision 156), so the
   * projection gateway and the content reads ask here before they ask what is hidden.
   */
  connectionInWorkflow(conn: Connection): Connection {
    return this.withWorkflow(conn);
  }

  /**
   * Whether the connection is a participant of a workflow that is being corrected: paused, so that
   * it may not change anything until the owner resumes (FRW-032 criterion 2).
   */
  private isPaused(conn: Connection): boolean {
    const record = this.workflow;
    const id = this.withWorkflow(conn).participant;
    if (record === null || record.state !== 'correcting' || id === undefined) return false;
    return record.participants.some((p) => p.id === id);
  }

  /** The workflow object for a connection, as JSON text for comparison, or null without a workflow. */
  private workflowFor(conn: Connection) {
    return this.workflow === null
      ? null
      : workflowStatus(this.workflow, this.withWorkflow(conn).participant);
  }

  /** Access at the durable head, for the requests that refer to it (threads; 07 §6). */
  private durableAccess(conn: Connection): Access {
    return computeAccess(
      this.withWorkflow(conn),
      this.durableIndex.regionList(),
      this.perms,
      this.now(),
    );
  }

  private content(seq: number, doc: Node) {
    return {
      seq,
      doc: doc.toJSON(),
      requires: [...this.durableRequires],
      incarnation: this.incarnation,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Channels (05 §5.3; 04 §9; ADR 0034).

  /**
   * Whether a client that announced `features` may open the document (03 §11.1; CDM-047): it
   * must have every feature the document requires, including one a commit still waiting to be
   * stored adds. A connection that announced nothing is not checked.
   */
  canOpen(conn: RoomConnection): ReturnType<typeof mayOpen> {
    return conn.features === undefined
      ? { ok: true }
      : mayOpen(this.tentativeRequires, conn.features);
  }

  open(channel: string, conn: RoomConnection, resume?: Resume): Effects {
    const fx = this.fx();
    if (this.stopped) {
      fx.send.push({ channel, msg: { t: 'ch.closed', code: 'unavailable', reason: 'stopped' } });
      return fx;
    }
    const features = this.canOpen(conn);
    if (!features.ok) {
      fx.refused = { channel, code: 'unsupported_feature', missing: features.missing };
      return fx;
    }
    const access = this.access(conn);
    const workflow = this.workflowFor(conn);
    this.channels.set(channel, {
      id: channel,
      conn,
      access,
      inflight: null,
      workflow: workflow === null ? null : JSON.stringify(workflow),
    });
    // Only the caller's own commit is reported as accepted; another user's identifier is "unknown",
    // so a resubmission meets the duplicate check of step 2 and is refused (04 §5; 07 §16). A
    // commit still waiting to be stored is "unknown" too: a resubmission attaches to it (step 2).
    const inflight =
      !resume || resume.inflight === null
        ? null
        : (() => {
            const found = this.byId.get(resume.inflight);
            return found && found.user === conn.sub
              ? { state: 'accepted' as const, seq: found.seq }
              : { state: 'unknown' as const };
          })();
    const catchUp = this.catchUpFor(conn, resume);
    const opened = {
      t: 'ch.opened' as const,
      head: this.durableSeq,
      incarnation: this.incarnation,
      inflight,
      access,
      ...(workflow === null ? {} : { workflow }),
    };
    if (catchUp === 'reload') {
      fx.send.push({
        channel,
        msg: { ...opened, catchUp, content: this.content(this.durableSeq, this.durableDoc) },
      });
      return fx;
    }
    fx.send.push({ channel, msg: { ...opened, catchUp } });
    if (catchUp === 'page') return fx; // the client reads the missing commits over REST
    for (let s = resume!.seq + 1; s <= this.durableSeq; s++) {
      const c = this.logAt(s)!;
      fx.send.push({ channel, msg: { t: 'sync.commit', commit: c as StoredCommit } });
    }
    fx.send.push({ channel, msg: { t: 'sync.caughtUp', head: this.durableSeq } });
    return fx;
  }

  /**
   * How a channel catches up (04 §9; SYN-026; ADR 0034, proposed). `reload` when there is no
   * resume, another incarnation, a `seq` outside the log, a `seq` below the user's visibility
   * gate, or a snapshot commit after it; `stream` within the catch-up limits; beyond them `page`
   * when the host serves the commits resource, else `reload`.
   */
  private catchUpFor(
    conn: RoomConnection,
    resume: Resume | undefined,
  ): 'stream' | 'page' | 'reload' {
    if (!resume || resume.incarnation !== this.incarnation) return 'reload';
    const seq = resume.seq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > this.durableSeq) return 'reload';
    if (!rangeVisible(this.minVisibleSeq(conn), seq)) return 'reload';
    if (this.snapshotSeqs.some((s) => s > seq)) return 'reload';
    const maxCommits = this.limits.catchUpCommits ?? DEFAULT_LIMITS.catchUpCommits!;
    const maxBytes = this.limits.catchUpBytes ?? DEFAULT_LIMITS.catchUpBytes!;
    // Before the first commit the room holds it cannot see snapshot commits either.
    if (seq < this.baseSeq) return 'reload';
    const page = this.commitsResource ? 'page' : 'reload';
    if (this.durableSeq - seq > maxCommits) return page;
    let bytes = 0;
    for (let s = this.durableSeq; s > seq; s--) {
      let size = this.sizes.get(s);
      if (size === undefined) {
        size = commitBytes(this.logAt(s));
        this.sizes.set(s, size);
      }
      bytes += size;
      if (bytes > maxBytes) return page;
    }
    return 'stream';
  }

  /**
   * The history visibility setting changed (HIS-025 criterion 5; 08 §9). The gate of the next
   * request uses it; nothing already delivered is recalled (ADR 0034 section 2).
   */
  setHistoryVisibility(setting: HistoryVisibility): void {
    this.historyVisibility = setting;
  }

  /** The user's visibility gate now (07 §8; 08 §9; HIS-023). */
  minVisibleSeq(conn: RoomConnection): number {
    return minVisibleSeq({
      setting: this.historyVisibility,
      editsSomewhere: editsSomewhere(conn, regionsOf(this.durableDoc), this.perms, this.now()),
      accessSince: conn.accessSince,
      head: this.durableSeq,
      timeOf: (s) => this.logAt(s)?.time,
      floor: this.baseSeq,
    });
  }

  close(channel: string): void {
    this.channels.delete(channel);
    for (const p of this.pending()) p.waiters.delete(channel);
  }

  // -------------------------------------------------------------------------------------------
  // Submissions (04 §5 steps 1 to 9).

  submit(channel: string, input: CommitInput): Effects {
    const fx = this.fx();
    const ch = this.channels.get(channel);
    if (!ch) return fx;
    const id = isObject(input) && typeof input.id === 'string' ? input.id : '';
    /** The access this submission is judged under, once step 1 has computed it. */
    let judged: Access | null = null;
    const reject = (
      code: RejectCode,
      reason: string,
      action: RejectAction = DEFAULT_ACTION[code],
      scopes?: string[],
      retryAfterMs?: number,
      rule?: string,
    ) => {
      // 04 §8: on `permission_denied` the client refreshes its permissions. The room sends the
      // access the commit was judged under, ahead of the rejection, when it is not the access
      // the channel was last sent (a grant or lease that ran out before `expire` was called);
      // DEP has no request for it, so the room does not wait to be asked (ADR 0364).
      if (code === 'permission_denied' && judged && !sameAccess(judged, ch.access)) {
        ch.access = judged;
        fx.send.push({
          channel,
          msg: {
            t: 'perm.changed',
            revision: this.perms.revision,
            access: judged,
            refresh: true,
          },
        });
      }
      fx.send.push({
        channel,
        msg: {
          t: 'sync.reject',
          id,
          code,
          action,
          head: this.durableSeq,
          reason,
          ...(scopes ? { scopes } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(rule !== undefined ? { rule } : {}),
        },
      });
      return fx;
    };
    if (this.stopped) return reject('unavailable', 'the room has stopped serving this document');
    if (!isObject(input) || !isUuid7(input.id))
      return reject('invalid_op', 'a commit needs a UUID version 7 id');
    if (!Number.isSafeInteger(input.base) || input.base < 0)
      return reject('invalid_op', 'base must be a sequence number');
    const claimedOrigin = input.origin ?? 'input';
    if (!(CLIENT_ORIGINS as readonly string[]).includes(claimedOrigin))
      return reject('invalid_op', `origin "${claimedOrigin}" is not a client origin`);
    // A commit on a verified agent connection is the assistant's whatever the client says (ADR 0234
    // A1; UX-046 criterion 6). On a user connection `assistant` stays a client claim (04 §2).
    const origin = ch.conn.agent !== undefined ? 'assistant' : claimedOrigin;

    // 1. Authorise and limit: the document state, P6, the size limits and admission control, all
    // before any deduplication, rebase or apply work.
    // `ch.access` stays the access last sent on the channel, so that a later `expire` or the
    // rejection below still sees that the client holds an older one.
    const access = this.access(ch.conn);
    judged = access;
    if (this.perms.documentState !== 'active' && !access.fill.allowed)
      return reject('read_only', `the document is ${this.perms.documentState}`);
    if (!canSubmitAnything(access))
      return reject('permission_denied', 'the connection can only view or comment (P6)');
    const bytes = commitBytes(input);
    if (bytes > this.limits.maxCommitBytes)
      return reject('too_large', `the commit is larger than ${this.limits.maxCommitBytes} bytes`);
    const stepCount = Array.isArray(input.steps) ? input.steps.length : 0;
    if (stepCount > this.limits.maxStepsPerCommit)
      return reject('too_large', `more than ${this.limits.maxStepsPerCommit} steps`);
    if (ch.inflight !== null) return reject('busy', 'one commit per channel may be in flight');
    if (this.admission) {
      const units = this.admission.estimate({
        steps: stepCount,
        rebaseSteps: this.rebaseWork(input.base),
        bytes,
      });
      const wait = this.admission.admit(ch.conn.session, units, this.now());
      if (wait > 0)
        return reject(
          'rate_limited',
          `the connection's budget is spent (the commit is estimated at ${units} units)`,
          'retry',
          undefined,
          wait,
        );
    }
    try {
      return this.process({
        fx,
        reject: (code, reason, action, scopes, rule) =>
          reject(code, reason, action, scopes, undefined, rule),
        id: input.id,
        base: input.base,
        steps: input.steps,
        origin,
        conn: ch.conn,
        access,
        serverAuthored: false,
        channel,
        requester: null,
        session: ch.conn.session,
      });
    } catch {
      // SEC-028 criterion 4: a commit whose processing throws is rejected and counted; the room
      // keeps serving the other channels and the next commit runs as usual.
      this.thrownCommits += 1;
      return reject('invalid_op', 'the commit could not be validated');
    }
  }

  /** Commits whose processing threw; each was rejected with `invalid_op` (SEC-028 criterion 4). */
  get validationExceptions(): number {
    return this.thrownCommits;
  }

  /**
   * Steps 2 to 9 for a step commit, shared by client and server-authored commits, so that the
   * service is never a way round the checks (04 §5, closing paragraph; SYN-030).
   */
  private process(s: Submission): Effects {
    const { fx, reject } = s;
    const ch = s.channel === null ? null : this.channels.get(s.channel)!;
    const prof = this.stageProfile;
    let mark = prof ? prof.clock() : 0;
    const lap = (stage: CommitStage): void => {
      if (!prof) return;
      const t = prof.clock();
      prof.record(stage, t - mark);
      mark = t;
    };
    // 2. Deduplicate: first among commits waiting to be stored, then in the log.
    const waiting = this.pending().find((p) => p.stored.id === s.id);
    if (waiting) {
      if (waiting.stored.user !== s.conn.sub || isSnapshot(waiting.stored))
        return reject('invalid_op', 'the commit id belongs to another user');
      if (s.requester !== null) waiting.requesters.add(s.requester);
      else if (waiting.channel !== s.channel) waiting.waiters.add(s.channel!);
      if (ch) ch.inflight = s.id;
      return fx;
    }
    const stored = this.byId.get(s.id);
    if (stored) {
      // A step commit never shares its identifier with a snapshot commit.
      if (stored.user !== s.conn.sub || isSnapshot(stored))
        return reject('invalid_op', 'the commit id belongs to another user');
      fx.send.push({ channel: (s.channel ?? s.requester)!, msg: this.rebuiltAck(stored) });
      return fx;
    }
    // The control plane's preconditions, re-checked once the commit is known to be new.
    const failed = this.preconditionFailure(s.preconditions);
    if (failed) return reject('conflict', `a precondition no longer holds: ${failed}`, 'drop');
    lap('dedupe');

    // 3. Check the base.
    if (s.base > this.tentativeSeq)
      return reject('invalid_op', 'base is ahead of the head', 'reload');
    const snap = this.snapshotAfter(s.base);
    if (snap !== null)
      return reject('stale_base', `a snapshot commit (${snap}) lies after the base`, 'rebase');
    if (s.base < this.baseSeq)
      return reject('stale_base', 'the base is older than the commits the room holds');
    if (this.distance(s.base) > this.limits.maxRebaseSteps)
      return reject('stale_base', `more than ${this.limits.maxRebaseSteps} steps since base`);
    lap('base');

    const parsed = parseSteps(this.schema, s.steps, this.limits);
    if (!parsed.ok) return reject(parsed.code, parsed.reason);
    lap('validate');

    // 4 and 5. Rebase and apply.
    let mapped: Step[];
    let docAfter: Node;
    let docs: Node[];
    let rebased = false;
    if (s.base === this.tentativeSeq) {
      const r = applySteps(this.tentativeDoc, parsed.value);
      if (!r.ok) return reject(r.code, r.reason);
      mapped = parsed.value;
      docAfter = r.value.doc;
      docs = r.value.docs;
      lap('apply');
    } else {
      const r = rebaseOver(parsed.value, this.mapsAfter(s.base), this.tentativeDoc, 'reject');
      if (!r.ok) return reject(r.code, r.reason);
      lap('rebase');
      mapped = r.value.steps;
      const a = applySteps(this.tentativeDoc, mapped);
      if (!a.ok) return reject('rebase_failed', a.reason);
      docAfter = a.value.doc;
      docs = a.value.docs;
      rebased = true;
      lap('apply');
    }

    // 6. Invariants, and the features the result needs (03 §11.1).
    const inv = this.checkResult(this.tentativeDoc, docAfter, mapped, docs);
    lap('invariants');
    // P7 (12 §4.2; SYN-012 criterion 3): a wrongly typed value is `field_invalid` only for a user who
    // holds `fill` and not `edit`; for everyone else I15 is `invalid_op` (04 §5 step 6).
    if (!inv.ok) {
      if (inv.code === 'field_invalid' && !fillOnly(s.access))
        return reject('invalid_op', inv.reason);
      // PRO-028 criterion 4: a field_invalid carries the rule that failed.
      return reject(
        inv.code,
        inv.reason,
        undefined,
        undefined,
        inv.code === 'field_invalid' ? inv.rule : undefined,
      );
    }

    // 7. Permissions: the outcome check, with the permissions in force now. Never exempt. A fill
    // needs its field visible and enabled under the rules, evaluated within the rule budget.
    const index = this.tentativeIndex;
    const docBefore = this.tentativeDoc;
    const maps = mapsOf(mapped);
    let next: PermissionIndex | null = null;
    const nextIndex = (diff: ScopeDiff): PermissionIndex =>
      (next ??= index.next(docBefore, docAfter, maps, diff));
    const gate = ruleGate(
      docAfter,
      this.withWorkflow(s.conn).participantRoles,
      this.ruleBudget,
      (id) => index.field(id)?.key,
    );
    const judge = (access: Access, perms: PermissionState) =>
      outcomeCheck({
        before: docBefore,
        after: docAfter,
        user: s.conn.sub,
        access,
        perms,
        suggestionOwners: this.suggestionOwners(),
        fieldsChangedSinceBase: this.fieldsChangedAfter(s.base),
        serverAuthored: s.serverAuthored,
        origin: s.origin,
        ...(gate ? { fieldEnabled: gate.enabled } : {}),
        definitionUse: {
          before: () => index.definitionUse(docBefore),
          after: (diff) => nextIndex(diff).definitionUse(docAfter),
        },
      });
    const verdict = judge(s.access, this.perms);
    lap('permissions');
    if (gate?.overrun)
      return reject(
        'rate_limited',
        `evaluating the rules took more than ${this.ruleBudget} steps (04 §12)`,
        'retry',
      );
    // 04 §5 step 1 and 07 §5.2 P6: "If the document's state forbids the change (`locked`,
    // `archived`, or a workflow that does not permit it), reject with `read_only`". A connection
    // that keeps `fill` under a lock passes step 1, so the question is asked here: a change the
    // same connection could make were the document active with no workflow running is one the
    // state forbids; any other refusal stays `permission_denied` (ADR 0363).
    // A participant of a workflow that is being corrected is paused (12 §6.2): everything they send
    // is refused as `read_only`, whatever the change (FRW-032 criterion 2).
    if (
      !verdict.ok &&
      verdict.code === 'permission_denied' &&
      !s.serverAuthored &&
      this.isPaused(s.conn)
    )
      return reject(
        'read_only',
        'the workflow is being corrected',
        DEFAULT_ACTION['read_only'],
        verdict.scopes,
      );
    if (
      !verdict.ok &&
      verdict.code === 'permission_denied' &&
      !s.serverAuthored &&
      this.perms.documentState !== 'active'
    ) {
      const unlocked: PermissionState = {
        ...this.perms,
        documentState: 'active',
        workflowActive: false,
      };
      const access = computeAccess(s.conn, index.regionList(), unlocked, this.now());
      if (judge(access, unlocked).ok)
        return reject(
          'read_only',
          `the document is ${this.perms.documentState}`,
          DEFAULT_ACTION['read_only'],
          verdict.scopes,
        );
    }
    if (!verdict.ok) {
      // A fill the rules refused names the rule that hid or disabled its field (12 §5.3).
      const rule =
        verdict.code === 'permission_denied' && gate
          ? verdict.scopes
              .filter((scope) => scope.startsWith('field:'))
              .map((scope) => gate.ruleOf(scope.slice('field:'.length)))
              .find((r) => r !== undefined)
          : undefined;
      return reject(
        verdict.code,
        verdict.reason,
        DEFAULT_ACTION[verdict.code],
        verdict.scopes,
        rule,
      );
    }
    // A region restore changes that region alone, its fields and the definitions it recreates
    // (07 §13; 08 §8; PRM-049), whatever the steps the control plane computed.
    if (s.restoreRegion !== undefined) {
      const outside = verdict.scopes.filter((scope) => {
        if (scope === `region:${s.restoreRegion}` || scope === 'doc' || scope.startsWith('defs:'))
          return false;
        if (!scope.startsWith('field:')) return true;
        const f = verdict.diff.fieldNodes.find((x) => `field:${x.id}` === scope);
        const inRegion = (c: string | null) => c === null || c === `region:${s.restoreRegion}`;
        return !f || !inRegion(f.containerBefore) || !inRegion(f.containerAfter);
      });
      if (!this.tentativeIndex.region(s.restoreRegion))
        return reject('permission_denied', `no region ${s.restoreRegion} to restore`);
      if (outside.length)
        return reject(
          'permission_denied',
          `a restore of region ${s.restoreRegion} changes other scopes (07 §13)`,
          'drop',
          outside,
        );
    }

    // 8. Order and stamp.
    const seq = this.tentativeSeq + 1;
    const commit: StoredCommit = {
      seq,
      id: s.id,
      kind: 'steps',
      steps: stepsToJson(mapped),
      // Attribution comes from the connection and the server clock, never from the commit (G6).
      user: s.conn.sub,
      session: s.session,
      ...(!s.serverAuthored && s.conn.agent !== undefined ? { agent: s.conn.agent } : {}),
      time: this.now(),
      origin: s.origin,
      scopes: verdict.scopes,
      revision: this.perms.revision,
      cdm: 1,
      engine: ENGINE,
      retired: inv.value.removedRegions,
      claimed: verdict.claimedSuggestionIds,
      base: s.base,
      rebased,
      ...(!s.serverAuthored && s.conn.jti !== undefined ? { jti: s.conn.jti } : {}),
      ...(inv.requires ? { requires: inv.requires } : {}),
    };
    const indexAfter = nextIndex(verdict.diff);
    this.queued.push({
      stored: commit,
      channel: s.channel,
      waiters: new Set(),
      requesters: new Set(s.requester !== null ? [s.requester] : []),
      rebased,
      docAfter,
      maps,
      claimedBy: verdict.claimedBy,
      index: indexAfter,
    });
    this.tentativeDoc = docAfter;
    this.tentativeSeq = seq;
    this.tentativeIndex = indexAfter;
    if (inv.requires) this.tentativeRequires = inv.requires;
    if (ch) ch.inflight = s.id;

    // 9. Persist (group commit: one write in flight per room).
    this.startWrite(fx);
    return fx;
  }

  private invariantContext() {
    const retired = new Set(this.retired);
    for (const p of this.pending()) for (const r of p.stored.retired) retired.add(r);
    return {
      requires: this.tentativeRequires,
      retiredRegionIds: retired,
      ...(this.attachedAssets ? { attachedAssets: this.attachedAssets } : {}),
      ...(this.mathGate ? { mathGate: this.mathGate } : {}),
    };
  }

  /**
   * Step 6 of 04 §5: the invariants of the result. When the result needs a feature `requires`
   * lacks and the host lets `requires` grow, the room accepts the commit only if every attached
   * client announced the feature (03 §11.1; CDM-047), and returns the grown `requires`. A commit
   * that needs a feature some client lacks is refused with `conflict` and `drop` (ADR 0050 item 5).
   */
  private checkResult(
    before: Node,
    after: Node,
    steps: readonly Step[],
    docs: readonly Node[],
  ): Result<InvariantOutcome> & { requires?: string[] } {
    const ctx = this.invariantContext();
    const inv = checkInvariants(before, after, steps, docs, ctx);
    if (inv.ok || !this.requiresGrowth) return inv;
    const grown = [...new Set([...this.tentativeRequires, ...featuresUsed(after)])].sort();
    if (grown.length === new Set(this.tentativeRequires).size) return inv;
    const again = checkInvariants(before, after, steps, docs, { ...ctx, requires: grown });
    if (!again.ok) return again;
    const clients = [...this.channels.values()].map((c) => c.conn.features ?? []);
    const decision = mayAddFeatures(this.tentativeRequires, grown, clients);
    if (!decision.ok)
      return fail(
        'conflict',
        `the document cannot gain ${decision.missing.join(', ')} while a connected client lacks it (03 §11.1)`,
      );
    return { ...again, requires: grown };
  }

  private suggestionOwners(): Map<string, string> {
    const owners = new Map(this.owners);
    for (const p of this.pending())
      for (const s of p.stored.claimed)
        if (!owners.has(s)) owners.set(s, p.claimedBy?.get(s) ?? p.stored.user);
    return owners;
  }

  /** An acknowledgement rebuilt from a stored commit; it always carries the stored steps (04 §5 step 2). */
  private rebuiltAck(c: LogCommit): ToClient {
    return isSnapshot(c)
      ? { t: 'sync.ack', id: c.id, seq: c.seq, time: c.time, rebased: false }
      : { t: 'sync.ack', id: c.id, seq: c.seq, time: c.time, rebased: true, steps: c.steps };
  }

  /** The first snapshot commit, stored or waiting, after `base`; null when there is none. */
  private snapshotAfter(base: number): number | null {
    for (const s of this.snapshotSeqs) if (s > base) return s;
    for (const p of this.pending())
      if (isSnapshot(p.stored) && p.stored.seq > base) return p.stored.seq;
    return null;
  }

  /** Steps accepted after `base`, stored and waiting; infinite before the commits the room holds. */
  private distance(base: number): number {
    if (!Number.isSafeInteger(base) || base > this.tentativeSeq) return 0;
    if (base < this.baseSeq) return Number.POSITIVE_INFINITY;
    let n =
      base >= this.durableSeq
        ? 0
        : this.cumSteps[this.cumSteps.length - 1]! - this.cumSteps[base - this.baseSeq]!;
    for (const p of this.pending()) if (p.stored.seq > base) n += p.maps.length;
    return n;
  }

  /** The rebase distance the work will really cover: none when step 3 refuses the base. */
  private rebaseWork(base: number): number {
    const d = this.distance(base);
    return d > this.limits.maxRebaseSteps ? 0 : d;
  }

  private mapsAfter(base: number): StepMap[] {
    const out: StepMap[] = [];
    for (let s = base + 1; s <= this.durableSeq; s++)
      out.push(...(this.maps[s - this.baseSeq - 1] ?? []));
    for (const p of this.pending()) if (p.stored.seq > base) out.push(...p.maps);
    return out;
  }

  private fieldsChangedAfter(base: number): Set<string> {
    const out = new Set<string>();
    const add = (c: LogCommit) => {
      for (const s of c.scopes) if (s.startsWith('field:')) out.add(s.slice(6));
    };
    for (let s = Math.max(base, this.baseSeq) + 1; s <= this.durableSeq; s++) add(this.logAt(s)!);
    for (const p of this.pending()) if (p.stored.seq > base) add(p.stored);
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Server-authored commits (04 §10; SYN-030, SYN-005).

  /**
   * A rejection sent to the requester of a server-authored commit. The audit entry of a refusal
   * (PRM-051) is the host's: it sees every `sync.reject`, the gateway's included.
   */
  private requesterReject(fx: Effects, requester: string, id: string) {
    return (
      code: RejectCode,
      reason: string,
      action: RejectAction = DEFAULT_ACTION[code],
      scopes?: string[],
    ): Effects => {
      fx.send.push({
        channel: requester,
        msg: {
          t: 'sync.reject',
          id,
          code,
          action,
          head: this.durableSeq,
          reason,
          ...(scopes ? { scopes } : {}),
        },
      });
      return fx;
    };
  }

  /**
   * The preconditions the control plane relied on, checked again now (04 §5, closing paragraph).
   * A failed precondition is answered with `conflict` and `drop`: the state the operation was
   * authorised under has changed, and the control plane must decide again.
   */
  private preconditionFailure(p: Preconditions | undefined): string | null {
    if (!p) return null;
    if (p.revision !== undefined && p.revision !== this.perms.revision)
      return `the grants revision is ${this.perms.revision}, not ${p.revision}`;
    if (p.head !== undefined && p.head !== this.tentativeSeq)
      return `commits were accepted after ${p.head}`;
    if (p.documentState !== undefined && p.documentState !== this.perms.documentState)
      return `the document is ${this.perms.documentState}, not ${p.documentState}`;
    if (p.workflowActive !== undefined && p.workflowActive !== this.perms.workflowActive)
      return p.workflowActive ? 'no workflow is active' : 'a workflow is active';
    for (const [region, state] of Object.entries(p.regionStates ?? {})) {
      const now = this.perms.regionStates.get(region) ?? 'draft';
      if (now !== state) return `region ${region} is ${now}, not ${state}`;
    }
    return null;
  }

  /**
   * A step commit the control plane authors on a user's behalf (04 §10): a region restore, a
   * signature, date-signed or formula value, a prefill. It passes the steps of 04 §5 like a client
   * commit, with the requesting user (or `system`) as author, session `system` (null in DEP) and
   * a reserved origin; the answer (`sync.ack` or `sync.reject`) goes to `requester`, which is not a
   * channel and receives no broadcasts.
   */
  author(requester: string, request: AuthoredRequest): Effects {
    const fx = this.fx();
    const id = isObject(request) && typeof request.id === 'string' ? request.id : '';
    const reject = this.requesterReject(fx, requester, id);
    if (this.stopped) return reject('unavailable', 'the room has stopped serving this document');
    if (!isObject(request) || !isUuid7(request.id))
      return reject(
        'invalid_op',
        'a server-authored commit needs a deterministic UUID version 7 id',
      );
    if (!Number.isSafeInteger(request.base) || request.base < 0)
      return reject('invalid_op', 'base must be a sequence number');
    if (!AUTHORED_ORIGINS.includes(request.origin))
      return reject('invalid_op', `origin "${String(request.origin)}" is not a server origin`);
    const conn = request.as === 'system' ? SYSTEM_CONN : request.as;
    const access = this.access(conn);
    if (this.perms.documentState !== 'active' && !access.fill.allowed)
      return reject('read_only', `the document is ${this.perms.documentState}`);
    if (!canSubmitAnything(access))
      return reject('permission_denied', 'the user can only view or comment (P6)');
    if (commitBytes(request) > this.limits.maxCommitBytes)
      return reject('too_large', `the commit is larger than ${this.limits.maxCommitBytes} bytes`);
    // The preconditions are checked in process(), after deduplication (step 2).
    return this.process({
      fx,
      reject,
      id: request.id,
      base: request.base,
      steps: request.steps,
      origin: request.origin,
      conn,
      access,
      serverAuthored: true,
      channel: null,
      requester,
      session: SERVER_SESSION,
      ...(typeof request.region === 'string' ? { restoreRegion: request.region } : {}),
      ...(request.preconditions ? { preconditions: request.preconditions } : {}),
    });
  }

  /**
   * A control commit that anchors the salted hash of the workflow evidence of one signing or
   * completion (12 §7; FRW-041). It is the control plane's housekeeping, like a grants revision, so
   * it needs no permission and is not refused for the state of the document. A retry of the same
   * identifier is acknowledged at the stored sequence number.
   */
  anchor(requester: string, request: AnchorRequest): Effects {
    const fx = this.fx();
    const id = isObject(request) && typeof request.id === 'string' ? request.id : '';
    const reject = this.requesterReject(fx, requester, id);
    if (this.stopped) return reject('unavailable', 'the room has stopped serving this document');
    if (!isObject(request) || !isUuid7(request.id))
      return reject('invalid_op', 'an evidence anchor needs a deterministic UUID version 7 id');
    const ev = request.evidence as Partial<EvidenceAnchor> | undefined;
    if (
      !isObject(ev) ||
      (ev.origin !== 'sign' && ev.origin !== 'rules' && ev.origin !== 'decline') ||
      typeof ev.evidenceHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(ev.evidenceHash)
    )
      return reject('invalid_op', 'an evidence anchor holds an origin and a SHA-256 hash');
    const waiting = this.pending().find((p) => p.stored.id === request.id);
    if (waiting) {
      waiting.requesters.add(requester);
      return fx;
    }
    const stored = this.byId.get(request.id);
    if (stored) {
      fx.send.push({ channel: requester, msg: this.rebuiltAck(stored) });
      return fx;
    }
    const seq = this.tentativeSeq + 1;
    const commit: StoredCommit = {
      seq,
      id: request.id,
      kind: 'control',
      steps: [],
      user: SYSTEM_USER,
      session: SERVER_SESSION,
      time: this.now(),
      origin: 'control',
      scopes: [],
      revision: this.perms.revision,
      cdm: 1,
      engine: ENGINE,
      retired: [],
      claimed: [],
      evidence: { origin: ev.origin, evidenceHash: ev.evidenceHash },
    };
    this.queued.push({
      stored: commit,
      channel: null,
      waiters: new Set(),
      requesters: new Set([requester]),
      rebased: false,
      docAfter: this.tentativeDoc,
      maps: [],
    });
    this.tentativeSeq = seq;
    this.startWrite(fx);
    return fx;
  }

  /**
   * A snapshot commit (04 §3.2; SYN-005): an import, a whole-document restore, a migration or a
   * repair replaces the document with the content of a checkpoint. It passes the invariant and
   * permission checks of any commit, including the refusal to change an approved region (07 §11),
   * is written alone, and reaches every subscriber as `sync.reset`. A commit whose base is older
   * than it is refused with `stale_base` and `rebase` (04 §3.2 as revised; second review SR-K1).
   */
  snapshot(requester: string, request: SnapshotRequest): Effects {
    const fx = this.fx();
    const id = isObject(request) && typeof request.id === 'string' ? request.id : '';
    const reject = this.requesterReject(fx, requester, id);
    if (this.stopped) return reject('unavailable', 'the room has stopped serving this document');
    if (!isObject(request) || !isUuid7(request.id))
      return reject('invalid_op', 'a snapshot commit needs a deterministic UUID version 7 id');
    if (!SNAPSHOT_REASONS.includes(request.reason))
      return reject('invalid_op', `"${String(request.reason)}" is not a snapshot reason`);
    if (typeof request.checkpoint !== 'string' || request.checkpoint === '')
      return reject('invalid_op', 'a snapshot commit references a checkpoint');
    if (!request.content || request.content.type?.schema !== this.schema)
      return reject('invalid_op', 'the content is not a document of this schema');
    const conn = request.as === 'system' ? SYSTEM_CONN : request.as;
    const access = this.access(conn);
    if (this.perms.documentState !== 'active' && !access.fill.allowed)
      return reject('read_only', `the document is ${this.perms.documentState}`);
    if (!canSubmitAnything(access))
      return reject('permission_denied', 'the user can only view or comment (P6)');
    // Restoring a whole document needs `manage` and no active workflow (07 §12, §13; 08 §8), and
    // the room checks it again when it applies the commit, not only the control plane (PRM-049).
    if (request.reason === 'restore' && !access.docRole.has('manage'))
      return reject('permission_denied', operationNeeds('document.restore'));
    if (request.reason === 'restore' && this.perms.workflowActive)
      return reject(
        'conflict',
        'a whole document is not restored while a workflow is active (08 §8)',
      );
    // 2. Deduplicate: a retry of the same deterministic identifier applies once (SYN-030). This
    // comes before the preconditions: a redelivered snapshot that is already stored moved the head
    // itself, and is acknowledged at its seq rather than refused (BE-039).
    const waiting = this.pending().find((p) => p.stored.id === request.id);
    if (waiting) {
      if (waiting.stored.user !== conn.sub)
        return reject('invalid_op', 'the commit id belongs to another user');
      waiting.requesters.add(requester);
      return fx;
    }
    const stored = this.byId.get(request.id);
    if (stored) {
      if (stored.user !== conn.sub)
        return reject('invalid_op', 'the commit id belongs to another user');
      fx.send.push({ channel: requester, msg: this.rebuiltAck(stored) });
      return fx;
    }
    const failed = this.preconditionFailure(request.preconditions);
    if (failed) return reject('conflict', `a precondition no longer holds: ${failed}`, 'drop');
    // 6. Invariants on the new content. A snapshot may change identities, but it cannot bring back
    // a retired region identifier (I3). An import may add a feature (03 §11.1).
    const inv = this.checkResult(this.tentativeDoc, request.content, [], []);
    if (!inv.ok) return reject(inv.code, inv.reason);
    // 7. Permissions, as for any commit.
    const verdict = outcomeCheck({
      before: this.tentativeDoc,
      after: request.content,
      user: conn.sub,
      access,
      perms: this.perms,
      suggestionOwners: this.suggestionOwners(),
      fieldsChangedSinceBase: new Set(),
      serverAuthored: true,
      origin: request.reason,
    });
    if (!verdict.ok)
      return reject(verdict.code, verdict.reason, DEFAULT_ACTION[verdict.code], verdict.scopes);
    // 8. Order and stamp.
    const seq = this.tentativeSeq + 1;
    const commit: SnapshotCommit = {
      seq,
      id: request.id,
      kind: 'snapshot',
      steps: [],
      snapshot: { checkpoint: request.checkpoint, reason: request.reason },
      user: conn.sub,
      session: SERVER_SESSION,
      time: this.now(),
      origin: request.reason,
      scopes: verdict.scopes,
      revision: this.perms.revision,
      cdm: 1,
      engine: ENGINE,
      retired: inv.value.removedRegions,
      claimed: verdict.claimedSuggestionIds,
      base: this.tentativeSeq,
      rebased: false,
      ...(inv.requires ? { requires: inv.requires } : {}),
    };
    const index = PermissionIndex.build(request.content);
    this.queued.push({
      stored: commit,
      channel: null,
      waiters: new Set(),
      requesters: new Set([requester]),
      rebased: false,
      docAfter: request.content,
      maps: [],
      claimedBy: verdict.claimedBy,
      index,
    });
    this.tentativeDoc = request.content;
    this.tentativeSeq = seq;
    this.tentativeIndex = index;
    if (inv.requires) this.tentativeRequires = inv.requires;
    this.startWrite(fx);
    return fx;
  }

  // -------------------------------------------------------------------------------------------
  // Persistence (04 §5 steps 9 and 10, "When a write fails").

  private startWrite(fx: Effects): void {
    if (this.stopped || this.writing || this.queued.length === 0) return;
    const first = this.queued[0]!;
    if (isSnapshot(first.stored)) {
      // A snapshot commit is written alone, once everything before it is stored, and the
      // checkpoint of the durable state right before it is asked for (08 §3).
      this.writing = [first];
      this.queued = this.queued.slice(1);
      fx.write = {
        epoch: this.epoch,
        revision: first.stored.revision,
        fromSeq: first.stored.seq,
        commits: [],
        snapshot: first.stored,
      };
      fx.checkpoints = [
        ...(fx.checkpoints ?? []),
        {
          seq: this.durableSeq,
          doc: this.durableDoc,
          reason: 'snapshot',
          ...(this.threads.size ? { threads: this.threadAnchors() } : {}),
        },
      ];
      return;
    }
    // A batch shares one grants revision, so that the write's condition covers every commit in it,
    // and stops before a snapshot commit.
    const revision = first.stored.revision;
    let n = 0;
    while (
      n < this.queued.length &&
      this.queued[n]!.stored.revision === revision &&
      !isSnapshot(this.queued[n]!.stored)
    )
      n++;
    this.writing = this.queued.slice(0, n);
    this.queued = this.queued.slice(n);
    fx.write = {
      epoch: this.epoch,
      revision,
      fromSeq: first.stored.seq,
      commits: this.writing.map((p) => p.stored as StoredCommit),
    };
  }

  writeCompleted(result: WriteResult): Effects {
    const fx = this.fx();
    const batch = this.writing;
    this.writing = null;
    if (!batch || this.stopped) return fx;
    switch (result.status) {
      case 'ok':
        this.commitBatch(batch, fx);
        break;
      case 'unknown': {
        // Re-read the log tail before deciding (04 §5).
        let k = 0;
        while (
          k < batch.length &&
          k < result.tail.length &&
          result.tail[k]!.id === batch[k]!.stored.id &&
          result.tail[k]!.seq === batch[k]!.stored.seq
        )
          k++;
        if (result.tail.length > k) {
          this.halt(fx, 'fenced', batch);
          return fx;
        }
        this.commitBatch(batch.slice(0, k), fx);
        this.discard(batch.slice(k), fx);
        break;
      }
      case 'failed':
        this.discard(batch, fx);
        break;
      case 'revision_moved':
        this.discard(batch, fx);
        this.setPermissions(result.perms, fx);
        break;
      case 'duplicate': {
        // A conflict on the commit identifier alone is a duplicate, never another writer (04 §5).
        const s = result.stored;
        if (s.seq > this.durableSeq) {
          // The log holds commits this room does not know: another writer.
          this.halt(fx, 'fenced', batch);
          return fx;
        }
        this.byId.set(s.id, s);
        const dup = batch.find((p) => p.stored.id === s.id);
        if (dup) this.answerDuplicate(dup, s, fx);
        this.discard(
          batch.filter((p) => p !== dup),
          fx,
        );
        break;
      }
      case 'fenced':
        this.halt(fx, 'fenced', batch);
        return fx;
      case 'lost':
        this.halt(fx, 'lost', batch);
        return fx;
    }
    this.ensureControlCommit();
    this.startWrite(fx);
    return fx;
  }

  /** Answers the requests behind a commit whose identifier storage already holds. */
  private answerDuplicate(p: Pending, stored: LogCommit, fx: Effects): void {
    const same = stored.user === p.stored.user;
    const reply = (channel: string): void => {
      fx.send.push({
        channel,
        msg: same
          ? this.rebuiltAck(stored)
          : {
              t: 'sync.reject',
              id: p.stored.id,
              code: 'invalid_op',
              action: 'drop',
              head: this.durableSeq,
              reason: 'the commit id belongs to another user',
            },
      });
    };
    for (const chId of [p.channel, ...p.waiters]) {
      if (chId === null) continue;
      const ch = this.channels.get(chId);
      if (!ch || ch.inflight !== p.stored.id) continue;
      ch.inflight = null;
      reply(chId);
    }
    for (const r of p.requesters) reply(r);
  }

  /** Advances the durable state and acknowledges and broadcasts, in sequence order (step 10). */
  private commitBatch(batch: Pending[], fx: Effects): void {
    const regionsBefore = regionListKey(this.durableIndex.regionList());
    this.commitBatchSteps(batch, fx);
    // A stored commit that adds, removes or re-policies a region changes what connected people may
    // do in it, so their access is recomputed and sent (PRM-036 criterion 1; 07 §9).
    if (regionListKey(this.durableIndex.regionList()) !== regionsBefore) this.sendAccessChanges(fx);
  }

  private commitBatchSteps(batch: Pending[], fx: Effects): void {
    for (const p of batch) {
      const before = this.durableDoc;
      this.record(p.stored, p.maps, p.claimedBy);
      this.durableDoc = p.docAfter;
      if (p.index) this.durableIndex = p.index;
      const c = p.stored;
      // Comment ranges advance with the durable state (SYN-032); commenting creates no commit.
      if (c.kind !== 'control' && this.threads.size)
        for (const [id, t] of this.threads)
          this.threads.set(
            id,
            mapThread(t, isSnapshot(c) ? null : p.maps, before, p.docAfter, c.seq),
          );
      if (isSnapshot(c)) {
        // Every subscriber reloads (04 §3.2, §8): `sync.reset`, never `sync.commit`.
        const content = this.content(c.seq, p.docAfter);
        for (const ch of this.channels.values())
          fx.send.push({
            channel: ch.id,
            msg: { t: 'sync.reset', seq: c.seq, reason: c.snapshot.reason, content },
          });
      } else {
        for (const ch of this.channels.values()) {
          const isAuthor = p.channel === ch.id && ch.inflight === c.id;
          const isWaiter = p.waiters.has(ch.id) && ch.inflight === c.id;
          if (isAuthor || isWaiter) {
            ch.inflight = null;
            const rebased = p.rebased || isWaiter;
            fx.send.push({
              channel: ch.id,
              msg: {
                t: 'sync.ack',
                id: c.id,
                seq: c.seq,
                time: c.time,
                rebased,
                ...(rebased ? { steps: c.steps } : {}),
              },
            });
          } else {
            fx.send.push({ channel: ch.id, msg: { t: 'sync.commit', commit: c } });
          }
        }
      }
      for (const r of p.requesters)
        fx.send.push({
          channel: r,
          msg: {
            t: 'sync.ack',
            id: c.id,
            seq: c.seq,
            time: c.time,
            rebased: p.rebased,
            ...(p.rebased && !isSnapshot(c) ? { steps: c.steps } : {}),
          },
        });
    }
  }

  /** Discards the tentative state; commits that were not stored are rejected with `unavailable`. */
  private discard(batch: Pending[], fx: Effects): void {
    const reject = (channel: string, id: string): void => {
      fx.send.push({
        channel,
        msg: {
          t: 'sync.reject',
          id,
          code: 'unavailable',
          action: 'retry',
          head: this.durableSeq,
          reason: 'the commit was not stored; resubmit it',
          // BE-077: a delay before the resubmission, as the draining node gives (room-host.ts).
          retryAfterMs: 1000,
        },
      });
    };
    for (const p of [...batch, ...this.queued]) {
      for (const chId of [p.channel, ...p.waiters]) {
        if (chId === null) continue;
        const ch = this.channels.get(chId);
        if (!ch || ch.inflight !== p.stored.id) continue;
        ch.inflight = null;
        reject(chId, p.stored.id);
      }
      for (const r of p.requesters) reject(r, p.stored.id);
    }
    this.queued = [];
    this.tentativeDoc = this.durableDoc;
    this.tentativeSeq = this.durableSeq;
    this.tentativeIndex = this.durableIndex;
    this.tentativeRequires = [...this.durableRequires];
  }

  /**
   * Stops serving: every channel is closed, and every waiting requester is told (04 §5).
   * @param batch the batch whose write just completed, which is no longer in `writing`
   */
  private halt(fx: Effects, reason: CloseReason, batch: readonly Pending[] = []): void {
    this.stopped = true;
    for (const ch of this.channels.values())
      fx.send.push({ channel: ch.id, msg: { t: 'ch.closed', code: 'unavailable', reason } });
    for (const p of [...batch, ...this.pending()])
      for (const r of p.requesters)
        fx.send.push({
          channel: r,
          msg: {
            t: 'sync.reject',
            id: p.stored.id,
            code: 'unavailable',
            action: 'retry',
            head: this.durableSeq,
            reason: 'the room stopped serving this document',
          },
        });
    this.channels.clear();
    this.writing = null;
    this.queued = [];
  }

  /**
   * Stops the room, for example when its host evicts it or cannot settle the outcome of a write
   * (storage's `OutcomeUnknownError`). Every channel is closed with `ch.closed` and `unavailable`;
   * nothing more is written. The next room starts from storage.
   */
  stop(): Effects {
    const fx = this.fx();
    if (!this.stopped) this.halt(fx, 'stopped');
    return fx;
  }

  // -------------------------------------------------------------------------------------------
  // Permission changes (07 §9).

  /** The control plane changed grants, states or leases and notified the room. */
  permissionsChanged(perms: PermissionState): Effects {
    const fx = this.fx();
    if (this.stopped) return fx;
    this.setPermissions(perms, fx);
    this.ensureControlCommit();
    this.startWrite(fx);
    return fx;
  }

  /**
   * The workflow moved (FRW-035): a transition, a completion or an activation. `record` is the new
   * state of the workflow; `perms` is the permission state the control plane stored with it, whose
   * revision is higher when the transition changes what a connection may do (the lock, an
   * activation). From this call the room enforces the new access. A channel gets `perm.changed`
   * first (every channel with `perms`; only the channels whose access changed without it) and
   * then, when its own workflow object changed, `wf.changed` with the complete new object. A channel is told nothing about other participants. The revision is
   * recorded as a control commit, as for `permissionsChanged`.
   */
  workflowChanged(record: WorkflowRecord, perms?: PermissionState): Effects {
    const fx = this.fx();
    if (this.stopped) return fx;
    this.workflow = record;
    if (perms !== undefined) this.setPermissions(perms, fx);
    // A transition that changes access under the same revision (no lock moved) is sent as an expiry is.
    this.sendAccessChanges(fx);
    for (const ch of this.channels.values()) {
      const view = this.workflowFor(ch.conn);
      const text = view === null ? null : JSON.stringify(view);
      if (text === (ch.workflow ?? null)) continue;
      ch.workflow = text;
      if (view !== null) fx.send.push({ channel: ch.id, msg: { t: 'wf.changed', workflow: view } });
    }
    this.ensureControlCommit();
    this.startWrite(fx);
    return fx;
  }

  /** The document's workflow as the room holds it, or null (FRW-035). */
  get workflowRecord(): WorkflowRecord | null {
    return this.workflow;
  }

  private setPermissions(perms: PermissionState, fx: Effects): void {
    if (perms.revision < this.perms.revision) return;
    this.perms = perms;
    for (const ch of this.channels.values()) {
      ch.access = this.access(ch.conn);
      fx.send.push({
        channel: ch.id,
        msg: { t: 'perm.changed', revision: perms.revision, access: ch.access },
      });
    }
  }

  /**
   * The next time a grant or a lease expires, or null (07 §4, last paragraph; PRM-007). The host
   * calls `expire()` then. It is derived from the permission state, so a room opened after a
   * restart has the same schedule.
   */
  get nextExpiry(): number | null {
    return earliestExpiry(this.perms, this.now());
  }

  /**
   * Recomputes every connection's access at an expiry and sends `perm.changed` where it changed
   * (07 §4; PRM-007). Commits never wait for it: each is checked with access computed afresh.
   */
  expire(): Effects {
    const fx = this.fx();
    if (this.stopped) return fx;
    this.sendAccessChanges(fx);
    return fx;
  }

  /**
   * Recomputes every connection's access and sends `perm.changed` to each whose access changed
   * (07 §4, §9; PRM-006 and PRM-036). Used at an expiry and when a stored commit changes the region
   * list or a region's policy.
   */
  private sendAccessChanges(fx: Effects): void {
    for (const ch of this.channels.values()) {
      const next = this.access(ch.conn);
      if (sameAccess(next, ch.access)) continue;
      ch.access = next;
      fx.send.push({
        channel: ch.id,
        msg: { t: 'perm.changed', revision: this.perms.revision, access: next },
      });
    }
  }

  /**
   * A channel's token was refreshed (05 §5.1 `auth.refresh`; 05 §3.1): its claims can differ
   * (role, groups, participant roles, `access_since`, `jti`), so access is computed again and
   * `perm.changed` is sent when it changed. A token for another user closes the channel.
   */
  refresh(channel: string, conn: RoomConnection): Effects {
    const fx = this.fx();
    const ch = this.channels.get(channel);
    if (!ch || this.stopped) return fx;
    if (conn.sub !== ch.conn.sub) {
      this.close(channel);
      fx.send.push({
        channel,
        msg: { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
      });
      return fx;
    }
    const restrictionsChanged = !sameRestrictions(ch.conn.restrictions, conn.restrictions);
    ch.conn = conn;
    const next = this.access(conn);
    // A change of output restrictions alone is a change of access too (PRO-015 criterion 4).
    if (restrictionsChanged || !sameAccess(next, ch.access)) {
      ch.access = next;
      fx.send.push({
        channel,
        msg: { t: 'perm.changed', revision: this.perms.revision, access: next },
      });
    }
    return fx;
  }

  // -------------------------------------------------------------------------------------------
  // Comment threads (07 §6; ADR 0015; SYN-032, SYN-033; PRM-037 to PRM-040). Thread requests are
  // control-plane calls: they read the durable head, change nothing in the document, the log or
  // the head, and answer with an outcome rather than effects.

  /** The comment anchors at the durable head, to save with a checkpoint (SYN-032) or to serve. */
  threadAnchors(): ThreadAnchor[] {
    return [...this.threads.values()].map((t) => cloneAnchor(t.anchor));
  }

  /** How many threads the document holds (07 §6: at most `threadLimit`). */
  get threadCount(): number {
    return this.threads.size;
  }

  /**
   * Starts a thread (07 §6, first bullet; SYN-033; PRM-037, PRM-038, PRM-040). A range is mapped
   * from its `baseSeq` to the head through the stored commits, which must lie within the rebase
   * window and cross no snapshot commit; the caller needs `comment` in every scope the mapped
   * range covers, with the permissions in force now. A block target must exist at the head.
   */
  createThread(req: ThreadRequest): ThreadOutcome {
    const no = (code: ThreadRefusalCode, reason: string, scopes?: string[]): ThreadOutcome =>
      scopes ? { ok: false, code, reason, scopes } : { ok: false, code, reason };
    if (this.stopped) return no('unavailable', 'the room has stopped serving this document');
    if (!isObject(req) || !isUuid7(req.id))
      return no('invalid_op', 'a thread needs a UUID version 7 id');
    const known = this.threads.get(req.id);
    if (known) {
      // A retry of the same request is answered again; another request may not take the id.
      return known.anchor.author === req.as.sub
        ? { ok: true, thread: cloneAnchor(known.anchor) }
        : no('conflict', 'the thread id is taken');
    }
    if (this.threads.size >= this.threadLimit)
      return no('quota_exceeded', `a document holds at most ${this.threadLimit} threads (07 §6)`);
    const doc = this.durableDoc;
    let target: ThreadAnchor['target'];
    let scopes: string[];
    let blockPos: number | null = null;
    if (isObject(req.target) && 'range' in req.target) {
      const { from, to, baseSeq } = req.target.range;
      if (![from, to, baseSeq].every((n) => Number.isSafeInteger(n) && n >= 0) || to <= from)
        return no('invalid_op', 'a range needs integer positions with from < to and a baseSeq');
      if (baseSeq > this.durableSeq) return no('invalid_op', 'baseSeq is ahead of the head');
      if (baseSeq < this.baseSeq || this.snapshotSeqs.some((s) => s > baseSeq))
        return no(
          'stale_base',
          'the range cannot be mapped from its baseSeq (a snapshot or an older log)',
        );
      const steps =
        this.cumSteps[this.cumSteps.length - 1]! - this.cumSteps[baseSeq - this.baseSeq]!;
      if (steps > this.limits.maxRebaseSteps)
        return no('stale_base', `more than ${this.limits.maxRebaseSteps} steps since baseSeq`);
      const maps: StepMap[] = [];
      for (let s = baseSeq + 1; s <= this.durableSeq; s++)
        maps.push(...(this.maps[s - this.baseSeq - 1] ?? []));
      const [m] = mapRanges([{ from, to }], maps);
      if (m!.to > doc.content.size) return no('invalid_op', 'the range lies outside the document');
      if (m!.collapsed) return no('conflict', 'the text the range covered has been deleted');
      target = { range: { from: m!.from, to: m!.to } };
      scopes = rangeScopes(doc, m!.from, m!.to);
    } else if (
      isObject(req.target) &&
      typeof (req.target as { block?: unknown }).block === 'string'
    ) {
      const id = (req.target as { block: string }).block;
      const found = findBlock(doc, id);
      if (!found) return no('not_found', `no block ${id} at the head`);
      target = { block: id };
      scopes = [found.scope];
      blockPos = found.pos;
    } else return no('invalid_op', 'a target is a range or a block');
    if (scopes.includes('doc'))
      return no('invalid_op', 'a thread targets content, not the definitions');
    const decision = authoriseThread('create', {
      access: this.durableAccess(req.as),
      user: req.as.sub,
      scopes,
      archived: this.perms.documentState === 'archived',
    });
    if (!decision.ok) return no(decision.code, decision.reason, decision.scopes);
    const anchor: ThreadAnchor = {
      id: req.id,
      author: req.as.sub,
      target,
      seq: this.durableSeq,
      detached: false,
    };
    this.threads.set(req.id, { anchor, blockPos });
    return { ok: true, thread: cloneAnchor(anchor) };
  }

  /**
   * Whether a caller may act on a thread now (07 §12 rows 4 and 5; PRM-037 to PRM-039): reply,
   * resolve, reopen, assign, delete, read; `retarget` is refused for everyone. A thread the caller
   * cannot see is `not_found`.
   */
  threadAccess(threadId: string, conn: Connection, action: ThreadAction): ThreadOutcome {
    const t = this.threads.get(threadId);
    if (!t) return { ok: false, code: 'not_found', reason: 'no such thread' };
    const d = authoriseThread(action, {
      access: this.durableAccess(conn),
      user: conn.sub,
      scopes: threadScopes(t, this.durableDoc),
      author: t.anchor.author,
      archived: this.perms.documentState === 'archived',
    });
    if (!d.ok) return d.scopes ? { ...d, scopes: d.scopes } : d;
    return { ok: true, thread: cloneAnchor(t.anchor) };
  }

  /** The scopes a thread covers now, or covered when it was last attached. */
  threadScopes(threadId: string): string[] | null {
    const t = this.threads.get(threadId);
    return t ? threadScopes(t, this.durableDoc) : null;
  }

  /** Forgets a deleted thread (after the control plane authorised and stored the deletion). */
  deleteThread(threadId: string): boolean {
    return this.threads.delete(threadId);
  }

  // -------------------------------------------------------------------------------------------
  // Region states (07 §11; PRM-046).

  /**
   * What an approval of a region binds to now: the durable head and the canonical text of the
   * region's content without field values, whose SHA-256 (`approvalHash`) the state record holds.
   * Computed from the room's own document, never taken from the client. Null when the region does
   * not exist, or when a commit waiting to be stored changes it (the approval would race it).
   */
  regionApproval(regionId: string): { seq: number; canonical: string } | null {
    const entry = this.durableIndex.region(regionId);
    if (!entry) return null;
    if (this.pending().some((p) => p.stored.scopes.includes(`region:${regionId}`))) return null;
    const node = this.durableDoc.nodeAt(entry.pos);
    if (!node || node.type.name !== 'region') return null;
    return { seq: this.durableSeq, canonical: regionCanonicalText(node) };
  }

  /**
   * The region at the durable head for each approval in the permission state (07 §11; SEC-030),
   * or null for an approved region that is not in the document. The room stays synchronous:
   * `verifyRoomApprovals` (permissions/approval-check.ts) hashes these against the stored hashes.
   */
  approvedRegions(): Map<string, Node | null> {
    const out = new Map<string, Node | null>();
    for (const id of this.perms.approvals?.keys() ?? []) {
      const entry = this.durableIndex.region(id);
      const node = entry ? this.durableDoc.nodeAt(entry.pos) : null;
      out.set(id, node && node.type.name === 'region' ? node : null);
    }
    return out;
  }

  /** Records the current grants revision in the log as a control commit (04 §3.2; 07 §3, §9). */
  private ensureControlCommit(): void {
    if (this.stopped || this.perms.revision === this.recordedRevision) return;
    if (
      this.pending().some(
        (p) =>
          p.stored.kind === 'control' &&
          p.stored.evidence === undefined &&
          p.stored.revision === this.perms.revision,
      )
    )
      return;
    const seq = this.tentativeSeq + 1;
    const commit: StoredCommit = {
      seq,
      id: controlCommitId(this.perms.revision, seq),
      kind: 'control',
      steps: [],
      user: SYSTEM_USER,
      session: SERVER_SESSION,
      time: this.now(),
      origin: 'control',
      scopes: [],
      revision: this.perms.revision,
      cdm: 1,
      engine: ENGINE,
      retired: [],
      claimed: [],
    };
    this.queued.push({
      stored: commit,
      channel: null,
      waiters: new Set(),
      requesters: new Set(),
      rebased: false,
      docAfter: this.tentativeDoc,
      maps: [],
    });
    this.tentativeSeq = seq;
  }
}

/**
 * A deterministic UUID version 7 for a control commit, so that a retry cannot record it twice
 * (04 §10). The time field carries the revision and the random field the sequence number.
 */
export function controlCommitId(revision: number, seq: number): string {
  const hex = (n: number, len: number) => n.toString(16).padStart(len, '0').slice(-len);
  const t = hex(revision, 12);
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7000-8000-${hex(seq, 12)}`;
}
