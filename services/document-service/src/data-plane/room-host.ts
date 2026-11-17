/**
 * The room host (06 §2; BE-019 to BE-026; PRM-019; SYN-004), with the phase 1b work of packet A:
 * checkpoints (BE-020), idle close and the memory budget (BE-021), drain (BE-022), transient
 * authorities (BE-023; SYN-031), snapshot commits (BE-037; PRO-030), the commit pages and the one
 * visibility gate (BE-038; HIS-024), `sync.check` (SYN-043) and the audit of rejections (PRM-051).
 *
 * Opening (06 §2.2 step 1; BE-019). Claim ownership, which raises the epoch and so fences any
 * earlier owner (with node leases, only when no live node owns the document, BE-018); then read the
 * head with the incarnation, the newest usable checkpoint at or before it, the log after the
 * checkpoint, the permissions in force and the revision in force at the checkpoint. Build the room
 * of `@docedit/authority` from them and wrap it in the projection gateway (ADR 0019).
 *
 * Serving (step 2). Every room call is synchronous and returns effects: the messages go out
 * through the DEP bridge (`@docedit/protocol/bridge`), and the write, when there is one, goes to
 * the log store. One write is in flight per room; what arrives meanwhile joins the next write
 * (BE-024). Acknowledgements and broadcasts leave only after the write has committed.
 *
 * Checkpoints (step 3). After 2,000 commits or ten minutes of activity, but not more often than
 * every two minutes, around a snapshot commit, and when the room closes with changes. A worker
 * thread replays the steps stored since the last checkpoint onto it and serialises the result
 * (SYN-039); the main thread passes plain data. `sync.check` then tells the full-view channels the
 * hash of the durable document at that `seq` (04 §13).
 *
 * Stopping. A fenced write stops the room: another writer holds the document (BE-017). A write
 * whose outcome could not be established, not even by reading the log back, stops it as well
 * (BE-025). A room without channels for `roomIdleMs` checkpoints if it has changes and releases
 * ownership (step 4). A drain stops new commits, lets the writes in flight finish and be answered,
 * checkpoints, and releases (step 5). A node that loses its lease stops every room at once.
 */
import {
  ENGINE,
  ProjectionGateway,
  Room,
  SERVER_SESSION,
  isSnapshot,
  project,
  projectionSchema,
  regionPolicyOf,
  rejectionAudit,
  verifyRoomApprovals,
  type CloseReason,
  type Connection,
  type Effects,
  type LogCommit,
  type PermissionState,
  type Preconditions,
  type RegionInfo,
  type Resume as RoomResume,
  type RoomConnection,
  type SnapshotCommit,
  type SnapshotReason,
  type StepJson,
  type ToClient,
  type WriteRequest,
  type WriteResult,
} from '@docedit/authority';
import { mathGateReason } from '@docedit/export-latex';
import type { JsonEnvelope, JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type {
  ChannelClosed,
  ChannelOpened,
  Commit,
  Content,
  Inflight,
  Notification,
  PresencePeers,
  PresenceUpdate,
  Resume,
  SessionUser,
  SyncCheck,
} from '@docedit/protocol';
import {
  RoomBridge,
  closeReasonText,
  toRemoteCommit,
  type DepEvent,
  type DepOutbound,
} from '@docedit/protocol/bridge';
import type {
  CommitPage,
  ContentRead,
  ErrorContext,
  UserLookup,
  VerifiedIdentity,
} from '../seams.ts';
import {
  DocumentNotFoundError,
  type AppendOptions,
  type CheckpointStore,
  type DocRef,
  type DocumentRecord,
  type DocumentStore,
  type GrantStore,
  type LogStore,
  type NodeLeaseStore,
  type OwnershipStore,
} from '../storage/types.ts';
import type { EventSink } from '../control-plane/events.ts';
import type { Auditor } from './audit.ts';
import type { Checkpointer, LoadedCheckpoint } from './checkpoints.ts';
import { gateOf, historySetting, rangeAllowed, stateAllowed } from './gate.ts';
import type { Faults } from './hooks.ts';
import type { NodeLease } from './lease.ts';
import type { Metrics } from './metrics.ts';
import { PresenceRelay } from './presence.ts';
import type { Settings } from './settings.ts';
import { BroadcastWindow } from './syn-041-coalescing.ts';
import type { Base, Encoded } from './tasks.ts';
import type { OpenSpan, TraceContext, Tracer } from './tracing.ts';
import { hidesNothing, type ViewTokens } from './view.ts';
import { DataPlaneError, Refusal, RequestRefused } from './wire.ts';
import type { Workers } from './workers.ts';

let schemaCache: ReturnType<typeof cdmSchema> | undefined;
const schemaOf = () => (schemaCache ??= cdmSchema());
type Doc = Room['document'];

/** The canonical size limit of a document (I7): 16 MiB. */
export const CANONICAL_LIMIT = 16 * 1024 * 1024;

/** What a room needs from the composition. */
export interface HostDeps {
  readonly logs: LogStore;
  readonly ownership: OwnershipStore;
  readonly grants: GrantStore;
  readonly documents: DocumentStore;
  readonly checkpoints: CheckpointStore | undefined;
  readonly node: string;
  readonly now: () => number;
  readonly settings: Settings;
  readonly tokens: ViewTokens;
  /** Host `sub` values of surrogates, for the wire (D42; S6 gap G11); without it the wire shows surrogates. */
  readonly users: UserLookup | undefined;
  // --- Phase 1b ---------------------------------------------------------------------------------
  readonly checkpointer: Checkpointer;
  readonly workers: Workers;
  readonly audit: Auditor;
  /** Raises `dep.commit.rejected` for an audited refusal (PRM-053 criterion 3). Optional. */
  readonly events?: EventSink;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  readonly faults: Faults;
  /** The node lease when leases are configured (BE-018). */
  readonly lease: NodeLease | null;
  readonly leases: NodeLeaseStore | undefined;
  /** Whether a visibility function was configured (read restrictions may hide content). */
  readonly restricted: boolean;
}

/** How a room reaches one channel of a session. */
export interface ChannelPort {
  /** The session (UUID version 7) the channel belongs to. */
  readonly session: string;
  /** The identity presence shows for the session (05 §5.4). */
  readonly user: SessionUser;
  /** Whether the session announced `presence` and the server offers it (05 §1 rule 4). */
  readonly wantsPresence: boolean;
  /** The features the client announced in `ch.open` (03 §11.1; D120). */
  readonly features: readonly string[];
  /** The session's trace (BE-087), or null. */
  readonly trace: TraceContext | null;
  /** `ch.opened`, before anything else on the channel. */
  opened(d: ChannelOpened): void;
  /** Any other message; `re` for `sync.ack` and `sync.reject`. */
  send(e: DepEvent, re?: string): void;
  presence(p: PresencePeers): void;
  /** A notification: "this changed; fetch it over REST if you care" (05 §5.6). */
  event(n: Notification): void;
  /** `sync.check`: the hash of the durable document at a `seq` (04 §13). */
  check(d: SyncCheck): void;
  /** The room closed the channel (`ch.closed`), with the room's reason when it gave one. */
  closed(d: ChannelClosed, cause: CloseReason | undefined): void;
}

interface Timing {
  readonly at: number;
  readonly span: OpenSpan;
}

interface HostedChannel {
  readonly key: string;
  readonly port: ChannelPort;
  conn: RoomConnection;
  /** The gateway's token of the channel's visibility class. */
  gatewayView: string;
  /** The submit whose commit is waiting for its answer on this channel (05 §5.3). */
  inflight: ({ commit: string; envelope: string } & Timing) | null;
}

interface Answering {
  key: string;
  envelope: string;
  answered: boolean;
  timing: Timing;
}

/** The content of a snapshot commit, encoded once (in a worker) for the checkpoint and the log. */
export interface SnapshotContent extends Encoded {
  readonly envelope: JsonEnvelope;
}

/** A server-authored operation (04 §10; SYN-030; BE-039): a snapshot or a step commit. */
export type ServerOp =
  | {
      kind: 'snapshot';
      /** The deterministic commit identifier (UUID version 7). */
      id: string;
      reason: SnapshotReason;
      /** A surrogate or `system`. */
      actor: string;
      content: SnapshotContent;
      preconditions?: Preconditions;
      trace?: TraceContext | null;
    }
  | {
      kind: 'author';
      id: string;
      origin: string;
      actor: string;
      base: number;
      steps: unknown;
      preconditions?: Preconditions;
      trace?: TraceContext | null;
    };

interface Request {
  resolve: (r: { seq: number }) => void;
  reject: (e: unknown) => void;
  /** Who the commit is attributed to: a surrogate or `system` (for the audit trail, PRM-051). */
  actor: string;
}

/** Channel keys of requesters can never be those of sessions (`<session>#<ch>`). */
const REQUESTER = '\u0000request:';

/**
 * Who a server-authored commit is checked as (04 §10; ADR 0053 D124): the control plane authorised
 * it with a service credential, so it has an owner's capabilities, attributed to the actor.
 */
function requesterOf(actor: string): Connection | 'system' {
  if (actor === 'system') return 'system';
  return {
    sub: actor,
    session: SERVER_SESSION,
    role: 'owner',
    groups: [],
    participantRoles: [],
    participantActive: false,
  };
}

/** The regions of a body as JSON (03 §4.2), as `regionsOf` reads them from a document. */
export function regionsOfJson(doc: unknown): RegionInfo[] {
  const top = (doc as { content?: Array<{ content?: unknown[] }> } | null)?.content;
  const body = top?.[top.length - 1];
  const out: RegionInfo[] = [];
  for (const c of (body?.content ?? []) as Array<{ type: string; attrs?: Record<string, unknown> }>)
    if (c.type === 'region')
      out.push({ id: String(c.attrs?.['id'] ?? ''), policy: regionPolicyOf(c.attrs?.['policy']) });
  return out;
}

/** A commit's steps as stored, for replays: none for control and snapshot commits. */
const stepsOf = (c: LogCommit): StepJson[] => (isSnapshot(c) ? [] : c.steps);

const refKey = (ref: DocRef) => `${ref.tenant}/${ref.doc}`;

const SYNTHETIC_BASE = '00000000-0000-7000-8000-000000000000';

export class HostedRoom {
  readonly ref: DocRef;
  readonly record: DocumentRecord;
  readonly epoch: number;
  readonly incarnation: string;
  /** A transient authority (06 §2.2, last paragraph): no channels, no timers (BE-023). */
  readonly transient: boolean;
  /** Counters for tests and metrics (06 §11: persist batch size). */
  readonly stats = { writes: 0, committed: 0, largestBatch: 0, checkpoints: 0, checks: 0 };
  readonly #room: Room;
  readonly #gateway: ProjectionGateway;
  readonly #bridge: RoomBridge;
  /** The broadcast window of SYN-041, when the operator configured coalescing. */
  readonly #window: BroadcastWindow | null;
  readonly #presence: PresenceRelay;
  readonly #deps: HostDeps;
  readonly #channels = new Map<string, HostedChannel>();
  /** Every stored commit the room knows: identifier to `seq` and author, for `inflight` (D08). */
  readonly #stored = new Map<string, { seq: number; user: string }>();
  readonly #onStop: (room: HostedRoom, reason: string) => void;
  /** Surrogate to the host's `sub`, for the wire (D42): authors, lease holders, sessions. */
  readonly #subs: Map<string, string>;
  #writing: WriteRequest | null = null;
  /** Failed writes in a row, for the backoff before the next one. */
  #failures = 0;
  #delayed: ReturnType<typeof setTimeout> | null = null;
  #writeDone: Array<() => void> = [];
  #stopped = false;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #expiry: ReturnType<typeof setTimeout> | null = null;
  // --- Phase 1b ---------------------------------------------------------------------------------
  #draining = false;
  #closingIdle = false;
  readonly #requests = new Map<string, Request>();
  readonly #snapshots = new Map<string, SnapshotContent>();
  /** The last checkpoint (or what the room opened from) and the steps stored since. */
  #base: { seq: number; base: Base; bytes: number };
  #baseGen = 0;
  #since: StepJson[][] = [];
  #sinceBytes = 0;
  #firstSinceAt: number | null = null;
  #lastCheckpointAt: number;
  /** When the room opened, for the open-room time of BE-085. */
  readonly #openedAt: number;
  #checkpointing: Promise<boolean> | null = null;
  #checkpointAgain = false;
  #checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  #checkpointFailures = 0;
  /** A `seq` whose checkpoint object may hold the content of a snapshot that was never stored. */
  #tainted: number | null = null;
  #lastTrace: TraceContext | null = null;
  /** The heads of the recent past with the time they became the head (D126), oldest first. */
  #heads: Array<{ seq: number; at: number }> = [];
  /** When the last channel left, for the order in which idle rooms are closed (BE-021). */
  idleSince: number | null = null;

  constructor(init: {
    ref: DocRef;
    record: DocumentRecord;
    epoch: number;
    incarnation: string;
    /** The content at `initialSeq` (a checkpoint, or the content at 0, D67). */
    initial: Doc;
    initialSeq: number;
    /** The same content as plain data, for the checkpoint worker. */
    base: Base;
    /** Its canonical size, an estimate where the bytes are unknown. */
    baseBytes: number;
    /** Stored commits after `initialSeq`, in order. */
    log: readonly LogCommit[];
    /** The content of each snapshot commit in `log`. */
    snapshots: ReadonlyMap<number, { doc: Doc; json: JsonEnvelope }>;
    perms: PermissionState;
    /** The grants revision in force at `initialSeq`. */
    initialRevision: number;
    /** The host `sub` of each surrogate the log and the leases name (D42). */
    subs: ReadonlyMap<string, string>;
    deps: HostDeps;
    onStop: (room: HostedRoom, reason: string) => void;
    transient?: boolean;
  }) {
    const { deps } = init;
    this.ref = init.ref;
    this.record = init.record;
    this.epoch = init.epoch;
    this.incarnation = init.incarnation;
    this.transient = init.transient ?? false;
    this.#deps = deps;
    this.#onStop = init.onStop;
    this.#subs = new Map(init.subs);
    this.#lastCheckpointAt = deps.now();
    this.#openedAt = this.#lastCheckpointAt;
    const limits = deps.settings.limits;
    const snapshotDoc = (c: SnapshotCommit): Doc => {
      const s = init.snapshots.get(c.seq);
      if (!s) throw new Error(`the content of snapshot commit ${c.seq} was not loaded`);
      return s.doc;
    };
    this.#room = new Room({
      schema: schemaOf(),
      initial: init.initial,
      initialSeq: init.initialSeq,
      requires: init.record.requires,
      log: init.log,
      snapshotContent: snapshotDoc,
      perms: init.perms,
      initialRevision: init.initialRevision,
      epoch: init.epoch,
      incarnation: init.incarnation,
      now: deps.now,
      historyVisibility: historySetting(init.record.historyVisibility),
      commitsResource: deps.settings.commitsResource,
      // Invariant I8 at commit time (03 §8; 09 §6.3; SEC-034): every new or changed `latex` value
      // passes the same gate as the converter, so `\def` or `\input` is refused with `invalid_op`
      // before it is stored, not only when a document is exported.
      mathGate: mathGateReason,
      limits: {
        maxStepsPerCommit: limits.maxStepsPerCommit,
        maxCommitBytes: limits.maxCommitBytes,
        maxRebaseSteps: limits.maxRebaseSteps,
        catchUpCommits: limits.catchUpCommits,
        catchUpBytes: limits.catchUpBytes,
      },
    });
    for (const c of init.log) {
      this.#stored.set(c.id, { seq: c.seq, user: c.user });
      this.#heads.push({ seq: c.seq, at: c.time });
    }
    // The gateway's history starts at sequence number 0. A room opened from a checkpoint at S > 0
    // gives it a stand-in snapshot commit at S, so that it holds the full document at S and treats
    // anything older as replaced (asked of the authority: an initialSeq for the gateway's history).
    const history: LogCommit[] = [...init.log];
    if (init.initialSeq > 0)
      history.unshift({
        seq: init.initialSeq,
        id: SYNTHETIC_BASE,
        kind: 'snapshot',
        steps: [],
        snapshot: { checkpoint: 'checkpoint', reason: 'repair' },
        user: 'system',
        session: SERVER_SESSION,
        time: 0,
        origin: 'repair',
        scopes: [],
        revision: init.initialRevision,
        cdm: 1,
        engine: ENGINE,
        retired: [],
        claimed: [],
      });
    // Every reader goes through the gateway, even while the visibility hides nothing (ADR 0019).
    this.#gateway = new ProjectionGateway(
      this.#room,
      schemaOf(),
      (conn, doc, perms) => deps.tokens.hidden(conn, doc, perms),
      projectionSchema(),
      {
        initial: init.initial,
        log: history,
        resolve: (c) => (c.id === SYNTHETIC_BASE ? init.initial : snapshotDoc(c)),
      },
    );
    this.#bridge = new RoomBridge({
      source: () => this.#room,
      now: deps.now,
      user: (u) => this.#wire(u),
    });
    // SYN-041 (04 §12): the room's output goes through the broadcast window when coalescing is
    // configured; the window's clock is monotonic, as it measures a delay, not server time.
    const coalescing = deps.settings.coalescing;
    this.#window =
      coalescing && !this.transient
        ? new BroadcastWindow(coalescing, {
            now: () => performance.now(),
            deliver: (out) => this.#dispatch(out),
          })
        : null;
    this.#presence = new PresenceRelay(limits);
    // What the next checkpoint replays from: the base, then the tail's steps (snapshots restart it).
    this.#base = { seq: init.initialSeq, base: init.base, bytes: init.baseBytes };
    for (const c of init.log) {
      if (isSnapshot(c)) {
        const s = init.snapshots.get(c.seq)!;
        this.#base = { seq: c.seq, base: { doc: s.json.doc }, bytes: this.#base.bytes };
        this.#since = [];
        this.#sinceBytes = 0;
      } else this.#push(stepsOf(c));
    }
    if (this.#since.length) this.#firstSinceAt = deps.now();
    // Grants changed while no room was open: the revision in force is not in the log yet. Its
    // control commit goes first, before any channel can submit, so that every commit checked
    // against a revision follows that revision's control commit (04 G7; 07 §9; PRM-019).
    let recorded = init.initialRevision;
    for (const c of init.log) if (c.kind === 'control') recorded = c.revision;
    if (init.perms.revision !== recorded) this.#apply(this.#gateway.permissionsChanged(init.perms));
    this.#scheduleExpiry();
    this.#scheduleCheckpoint();
    this.#verifyApprovals();
  }

  /**
   * SEC-030 criterion 3 (07 §11): each stored approval is checked against the region at the durable
   * head when the room opens, when permission state arrives, and after a snapshot commit is stored.
   * A mismatch is written to the audit trail as `region.approval_mismatch` (actor `system`, with the
   * region, the approved `seq`, both hashes and the head) and reported through `onError`. The check
   * is asynchronous (WebCrypto); it refuses nothing, since an approved region already refuses every
   * change (07 §4 limit 2).
   */
  #verifyApprovals(): void {
    if (this.#stopped || !this.#room.permissions.approvals?.size) return;
    const head = this.#room.head;
    verifyRoomApprovals(this.#room).then(
      (found) => {
        for (const m of found) {
          this.#deps.audit.record({
            tenant: this.ref.tenant,
            doc: this.ref.doc,
            actor: 'system',
            kind: 'region.approval_mismatch',
            data: { region: m.region, seq: m.seq, expected: m.expected, actual: m.actual, head },
            at: this.#deps.now(),
          });
          this.#report(
            new Error(`approval of region ${m.region} at seq ${m.seq}: ${m.reason}`),
            'approvals',
          );
        }
      },
      (e: unknown) => this.#report(e, 'approvals'),
    );
  }

  #push(steps: StepJson[]): void {
    this.#since.push(steps);
    this.#sinceBytes += steps.length ? JSON.stringify(steps).length : 0;
  }

  /**
   * The user the wire shows for a stored one (D42; S6 gap G11): the host's `sub`, mapped from the
   * per-tenant surrogate that commits, grants and leases store. `system` stays `system`; a user
   * whose mapping was erased shows as the surrogate.
   */
  #wire(stored: string): string {
    if (!this.#deps.users) return stored;
    return this.#subs.get(stored) ?? stored;
  }

  /** Looks up the surrogates the room does not know yet; later messages show their `sub`. */
  #resolve(users: readonly string[]): void {
    const lookup = this.#deps.users;
    if (!lookup) return;
    const unknown = [...new Set(users)].filter((u) => u !== 'system' && !this.#subs.has(u));
    if (!unknown.length) return;
    lookup.subsOf(this.ref.tenant, unknown).then(
      (found) => {
        for (const [s, sub] of found) this.#subs.set(s, sub);
      },
      (e: unknown) => this.#report(e, 'users'),
    );
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  get head(): number {
    return this.#room.head;
  }

  get channelCount(): number {
    return this.#channels.size;
  }

  get permissions(): PermissionState {
    return this.#room.permissions;
  }

  /** Whether a write is in flight (BE-024: never more than one). */
  get writing(): boolean {
    return this.#writing !== null;
  }

  get presenceStats(): PresenceRelay['stats'] {
    return this.#presence.stats;
  }

  /** The `seq` of the last checkpoint (or of the content the room opened from). */
  get checkpointSeq(): number {
    return this.#base.seq;
  }

  /** Commits stored since the last checkpoint. */
  get uncheckpointed(): number {
    return this.#since.length;
  }

  /** The features the document requires (03 §11.1), as the room holds them. */
  get requires(): readonly string[] {
    return this.#room.requiresList;
  }

  /**
   * The room's memory, estimated from the canonical size of its document and the steps stored
   * since the last checkpoint (BE-021); BE-084 measures what a room really holds.
   */
  get estimatedBytes(): number {
    return this.#base.bytes + this.#sinceBytes;
  }

  /** The features each attached channel announced (03 §11.1; for the room's feature check). */
  get clientFeatures(): string[][] {
    return [...this.#channels.values()].map((c) => [...c.port.features]);
  }

  /** Records the new head for 
ecentHead, keeping one entry older than the window. */
  #noteHead(): void {
    const now = this.#deps.now();
    this.#heads.push({ seq: this.#room.head, at: now });
    const from = now - this.#deps.settings.limits.ackTimeoutMs;
    while (this.#heads.length > 1 && this.#heads[1]!.at <= from) this.#heads.shift();
  }

  /**
   * The head as it was `windowMs` ago (D126): a reader that was given a head in `ch.opened` may
   * read the content at it even when the head moved on before the read arrived (05 §5.2).
   */
  recentHead(windowMs: number): number {
    const t = this.#deps.now() - windowMs;
    let head = this.#base.seq;
    for (const h of this.#heads) if (h.at <= t) head = h.seq;
    if (this.#heads.length && this.#heads[0]!.at > t)
      head = Math.min(head, this.#heads[0]!.seq - 1);
    return head;
  }

  /** The user's visibility gate in this room now (07 §8; HIS-024). */
  minVisibleSeq(conn: RoomConnection): number {
    return this.#room.minVisibleSeq(conn);
  }

  /**
   * Reports an error of this room with its tenant and document, and with the session where the
   * error belongs to one channel (BE-088 criterion 1).
   */
  #report(e: unknown, where: string, session?: string): void {
    this.#deps.settings.onError(e, where, {
      tenant: this.ref.tenant,
      doc: this.ref.doc,
      ...(session !== undefined ? { session } : {}),
    });
  }

  // --- Channels (05 §5.2) ----------------------------------------------------------------------

  /**
   * Attaches a channel: `ch.opened` first, then the catch-up stream and `sync.caughtUp`, then live
   * commits from `head + 1` (05 §5.2). `stored` is the permission state read from storage for this
   * open: when it is newer than the room's, the room takes it first, so that a lost notification
   * cannot let a reader in under revoked access (ADR 0019 change 3).
   */
  open(
    key: string,
    port: ChannelPort,
    conn: RoomConnection,
    resume: Resume | undefined,
    stored: PermissionState,
  ): void {
    if (this.#stopped || this.transient)
      throw new Refusal('unavailable', 'the room stopped serving the document');
    if (this.#draining) throw new Refusal('unavailable', 'the node is draining');
    this.#cancelIdle();
    this.idleSince = null;
    // The session knows both identities of its user: the surrogate and what the wire shows.
    if (this.#deps.users) this.#subs.set(conn.sub, port.user.id);
    const perms =
      stored.revision > this.#room.permissions.revision ? stored : this.#room.permissions;
    const hidden = this.#deps.tokens.hidden(conn, this.#gateway.fullHead, perms);
    const gatewayView = this.#deps.tokens.gatewayToken(hidden);
    let roomResume: RoomResume | undefined;
    if (resume) {
      // The client's keyed token must name its current class; otherwise the gateway reloads it.
      const view = this.#deps.tokens.matches(hidden, resume.view) ? gatewayView : undefined;
      roomResume = {
        seq: resume.seq,
        incarnation: resume.incarnation,
        inflight: resume.inflight ?? null,
        ...(view !== undefined ? { view } : {}),
      };
    }
    const fx = this.#gateway.open(key, conn, roomResume, stored);
    const at = fx.send.findIndex((o) => o.channel === key && o.msg.t === 'ch.opened');
    const first = at >= 0 ? fx.send[at]!.msg : undefined;
    if (!first || first.t !== 'ch.opened') {
      this.#apply(fx);
      throw new Refusal('unavailable', 'the room stopped serving the document');
    }
    // The class the gateway put the channel in, under the permissions it now holds.
    const now = this.#deps.tokens.hidden(conn, this.#gateway.fullHead, this.#room.permissions);
    const ch: HostedChannel = {
      key,
      port,
      conn,
      gatewayView: first.view ?? this.#deps.tokens.gatewayToken(now),
      inflight: null,
    };
    if (ch.gatewayView !== this.#deps.tokens.gatewayToken(now))
      this.#report(new Error('the gateway chose another class'), 'open', port.session);
    this.#channels.set(key, ch);
    if (port.trace) this.#lastTrace = port.trace;
    let inflight: Inflight | undefined;
    if (resume?.inflight !== undefined) {
      // Only the caller's own commit is reported as accepted (04 §5; 07 §16); D08.
      const s = this.#stored.get(resume.inflight);
      inflight =
        s && s.user === conn.sub ? { state: 'accepted', seq: s.seq } : { state: 'unknown' };
    }
    const opened = this.#bridge.opened(key, conn, first, inflight ? { inflight } : {});
    opened.view = this.#deps.tokens.tokenFor(now);
    const tenant = this.ref.tenant;
    this.#deps.metrics.catchUp.inc({ tenant, kind: opened.catchUp });
    if (opened.catchUp === 'stream' && resume)
      this.#deps.metrics.catchUpCommits.observe({ tenant }, Math.max(0, first.head - resume.seq));
    port.opened(opened);
    this.#presence.join(key, {
      session: port.session,
      user: port.user,
      view: () => this.#channels.get(key)?.gatewayView ?? '',
      wants: port.wantsPresence,
      send: (p) => port.presence(p),
    });
    this.#apply({ ...fx, send: fx.send.filter((_, i) => i !== at) });
  }

  /** The client closed the channel, or its connection went away. */
  close(key: string): void {
    if (!this.#channels.delete(key)) return;
    this.#bridge.detach(key);
    this.#window?.drop(key);
    this.#presence.leave(key);
    if (!this.#stopped) this.#gateway.close(key);
    if (this.#channels.size === 0) this.#armIdle();
  }

  /** The server closes one channel itself (revocation, a refreshed token, a deleted document). */
  closeChannel(key: string, d: ChannelClosed): void {
    const ch = this.#channels.get(key);
    if (!ch) return;
    // Held commits go before the close (SYN-041; 04 §5 step 10).
    if (this.#window) this.#dispatch(this.#window.end(key));
    this.close(key);
    ch.port.closed(d, undefined);
  }

  /**
   * Tells the channels that something changed (05 §5.6; PRO-035): all of them, or only those of
   * `user` (a surrogate), for example the requester of an export job.
   */
  notify(n: Notification, user?: string): void {
    for (const ch of this.#channels.values())
      if (user === undefined || ch.conn.sub === user) ch.port.event(n);
  }

  /** The channels of a user, for revocation (05 §3.3). */
  channelsOf(user: string): string[] {
    return [...this.#channels.values()].filter((c) => c.conn.sub === user).map((c) => c.key);
  }

  /**
   * A channel's token was refreshed (05 §5.1, §3.1; PRM-021): the room computes the channel's
   * access again from the new claims (role, groups, participant roles, `access_since`) and sends
   * `perm.changed` when it changed; a reader whose visibility class changed is closed and reloads.
   */
  refresh(key: string, conn: RoomConnection): void {
    const ch = this.#channels.get(key);
    if (!ch || this.#stopped) return;
    ch.conn = conn;
    this.#bridge.rebind(key, conn);
    // Access changed under the same grants revision: no control commit follows, so perm.changed
    // goes out at once, with asOfSeq at the head, as after an expiry (PRO-033).
    this.#apply(this.#gateway.refresh(key, conn), { expiry: true });
  }

  // --- Sync (05 §5.3; 04 §5) -------------------------------------------------------------------

  submit(key: string, commit: Commit, envelope: string): void {
    const ch = this.#channels.get(key);
    if (!ch || this.#stopped) return;
    const span = this.#deps.tracer.start('dep.commit', ch.port.trace, {
      tenant: this.ref.tenant,
      doc: this.ref.doc,
      session: ch.port.session,
      commit: commit.id,
    });
    const timing: Timing = { at: performance.now(), span };
    if (this.#draining) {
      // A draining node writes nothing more: the client resubmits on the node it moves to.
      const d = {
        id: commit.id,
        code: 'unavailable' as const,
        message: 'the node is draining; resubmit after reconnecting',
        action: 'retry' as const,
        head: this.#room.head,
        retryAfterMs: 1000,
      };
      // `unavailable` is not audited (PRM-051 names two codes), so only metrics and the span.
      this.#observe({ t: 'sync.reject', d }, timing);
      // A rejection never overtakes held commits with a lower seq (SYN-041, SYN-015).
      if (this.#window) this.#dispatch(this.#window.end(key));
      ch.port.send({ t: 'sync.reject', d }, envelope);
      return;
    }
    const answering: Answering = { key, envelope, answered: false, timing };
    this.#apply(this.#gateway.submit(key, commit), { answering });
    // No answer yet: the commit waits for storage, or for the copy another channel submitted.
    if (!answering.answered && this.#channels.get(key) === ch)
      ch.inflight = { commit: commit.id, envelope, ...timing };
  }

  presence(key: string, update: PresenceUpdate): void {
    if (this.#channels.has(key)) this.#presence.update(key, update);
  }

  // --- Server-authored commits (04 §10; SYN-030; BE-037, BE-039) --------------------------------

  /** A stored commit older than the room's window, found in the log by its id (04 §5 step 2). */
  rememberStored(c: LogCommit): void {
    this.#room.rememberStored(c);
  }

  /**
   * Applies a server-authored operation through the same steps as a client commit; resolves with
   * the stored `seq`, or rejects with `RequestRefused` (the room's rejection) or `unavailable`.
   */
  request(op: ServerOp): Promise<{ seq: number }> {
    if (this.#stopped)
      return Promise.reject(new DataPlaneError('unavailable', 'the room stopped serving'));
    if (op.kind === 'snapshot' && this.#room.permissions.workflowActive)
      return Promise.reject(
        new DataPlaneError('workflow_active', 'a workflow is active; the content cannot change'),
      );
    const key = `${REQUESTER}${op.id}:${Math.random().toString(36).slice(2)}`;
    if (op.trace) this.#lastTrace = op.trace;
    return new Promise((resolve, reject) => {
      this.#requests.set(key, { resolve, reject, actor: op.actor });
      const as = requesterOf(op.actor);
      let fx: Effects;
      if (op.kind === 'snapshot') {
        let content: Doc;
        try {
          content = schemaOf().nodeFromJSON(op.content.envelope.doc);
          content.check();
        } catch {
          this.#requests.delete(key);
          reject(new DataPlaneError('validation_failed', 'the content is not a valid document'));
          return;
        }
        this.#snapshots.set(op.id, op.content);
        fx = this.#gateway.snapshot(key, {
          id: op.id,
          reason: op.reason,
          content,
          checkpoint: `sha256:${op.content.hash}`,
          as,
          ...(op.preconditions ? { preconditions: op.preconditions } : {}),
        });
      } else {
        fx = this.#gateway.author(key, {
          id: op.id,
          base: op.base,
          steps: op.steps,
          origin: op.origin,
          as,
          ...(op.preconditions ? { preconditions: op.preconditions } : {}),
        });
      }
      this.#apply(fx);
    });
  }

  #answerRequester(key: string, msg: ToClient): void {
    const r = this.#requests.get(key);
    if (!r) return;
    if (msg.t === 'sync.ack') {
      this.#requests.delete(key);
      r.resolve({ seq: msg.seq });
    } else if (msg.t === 'sync.reject') {
      this.#requests.delete(key);
      this.#auditRejection(r.actor, undefined, null, msg);
      r.reject(new RequestRefused({ code: msg.code, action: msg.action, reason: msg.reason }));
    }
  }

  // --- Permissions (07 §9; 05 §5.5) ------------------------------------------------------------

  /** The control plane changed permission data and read the new state back (BE-026; PRM-019). */
  permissionsChanged(perms: PermissionState): void {
    if (this.#stopped) return;
    this.#resolve(perms.leases.map((l) => l.holder));
    this.#apply(this.#gateway.permissionsChanged(perms));
    this.#scheduleExpiry();
    this.#verifyApprovals();
  }

  /** `Room.expire()` at the room's next expiry, scheduled again after every change (PRM-007). */
  #scheduleExpiry(): void {
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = null;
    if (this.#stopped || this.transient || !this.#deps.settings.expiryTimers) return;
    const next = this.#room.nextExpiry;
    if (next === null) return;
    this.#expiry = setTimeout(
      () => {
        this.#expiry = null;
        this.expire();
      },
      Math.min(Math.max(1, next - this.#deps.now() + 1), 2 ** 31 - 1),
    );
    this.#expiry.unref?.();
  }

  /**
   * A grant or a lease expired: the room enforces it already (access is computed at every check);
   * the channels whose access changed are told without any other event (PRO-033; 07 §4).
   */
  expire(): void {
    if (this.#stopped) return;
    this.#apply(this.#gateway.expire(), { expiry: true });
    this.#scheduleExpiry();
  }

  // --- Content (05 §6.2; G101) -----------------------------------------------------------------

  /**
   * Content at the head for `conn`, from the room, or null when `seq` names another sequence
   * number (the caller rebuilds it from storage). `stored` is the permission state in storage
   * (ADR 0019 change 3).
   */
  contentAt(
    conn: RoomConnection,
    seq: number | undefined,
    stored: PermissionState,
  ): ContentRead | null {
    if (this.#stopped) return null;
    if (stored.revision > this.#room.permissions.revision) this.permissionsChanged(stored);
    if (this.#stopped) return null;
    const head = this.#room.head;
    if (seq !== undefined && seq !== head) return null;
    const hidden = this.#deps.tokens.hidden(conn, this.#gateway.fullHead, this.#room.permissions);
    const doc = hidesNothing(hidden)
      ? this.#room.document.toJSON()
      : this.#gateway.projectionAtHead(hidden).doc.toJSON();
    return {
      seq: head,
      incarnation: this.incarnation,
      cdm: this.record.cdmVersion,
      requires: [...this.#room.requiresList],
      doc: doc as Content['doc'],
      view: this.#deps.tokens.tokenFor(hidden),
    };
  }

  /** Whether `conn` is in a class that hides content in this room now. */
  hidesFor(conn: RoomConnection): boolean {
    return !hidesNothing(
      this.#deps.tokens.hidden(conn, this.#gateway.fullHead, this.#room.permissions),
    );
  }

  // --- Effects ---------------------------------------------------------------------------------

  #apply(
    fx: Effects,
    opts: { answering?: Answering; afterWrite?: boolean; expiry?: boolean } = {},
  ): void {
    // Requesters of server-authored commits are answered here; they are not channels.
    const toChannels: Effects['send'] = [];
    for (const o of fx.send) {
      if (o.channel.startsWith(REQUESTER)) this.#answerRequester(o.channel, o.msg);
      else toChannels.push(o);
    }
    const out = this.#bridge.translate(toChannels, { expiry: opts.expiry ?? false });
    // A stored commit that added or removed a region is followed by perm.changed (D12; G46).
    if (opts.afterWrite) out.push(...this.#bridge.regionsChanged(this.#room.head));
    // SYN-041: held commits on a window; anything else on a channel ends its held message first.
    this.#dispatch(
      this.#window ? this.#window.pass(out, this.#channels.size) : out,
      opts.answering,
    );
    // The checkpoint of the durable state just before a snapshot commit (08 §3).
    if (fx.checkpoints?.length && this.#since.length) void this.#checkpointNow('snapshot');
    if (this.#room.isStopped) {
      this.#finish('fenced');
      return;
    }
    if (fx.write) this.#write(fx.write);
  }

  #dispatch(out: readonly DepOutbound[], answering?: Answering): void {
    for (const o of out) {
      const ch = this.#channels.get(o.channel);
      if (!ch) continue;
      const e = o.event;
      switch (e.t) {
        case 'sync.ack':
        case 'sync.reject': {
          let re: string | undefined;
          let timing: Timing | null = null;
          if (answering && answering.key === o.channel) {
            re = answering.envelope;
            answering.answered = true;
            timing = answering.timing;
          } else if (ch.inflight && ch.inflight.commit === e.d.id) {
            re = ch.inflight.envelope;
            timing = ch.inflight;
          }
          if (ch.inflight && ch.inflight.commit === e.d.id) ch.inflight = null;
          // Every refusal sent to a channel, the room's and the gateway's alike (PRM-051).
          if (e.t === 'sync.reject')
            this.#auditRejection(ch.conn.sub, ch.conn.agent, ch.port.session, e.d);
          if (re === undefined) {
            this.#report(
              new Error(`${e.t} for ${e.d.id} answers no submit on the channel`),
              'dispatch',
              ch.port.session,
            );
            continue;
          }
          this.#observe(e, timing);
          ch.port.send(e, re);
          break;
        }
        case 'ch.closed':
          this.#channels.delete(o.channel);
          this.#presence.leave(o.channel);
          ch.port.closed(e.d, o.cause);
          if (this.#channels.size === 0) this.#armIdle();
          break;
        default:
          ch.port.send(e);
      }
    }
  }

  /** Metrics and the commit's span for an answer (BE-086, BE-087). */
  #observe(e: Extract<DepEvent, { t: 'sync.ack' | 'sync.reject' }>, timing: Timing | null): void {
    const tenant = this.ref.tenant;
    if (e.t === 'sync.ack') {
      if (timing) this.#deps.metrics.ackLatency.observe({ tenant }, performance.now() - timing.at);
      timing?.span.end({ outcome: 'ack', seq: e.d.seq, rebased: e.d.rebased });
      return;
    }
    this.#deps.metrics.rejections.inc({ tenant, code: e.d.code });
    timing?.span.end({ outcome: 'reject', code: e.d.code });
  }

  /**
   * The audit entry of a refusal (07 §14; PRM-051 criteria 1 and 2): who tried what, never what
   * they typed. This is the one place entries are made. Every `sync.reject` passes through it: the
   * room's and the projection gateway's on a channel (`#dispatch`), and those sent to the requester
   * of a server-authored commit (`#answerRequester`). `rejectionAudit` decides which codes are
   * audited and builds the entry; the reason string is left out, since it can echo client input.
   */
  #auditRejection(
    actor: string,
    agent: string | undefined,
    session: string | null,
    d: { id: string; code: string; action: string; head: number; scopes?: readonly string[] },
  ): void {
    let entry: ReturnType<typeof rejectionAudit>;
    try {
      entry = rejectionAudit({
        code: d.code,
        actor: actor.length > 0 ? actor : 'unknown',
        agent,
        document: this.ref.doc,
        scopes: d.scopes,
        commit: d.id,
        head: d.head,
        time: this.#deps.now(),
      });
    } catch (err) {
      // An entry that cannot be built is reported, never stored half-formed; the refusal still goes.
      this.#report(err, 'audit');
      return;
    }
    if (!entry) return;
    this.#deps.audit.record({
      tenant: this.ref.tenant,
      doc: this.ref.doc,
      actor: entry.actor,
      kind: entry.kind,
      data: {
        code: entry.code,
        action: d.action,
        commit: entry.commit,
        scopes: entry.scopes,
        head: entry.head,
        ...(session !== null ? { session } : {}),
        ...(entry.agent !== undefined ? { agent: entry.agent } : {}),
      },
      at: entry.time,
    });
    // PRM-053 criterion 3: the refusal is raised as `dep.commit.rejected`. The sink throttles it.
    this.#deps.events?.emit({
      type: 'dep.commit.rejected.v1',
      tenant: this.ref.tenant,
      subject: this.ref.doc,
      data: { seq: d.head, code: entry.code },
      time: entry.time,
    });
  }

  // --- Writes (06 §2.3; 04 §5 steps 9 and 10) --------------------------------------------------

  #write(req: WriteRequest): void {
    if (this.#writing) {
      // The room never asks for a second write while one is in flight; refuse to make one.
      this.#report(new Error('a second write while one is in flight'), 'write');
      return;
    }
    this.#writing = req;
    // After a failed write the room asks again at once (its control commit, for one): back off,
    // so that a store that fails at once cannot keep the room in a tight loop (ADR 0035).
    const delay = this.#failures === 0 ? 0 : Math.min(5000, 25 * 2 ** (this.#failures - 1));
    if (delay === 0) return this.#perform(req);
    this.#delayed = setTimeout(() => {
      this.#delayed = null;
      if (this.#stopped) {
        this.#writing = null;
        this.#settleWrite();
        return;
      }
      this.#perform(req);
    }, delay);
    this.#delayed.unref?.();
  }

  #perform(req: WriteRequest): void {
    this.stats.writes++;
    const n = req.snapshot ? 1 : req.commits.length;
    this.stats.largestBatch = Math.max(this.stats.largestBatch, n);
    const started = performance.now();
    let p: Promise<WriteResult>;
    try {
      p = this.#store(req);
    } catch (e) {
      p = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    p.then(
      (result) => {
        const tenant = this.ref.tenant;
        this.#deps.metrics.persistLatency.observe({ tenant }, performance.now() - started);
        if (result.status === 'ok') this.#deps.metrics.persistBatch.observe({ tenant }, n);
        else this.#deps.metrics.writeFailures.inc({ tenant, status: result.status });
        this.#written(req, result);
      },
      (e: unknown) => this.#lost(e),
    );
  }

  /** The write itself: faults first (BE-079), then a snapshot's checkpoint (ADR 0034 §3). */
  async #store(req: WriteRequest): Promise<WriteResult> {
    const faults = this.#deps.faults;
    if (faults.databaseDown) return { status: 'failed' };
    const fail = faults.takeFailNext(this.ref);
    const options: AppendOptions = {};
    if (req.snapshot) {
      const content = this.#snapshots.get(req.snapshot.id);
      if (!content) return { status: 'failed' };
      // The checkpoint the commit references is written before the commit, so that a content read
      // that starts from the newest checkpoint never replays across the snapshot. Its index row
      // is written with the commit; until then the object is not trusted.
      this.#tainted = req.snapshot.seq;
      let key: string;
      try {
        key = (await this.#deps.checkpointer.save(this.ref, req.snapshot.seq, content, false)).key;
      } catch (e) {
        this.#report(e, `checkpoint of snapshot ${req.snapshot.seq}`);
        this.#deps.metrics.checkpointFailures.inc({ tenant: this.ref.tenant });
        return { status: 'failed' };
      }
      options.snapshot = {
        envelope: content.envelope,
        encoded: content.encoded,
        hash: content.hash,
        ...(this.#deps.checkpointer.indexed ? { checkpointKey: key } : {}),
      };
    }
    // The store carries out the fault at its own insert points (AppendOptions.fault).
    if (fail) options.fault = fail;
    return this.#deps.logs.append(this.ref, req, options);
  }

  /**
   * BE-055 criterion 2: a stored commit raises `dep.document.changed.v1` with the sequence number and
   * the hash-chain head the log holds (05 §7; PRO-069 criterion 3). The sink debounces it, at most one
   * per document per window. The head is read from the log after the write, so `seq` and `chainHead`
   * come from the same state. A log without a head state, or a document with no chain head, raises
   * nothing: the envelope refuses the event without a head.
   */
  #raiseChanged(): void {
    const sink = this.#deps.events;
    const state = this.#deps.logs.state?.bind(this.#deps.logs);
    if (!sink || !state) return;
    void state(this.ref).then(
      (head) => {
        if (head.chainHead === null) return;
        sink.emit({
          type: 'dep.document.changed.v1',
          tenant: this.ref.tenant,
          subject: this.ref.doc,
          data: { seq: head.seq, chainHead: head.chainHead },
          time: this.#deps.now(),
        });
      },
      (e: unknown) => this.#report(e, 'change event'),
    );
  }

  #written(req: WriteRequest, result: WriteResult): void {
    this.#writing = null;
    this.#settleWrite();
    if (result.status === 'ok') this.#raiseChanged();
    if (req.snapshot && result.status !== 'ok' && result.status !== 'unknown')
      this.#snapshots.delete(req.snapshot.id);
    if (this.#stopped) return;
    this.#failures = result.status === 'failed' ? this.#failures + 1 : 0;
    let stored: LogCommit[] = [];
    if (result.status === 'ok') stored = req.snapshot ? [req.snapshot] : req.commits;
    else if (result.status === 'unknown') stored = result.tail;
    for (const c of stored) this.#stored.set(c.id, { seq: c.seq, user: c.user });
    if (result.status === 'ok') {
      this.stats.committed += stored.length;
      const tenant = this.ref.tenant;
      this.#deps.metrics.commits.inc({ tenant }, stored.length);
      const rebased = stored.filter((c) => c.rebased === true).length;
      if (rebased) this.#deps.metrics.rebased.inc({ tenant }, rebased);
    }
    let fx: Effects;
    try {
      fx = this.#gateway.writeCompleted(result);
    } catch (e) {
      this.#halt(e);
      return;
    }
    // Only what the room took as stored advances the checkpoint's state.
    const head = this.#room.head;
    this.#afterStored(stored.filter((c) => c.seq <= head));
    if (req.snapshot) this.#snapshots.delete(req.snapshot.id);
    this.#apply(fx, { afterWrite: true });
    if (result.status === 'revision_moved') this.#scheduleExpiry();
    if (result.status === 'revision_moved' || (result.status === 'ok' && req.snapshot))
      this.#verifyApprovals();
  }

  /**
   * The write's outcome could not be established, not even by reading the log back
   * (`OutcomeUnknownError`): the room cannot know its own state, so it stops serving and its
   * channels close with `unavailable` (BE-025). The room is told `lost`.
   */
  #lost(e: unknown): void {
    this.#writing = null;
    this.#settleWrite();
    if (this.#stopped) return;
    this.#report(e, `write to ${this.ref.doc}`);
    try {
      this.#apply(this.#gateway.writeCompleted({ status: 'lost' }));
    } catch (e2) {
      this.#halt(e2);
      return;
    }
    if (!this.#stopped) this.#halt(new Error('the room kept serving after a lost write'));
  }

  /** The room itself failed: its channels close and nothing more is asked of it. */
  #halt(e: unknown): void {
    if (this.#stopped) return;
    this.#report(e, `room ${this.ref.doc}`);
    const d: ChannelClosed = { code: 'unavailable', reason: closeReasonText('stopped') };
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    this.#finish('stopped');
    for (const ch of channels) ch.port.closed(d, 'stopped');
  }

  #settleWrite(): void {
    const waiting = this.#writeDone;
    this.#writeDone = [];
    for (const w of waiting) w();
  }

  /** Resolves when no write is in flight. */
  #idleWrites(): Promise<void> {
    if (!this.#writing) return Promise.resolve();
    return new Promise((resolve) => this.#writeDone.push(resolve));
  }

  /**
   * Resolves when nothing is waiting to be written, or at `deadline` (performance.now()). While
   * writes keep failing there is nothing to wait for: the store is down (06 §8).
   */
  async #quiet(deadline: number): Promise<boolean> {
    while (this.#writing || this.#room.pendingCount > 0) {
      if (this.#stopped || this.#failures > 0 || performance.now() > deadline) return false;
      if (this.#writing)
        await Promise.race([
          this.#idleWrites(),
          new Promise((r) => setTimeout(r, Math.max(1, deadline - performance.now()))),
        ]);
      else await new Promise((r) => setTimeout(r, 5));
    }
    return !this.#stopped;
  }

  // --- Checkpoints (06 §2.2 step 3; BE-020; SYN-043) -------------------------------------------

  /** Stored commits advance the state the next checkpoint replays (snapshots restart it). */
  #afterStored(commits: readonly LogCommit[]): void {
    if (!commits.length) return;
    this.#noteHead();
    for (const c of commits) {
      if (isSnapshot(c)) {
        // The snapshot's checkpoint was written before the commit and is now indexed.
        const content = this.#snapshots.get(c.id);
        if (this.#tainted === c.seq) this.#tainted = null;
        this.#base = content
          ? { seq: c.seq, base: { encoded: content.encoded }, bytes: content.bytes }
          : { seq: c.seq, base: { doc: this.#room.document.toJSON() }, bytes: this.#base.bytes };
        this.#baseGen++;
        this.#since = [];
        this.#sinceBytes = 0;
        this.#firstSinceAt = null;
        this.#lastCheckpointAt = this.#deps.now();
        this.stats.checkpoints++;
        continue;
      }
      this.#push(stepsOf(c));
      this.#firstSinceAt ??= this.#deps.now();
    }
    // A checkpoint object written for a snapshot that was not stored is replaced by the content
    // actually stored at its `seq`, as soon as that is known.
    if (this.#tainted !== null && this.#room.head >= this.#tainted) {
      void this.#checkpointNow('repair', this.#tainted);
      this.#tainted = null;
    }
    this.#scheduleCheckpoint();
  }

  /** Writes a checkpoint now when the rule of 06 §2.2 says so, or arms the timer for it. */
  #scheduleCheckpoint(): void {
    if (this.#checkpointTimer) clearTimeout(this.#checkpointTimer);
    this.#checkpointTimer = null;
    if (this.#stopped || this.transient || !this.#deps.checkpointer.enabled) return;
    const n = this.#since.length;
    if (n === 0 || this.#firstSinceAt === null) return;
    const c = this.#deps.settings.checkpoint;
    const now = this.#deps.now();
    const dueAt = n >= c.everyCommits ? now : this.#firstSinceAt + c.everyMs;
    const at = Math.max(dueAt, this.#lastCheckpointAt + c.minIntervalMs);
    if (at <= now) {
      void this.#checkpointNow('policy');
      return;
    }
    this.#checkpointTimer = setTimeout(
      () => {
        this.#checkpointTimer = null;
        this.#scheduleCheckpoint();
      },
      Math.min(at - now, 2 ** 31 - 1),
    );
    this.#checkpointTimer.unref?.();
  }

  /**
   * Writes a checkpoint of the durable state at `seq` (default: the durable head), from the last
   * checkpoint and the steps stored since, in a worker. Resolves whether it was written; a failure
   * is counted and retried later, and the room keeps serving (BE-020 criterion 6).
   */
  #checkpointNow(reason: string, seq?: number): Promise<boolean> {
    if (this.#checkpointing) {
      this.#checkpointAgain = true;
      return this.#checkpointing;
    }
    if (!this.#deps.checkpointer.enabled) return Promise.resolve(false);
    const n = seq === undefined ? this.#since.length : seq - this.#base.seq;
    if (n <= 0 || n > this.#since.length) return Promise.resolve(n === 0);
    const at = this.#base.seq + n;
    const gen = this.#baseGen;
    const input = {
      base: this.#base.base,
      cdm: this.record.cdmVersion,
      requires: [...this.#room.requiresList],
      commits: this.#since.slice(0, n),
    };
    const tenant = this.ref.tenant;
    const span = this.#deps.tracer.start('dep.checkpoint', this.#lastTrace, {
      tenant,
      doc: this.ref.doc,
      seq: at,
      reason,
    });
    const started = performance.now();
    this.#checkpointing = (async () => {
      try {
        const e = await this.#deps.checkpointer.replay(input);
        await this.#deps.checkpointer.save(this.ref, at, e);
        this.stats.checkpoints++;
        this.#checkpointFailures = 0;
        this.#deps.metrics.checkpoints.inc({ tenant, reason });
        this.#deps.metrics.checkpointLatency.observe({ tenant }, performance.now() - started);
        if (gen === this.#baseGen && at === this.#base.seq + n) {
          this.#base = { seq: at, base: { encoded: e.encoded }, bytes: e.bytes };
          this.#baseGen++;
          this.#since = this.#since.slice(n);
          this.#sinceBytes = this.#since.reduce(
            (a, s) => a + (s.length ? JSON.stringify(s).length : 0),
            0,
          );
          this.#firstSinceAt = this.#since.length ? this.#deps.now() : null;
          this.#lastCheckpointAt = this.#deps.now();
        }
        this.#sendCheck(at, e.hash);
        span.end({ outcome: 'ok', bytes: e.encoded.byteLength });
        return true;
      } catch (err) {
        this.#checkpointFailures++;
        this.#deps.metrics.checkpointFailures.inc({ tenant });
        this.#report(err, `checkpoint of ${this.ref.doc}`);
        span.end({ outcome: 'failed' });
        // Object storage may be down (06 §8): try again later; the log alone keeps every commit.
        if (!this.#stopped && !this.transient && !this.#checkpointTimer) {
          const wait = Math.min(300_000, 1000 * 2 ** Math.min(8, this.#checkpointFailures));
          this.#checkpointTimer = setTimeout(() => {
            this.#checkpointTimer = null;
            void this.#checkpointNow('retry');
          }, wait);
          this.#checkpointTimer.unref?.();
        }
        return false;
      } finally {
        this.#checkpointing = null;
        if (this.#checkpointAgain) {
          this.#checkpointAgain = false;
          this.#scheduleCheckpoint();
        }
      }
    })();
    return this.#checkpointing;
  }

  /**
   * `sync.check` to every channel that sees the full document (04 §13; SYN-043). A reader whose
   * class hides content holds a projection, whose hash the server does not compute (ADR 0053).
   */
  #sendCheck(seq: number, hash: string): void {
    if (!this.#deps.settings.syncCheck || this.#stopped) return;
    const full = this.#deps.tokens.fullGatewayToken;
    for (const ch of this.#channels.values()) {
      if (ch.gatewayView !== full) continue;
      ch.port.check({ seq, hash });
      this.stats.checks++;
    }
  }

  /** Writes a checkpoint now if commits were stored since the last (for closes and drains). */
  async checkpointIfDirty(reason: string): Promise<boolean> {
    if (this.#checkpointing) await this.#checkpointing;
    if (!this.#since.length) return true;
    return this.#checkpointNow(reason);
  }

  // --- Lifecycle (06 §2.2) ---------------------------------------------------------------------

  #armIdle(): void {
    if (this.#stopped || this.transient || this.#channels.size > 0) return;
    this.#cancelIdle();
    this.idleSince = this.#deps.now();
    this.#idle = setTimeout(() => {
      this.#idle = null;
      void this.closeIdle();
    }, this.#deps.settings.roomIdleMs);
    this.#idle.unref?.();
  }

  #cancelIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
  }

  get idle(): boolean {
    return !this.#stopped && this.#channels.size === 0;
  }

  /**
   * Closes the room if it has no channel (06 §2.2 step 4; BE-021): it checkpoints if it has
   * changes, releases ownership and frees its memory. A channel that opens meanwhile keeps it open.
   */
  async closeIdle(reason = 'idle'): Promise<boolean> {
    if (this.#stopped || this.#channels.size > 0 || this.#closingIdle) return false;
    // Writes still queued (a control commit) finish first.
    if (this.#writing || this.#room.pendingCount > 0) {
      this.#armIdle();
      return false;
    }
    this.#cancelIdle();
    this.#closingIdle = true;
    try {
      await this.checkpointIfDirty('close');
    } finally {
      this.#closingIdle = false;
    }
    if (this.#stopped || this.#channels.size > 0) return false;
    if (this.#writing || this.#room.pendingCount > 0) {
      this.#armIdle();
      return false;
    }
    this.#deps.metrics.roomsClosed.inc({ tenant: this.ref.tenant, reason });
    this.#finish(reason);
    await this.#release();
    return true;
  }

  async #release(): Promise<void> {
    try {
      await this.#deps.ownership.release(this.ref, this.#deps.node, this.epoch);
    } catch (e) {
      this.#report(e, `release ${this.ref.doc}`);
    }
  }

  #finish(reason: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#deps.metrics.roomOpenSeconds.inc(
      { tenant: this.ref.tenant },
      (this.#deps.now() - this.#openedAt) / 1000,
    );
    this.#cancelIdle();
    this.#window?.stop();
    for (const t of [this.#expiry, this.#checkpointTimer]) if (t) clearTimeout(t);
    this.#expiry = this.#checkpointTimer = null;
    if (this.#delayed) {
      // A write waiting for its backoff is never made.
      clearTimeout(this.#delayed);
      this.#delayed = null;
      this.#writing = null;
      this.#settleWrite();
    }
    this.#presence.close();
    for (const [k, r] of this.#requests) {
      this.#requests.delete(k);
      r.reject(new DataPlaneError('unavailable', 'the room stopped serving the document'));
    }
    this.#onStop(this, reason);
  }

  /**
   * Drains the room (06 §2.2 step 5; BE-022): no new commit is accepted (each is answered with
   * `unavailable` and `retry`), commits in flight or waiting are written and answered, and the room
   * is checkpointed if it changed. Resolves when it is done or `timeoutMs` has passed.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.#draining = true;
    const deadline = performance.now() + timeoutMs;
    const quiet = await this.#quiet(deadline);
    // Held broadcasts go out before the connections are told to go away (SYN-041); from now on
    // nothing is held, so a write that ends later is sent at once.
    if (this.#window) {
      this.#dispatch(this.#window.flush());
      this.#window.stop();
    }
    if (quiet) await this.checkpointIfDirty('drain');
  }

  /**
   * Stops the room for good: every channel closes with `unavailable` and `reason`; with
   * `checkpoint`, a room with changes is checkpointed first; with `release`, ownership is released
   * once the write in flight has ended (06 §2.2 steps 4, 5).
   */
  async shutdown(
    reason: string,
    release: boolean,
    opts: { checkpoint?: boolean; timeoutMs?: number } = {},
  ): Promise<void> {
    if (!this.#stopped && opts.checkpoint && !this.transient) {
      const deadline = performance.now() + (opts.timeoutMs ?? this.#deps.settings.drainTimeoutMs);
      if (await this.#quiet(deadline)) await this.checkpointIfDirty('close');
    }
    if (!this.#stopped) {
      // The room writes nothing more (Room.stop); every channel hears the host's reason.
      try {
        this.#apply(this.#gateway.stop());
      } catch (e) {
        this.#report(e, `stop ${this.ref.doc}`);
      }
      const d: ChannelClosed = { code: 'unavailable', reason };
      // Stored commits still held on the window go before the close (SYN-041).
      if (this.#window) this.#dispatch(this.#window.flush());
      const channels = [...this.#channels.values()];
      this.#channels.clear();
      this.#finish('stopped');
      for (const ch of channels) ch.port.closed(d, 'stopped');
    }
    await this.#idleWrites();
    if (release) await this.#release();
  }

  /**
   * Stops serving at once, without a checkpoint and without releasing ownership: the node lost
   * its lease (BE-018), or a test hook killed the room as a crash would (BE-079).
   */
  fence(reason: string): void {
    if (this.#stopped) return;
    try {
      this.#gateway.stop();
    } catch (e) {
      this.#report(e, `fence ${this.ref.doc}`);
    }
    const d: ChannelClosed = { code: 'unavailable', reason, retryInMs: 1000 };
    // The held commits are stored ones: they go before the close (SYN-041).
    if (this.#window) this.#dispatch(this.#window.flush());
    const channels = [...this.#channels.values()];
    this.#channels.clear();
    this.#deps.metrics.roomsClosed.inc({ tenant: this.ref.tenant, reason: 'fenced' });
    this.#finish('fenced');
    for (const ch of channels) ch.port.closed(d, 'stopped');
  }
}

/** A server-authored operation as the outbox stores it, decoded (BE-039). */
export interface Delivered {
  seq: number;
}

/** The rooms of this node, one per open document. */
export class RoomHost {
  readonly #deps: HostDeps;
  readonly #rooms = new Map<string, HostedRoom>();
  readonly #loading = new Map<string, Promise<HostedRoom>>();
  /** Transient authorities at work, by document (BE-023): a room waits for them before it opens. */
  readonly #transients = new Map<string, Promise<unknown>>();
  #closed = false;
  #draining = false;
  #budgetTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: HostDeps) {
    this.#deps = deps;
    const m = deps.metrics;
    m.gauge('dep_open_rooms', 'Rooms open on the node', () => {
      const by = new Map<string, number>();
      for (const r of this.#rooms.values()) by.set(r.ref.tenant, (by.get(r.ref.tenant) ?? 0) + 1);
      return [...by].map(([tenant, value]) => ({ labels: { tenant }, value }));
    });
    m.gauge('dep_room_memory_bytes', 'Estimated memory of the open rooms, bytes', () => {
      const by = new Map<string, number>();
      for (const r of this.#rooms.values())
        by.set(r.ref.tenant, (by.get(r.ref.tenant) ?? 0) + r.estimatedBytes);
      return [...by].map(([tenant, value]) => ({ labels: { tenant }, value }));
    });
    m.gauge('dep_room_memory_max_bytes', 'Estimated memory of the largest open room, bytes', () => {
      const by = new Map<string, number>();
      for (const r of this.#rooms.values())
        by.set(r.ref.tenant, Math.max(by.get(r.ref.tenant) ?? 0, r.estimatedBytes));
      return [...by].map(([tenant, value]) => ({ labels: { tenant }, value }));
    });
    if (deps.settings.roomMemoryBudget > 0) {
      this.#budgetTimer = setInterval(() => void this.enforceBudget(), 10_000);
      this.#budgetTimer.unref?.();
    }
  }

  /** The open room of a document, if this node has one. */
  get(ref: DocRef): HostedRoom | undefined {
    const r = this.#rooms.get(refKey(ref));
    return r && !r.stopped ? r : undefined;
  }

  get rooms(): HostedRoom[] {
    return [...this.#rooms.values()];
  }

  get draining(): boolean {
    return this.#draining || this.#closed;
  }

  /** Estimated memory of all open rooms (BE-021). */
  get estimatedBytes(): number {
    let n = 0;
    for (const r of this.#rooms.values()) n += r.estimatedBytes;
    return n;
  }

  /** The room of a document, opened from storage on the first channel (BE-019). */
  acquire(ref: DocRef): Promise<HostedRoom> {
    if (this.#closed || this.#draining)
      return Promise.reject(new Refusal('unavailable', 'the service is stopping'));
    if (this.#deps.lease && !this.#deps.lease.proven)
      return Promise.reject(new Refusal('unavailable', 'the node cannot prove its lease'));
    if (this.#deps.faults.databaseDown)
      return Promise.reject(new Refusal('unavailable', 'the database is unreachable'));
    const known = this.get(ref);
    if (known) return Promise.resolve(known);
    const k = refKey(ref);
    let p = this.#loading.get(k);
    if (!p) {
      const transient = this.#transients.get(k);
      p = (
        transient
          ? transient.catch(() => undefined).then(() => this.#acquireAfter(ref))
          : this.#load(ref, false)
      ).finally(() => this.#loading.delete(k));
      this.#loading.set(k, p);
    }
    return p;
  }

  #acquireAfter(ref: DocRef): Promise<HostedRoom> {
    const known = this.get(ref);
    return known ? Promise.resolve(known) : this.#load(ref, false);
  }

  /** Claims the document: unconditionally, or with node leases only when it is free (BE-018). */
  async #claim(ref: DocRef): Promise<number> {
    const d = this.#deps;
    if (!d.leases) return d.ownership.claim(ref, d.node);
    if (d.ownership.claimIfFree) {
      const epoch = await d.ownership.claimIfFree(ref, d.node);
      if (epoch === null)
        throw new Refusal('unavailable', 'another node holds the document; try again shortly');
      return epoch;
    }
    // A store without an atomic conditional claim: check the owner's lease, then claim.
    const head = await d.logs.head(ref);
    if (head.owner !== null && head.owner !== d.node && (await d.leases.alive(head.owner)))
      throw new Refusal('unavailable', 'another node holds the document; try again shortly');
    return d.ownership.claim(ref, d.node);
  }

  async #load(ref: DocRef, transient: boolean): Promise<HostedRoom> {
    const d = this.#deps;
    const started = performance.now();
    try {
      const record = await d.documents.get(ref);
      if (!record || record.deletedAt !== null) throw new Refusal('not_found', 'no such document');
      if (!d.checkpoints) throw new Refusal('unavailable', 'no checkpoint store is configured');
      // Claim first: it fences any earlier owner, so the log read next is complete (06 §2.1).
      const epoch = await this.#claim(ref);
      const head = await d.logs.head(ref);
      const cp = await d.checkpointer.load(ref, head.seq);
      if (!cp) throw new Refusal('unavailable', 'the document has no content to start from');
      const [log, perms, history, atBase] = await Promise.all([
        d.logs.read(ref, cp.seq + 1),
        d.grants.current(ref),
        cp.seq === 0 ? d.grants.history(ref) : Promise.resolve([]),
        cp.seq > 0 ? d.logs.read(ref, cp.seq, cp.seq) : Promise.resolve([]),
      ]);
      if (log.length !== head.seq - cp.seq)
        throw new Error(
          `the log of ${ref.doc} holds ${log.length} commits after ${cp.seq}, its head is ${head.seq}`,
        );
      const initial = schemaOf().nodeFromJSON(cp.envelope.doc);
      initial.check();
      const snapshots = new Map<number, { doc: Doc; json: JsonEnvelope }>();
      for (const c of log)
        if (isSnapshot(c)) {
          const json = d.logs.snapshotContent ? await d.logs.snapshotContent(ref, c.seq) : null;
          if (!json) throw new Error(`the content of snapshot commit ${c.seq} is missing`);
          const doc = schemaOf().nodeFromJSON(json.doc);
          snapshots.set(c.seq, { doc, json });
        }
      // The revision in force at the checkpoint: that of the commit stored at its `seq` (every
      // commit records the revision it was checked against); at 0 the one the document was created
      // with (D67), or, while the log is still empty, the newest one stored (D125): permission data
      // set up before the first commit needs no control commit, since no commit was checked against
      // the older revision.
      const initialRevision =
        cp.seq > 0
          ? (atBase[0]?.revision ?? perms.revision)
          : head.seq === 0
            ? perms.revision
            : (history[0]?.revision ?? perms.revision);
      // What the wire shows for the authors and lease holders the room starts with (D42).
      const named = [...log.map((c) => c.user), ...perms.leases.map((l) => l.holder)];
      const unique = [...new Set(named)].filter((u) => u !== 'system');
      const subs: ReadonlyMap<string, string> =
        d.users && unique.length ? await d.users.subsOf(ref.tenant, unique) : new Map();
      const room = new HostedRoom({
        ref,
        record,
        epoch,
        incarnation: head.incarnation,
        initial,
        initialSeq: cp.seq,
        base: cp.base,
        baseBytes: baseBytesOf(cp),
        log,
        snapshots,
        perms,
        initialRevision,
        subs,
        deps: d,
        transient,
        onStop: (r) => {
          if (this.#rooms.get(refKey(ref)) === r) this.#rooms.delete(refKey(ref));
        },
      });
      if (!transient)
        d.metrics.coldOpen.observe({ tenant: ref.tenant }, performance.now() - started);
      if (transient) return room;
      if (this.#closed || this.#draining) {
        await room.shutdown('the service is stopping', true);
        throw new Refusal('unavailable', 'the service is stopping');
      }
      this.#rooms.set(refKey(ref), room);
      void this.enforceBudget();
      return room;
    } catch (e) {
      if (e instanceof Refusal) throw e;
      if (e instanceof DocumentNotFoundError) throw new Refusal('not_found', 'no such document');
      d.settings.onError(e, `open ${ref.doc}`, { tenant: ref.tenant, doc: ref.doc });
      throw new Refusal('unavailable', 'the document could not be opened');
    }
  }

  /**
   * Closes idle rooms, longest idle first, while the estimate is above the budget (BE-021). A
   * room with a channel is never closed for memory. A room that has just been loaded has no
   * channel yet and no `idleSince` (it is set only when a room's last channel leaves), so it is not
   * a candidate: the acquirer attaches its channel after the load returns.
   */
  async enforceBudget(): Promise<number> {
    const budget = this.#deps.settings.roomMemoryBudget;
    if (budget <= 0) return 0;
    let closed = 0;
    const idle = this.rooms
      .filter((r) => r.idle && !r.transient && r.idleSince !== null)
      .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0));
    for (const r of idle) {
      if (this.estimatedBytes <= budget) break;
      if (await r.closeIdle('memory')) closed++;
    }
    return closed;
  }

  permissionsChanged(ref: DocRef, perms: PermissionState): void {
    // A dropped announcement (BE-079): the persist transaction still refuses stale commits.
    if (this.#deps.faults.takeDrop(ref)) return;
    this.get(ref)?.permissionsChanged(perms);
  }

  /**
   * The document was locked, archived, unlocked or deleted outside the room: a deleted document's
   * room closes its channels; otherwise the room takes the permission state in storage, which
   * carries the document state (07 §9; BE-035).
   */
  async documentChanged(ref: DocRef): Promise<void> {
    const room = this.get(ref);
    if (!room) return;
    try {
      const record = await this.#deps.documents.get(ref);
      if (!record || record.deletedAt !== null) {
        await room.shutdown('the document was deleted', true);
        return;
      }
      const perms = await this.#deps.grants.current(ref);
      if (perms.revision > room.permissions.revision) room.permissionsChanged(perms);
      // The document resource changed (metadata or state): open channels may re-read it (05 §5.6).
      room.notify({ type: 'document.updated', resource: `/documents/${ref.doc}` });
    } catch (e) {
      this.#deps.settings.onError(e, `refresh ${ref.doc}`, { tenant: ref.tenant, doc: ref.doc });
    }
  }

  /** A notification for the open channels of a document (05 §5.6; PRO-035). */
  notify(ref: DocRef, n: Notification, user?: string): void {
    this.get(ref)?.notify(n, user);
  }

  // --- Server-authored operations (04 §10; SYN-031; BE-023, BE-037, BE-039) ---------------------

  /**
   * Applies a server-authored operation: in the open room of the document, or, when none is open
   * on this node, in a transient authority that loads the newest checkpoint and the log tail,
   * applies the commit through the same room, stores it, and exits with no channel, no timer and
   * no reference left (06 §2.2, last paragraph). A channel that opens meanwhile waits for it.
   */
  async apply(ref: DocRef, op: ServerOp): Promise<Delivered> {
    if (this.#deps.faults.databaseDown)
      throw new DataPlaneError('unavailable', 'the database is unreachable', 1000);
    // 04 §5 step 2 looks the identifier up "then in the log", not only in the commits the room
    // holds: a room loaded from a checkpoint at or after the commit (a snapshot is always its own
    // checkpoint) would otherwise refuse a redelivered commit on its preconditions (BE-039).
    let storedCommit: LogCommit | null = null;
    try {
      storedCommit = (await this.#deps.logs.byId?.(ref, op.id)) ?? null;
    } catch {
      throw new DataPlaneError('unavailable', 'the log could not be read', 1000);
    }
    const open =
      this.get(ref) ?? (this.#loading.has(refKey(ref)) ? await this.acquire(ref) : undefined);
    if (open) {
      if (storedCommit) open.rememberStored(storedCommit);
      return open.request(op);
    }
    const k = refKey(ref);
    const prior = this.#transients.get(k);
    const run = (async () => {
      await prior?.catch(() => undefined);
      const again = this.get(ref);
      if (again) {
        if (storedCommit) again.rememberStored(storedCommit);
        return again.request(op);
      }
      if (this.#closed) throw new DataPlaneError('unavailable', 'the service is stopping', 1000);
      let room: HostedRoom;
      try {
        room = await this.#load(ref, true);
      } catch (e) {
        if (e instanceof Refusal)
          throw new DataPlaneError(
            e.code === 'not_found' ? 'not_found' : 'unavailable',
            e.message,
            1000,
          );
        throw e;
      }
      try {
        if (storedCommit) room.rememberStored(storedCommit);
        return await room.request(op);
      } finally {
        await room.shutdown('transient', true);
      }
    })();
    this.#transients.set(k, run);
    try {
      return await run;
    } finally {
      if (this.#transients.get(k) === run) this.#transients.delete(k);
    }
  }

  /** Encodes content in a worker (SYN-039): canonical text, Zstandard, SHA-256. */
  encode(envelope: JsonEnvelope): Promise<Encoded> {
    return this.#deps.checkpointer.encode(envelope);
  }

  /** Transient authorities at work, for tests (SYN-031 criterion 2). */
  get transientCount(): number {
    return this.#transients.size;
  }

  // --- Reads (05 §6.2; BE-036, BE-038; HIS-024) -------------------------------------------------

  /** The document's head content and the log up to `upTo`, rebuilt in a worker (SYN-039). */
  async #materialise(
    ref: DocRef,
    upTo: number,
  ): Promise<{ doc: JsonNode; cp: LoadedCheckpoint; log: LogCommit[] }> {
    const d = this.#deps;
    const cp = await d.checkpointer.load(ref, upTo);
    if (!cp) throw new DataPlaneError('unavailable', 'the document has no content to start from');
    const log = cp.seq < upTo ? await d.logs.read(ref, cp.seq + 1, upTo) : [];
    if (log.length !== upTo - cp.seq) throw new DataPlaneError('unavailable', 'the log has a gap');
    // Start again from the last snapshot commit in the range, whose content the log holds.
    let base: Base = cp.base;
    let from = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      const c = log[i]!;
      if (!isSnapshot(c)) continue;
      const json = d.logs.snapshotContent ? await d.logs.snapshotContent(ref, c.seq) : null;
      if (!json) throw new DataPlaneError('unavailable', 'a snapshot commit has no content');
      base = { doc: json.doc };
      from = i + 1;
      break;
    }
    const commits = log.slice(from).map(stepsOf);
    const doc = commits.length
      ? (
          await d.workers.run('materialise', {
            base,
            cdm: cp.envelope.cdm,
            requires: cp.envelope.requires,
            commits,
          })
        ).doc
      : 'doc' in base
        ? (base.doc as JsonNode)
        : ((await d.workers.run('decode', { encoded: base.encoded })).envelope.doc as JsonNode);
    return { doc, cp, log };
  }

  /**
   * Content at `seq` (default: the head) as `identity` may see it (05 §6.2; G101): projected for
   * the reader's class under the permission state in storage, with the keyed view token, and only
   * at a state the visibility gate lets the reader see (HIS-024).
   */
  async readContent(identity: VerifiedIdentity, doc: string, seq?: number): Promise<ContentRead> {
    const role = identity.docs[doc];
    if (!role) throw new DataPlaneError('forbidden', 'the token gives no role in this document');
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 0))
      throw new DataPlaneError('validation_failed', 'seq must be a sequence number');
    const ref: DocRef = { tenant: identity.tenant, doc };
    const conn = connectionOf(identity, role);
    const d = this.#deps;
    try {
      if (d.faults.databaseDown)
        throw new DataPlaneError('unavailable', 'the database is unreachable');
      const stored = await d.grants.current(ref);
      const room = this.get(ref);
      if (room) {
        const head = room.head;
        if (
          seq !== undefined &&
          seq !== head &&
          !stateAllowed(room.minVisibleSeq(conn), seq, head) &&
          seq < room.recentHead(d.settings.limits.ackTimeoutMs)
        )
          throw new DataPlaneError('forbidden', 'the history before your access is not visible');
        const fromRoom = room.contentAt(conn, seq, stored);
        if (fromRoom) return fromRoom;
      }
      const record = await d.documents.get(ref);
      if (!record || record.deletedAt !== null)
        throw new DataPlaneError('not_found', 'no such document');
      const head = await d.logs.head(ref);
      const at = seq ?? head.seq;
      if (at > head.seq) throw new DataPlaneError('not_found', `no content at seq ${at}`);
      const atHead = await this.#materialise(ref, head.seq);
      const setting = historySetting(record.historyVisibility);
      const headDoc = schemaOf().nodeFromJSON(atHead.doc);
      if (at !== head.seq) {
        const gate = gateOf(conn, {
          setting,
          head: headDoc,
          headSeq: head.seq,
          perms: stored,
          log: atHead.log,
          now: d.now(),
        });
        if (
          !stateAllowed(gate, at, head.seq) &&
          at < recentHeadOf(atHead, d.now() - d.settings.limits.ackTimeoutMs)
        )
          throw new DataPlaneError('forbidden', 'the history before your access is not visible');
      }
      const full = at === head.seq ? atHead.doc : (await this.#materialise(ref, at)).doc;
      const hidden = d.tokens.hidden(conn, headDoc, stored);
      const out = hidesNothing(hidden)
        ? full
        : (project(schemaOf().nodeFromJSON(full), hidden).doc.toJSON() as JsonNode);
      return {
        seq: at,
        incarnation: head.incarnation,
        cdm: record.cdmVersion,
        requires: [...record.requires],
        doc: out as Content['doc'],
        view: d.tokens.tokenFor(hidden),
      };
    } catch (e) {
      throw this.#readError(e, `content of ${doc}`, { tenant: identity.tenant, doc });
    }
  }

  #readError(e: unknown, where: string, context: ErrorContext): DataPlaneError {
    if (e instanceof DataPlaneError) return e;
    if (e instanceof DocumentNotFoundError)
      return new DataPlaneError('not_found', 'no such document');
    if (e instanceof Refusal) return new DataPlaneError('unavailable', e.message);
    this.#deps.settings.onError(e, where, context);
    return new DataPlaneError('unavailable', 'the content could not be read');
  }

  /**
   * A page of the commit log after `after` (05 §6.2 `/commits`; BE-038): ascending, at most
   * `limit`, from at or above the reader's visibility gate only (HIS-024: a run of commits). A page
   * ends before a snapshot commit; one that would start with it is `conflict` (the client reloads,
   * decision D122). A reader whose class hides content is refused: the resource does not serve a
   * class's steps (ADR 0034 §1).
   */
  async readCommits(
    identity: VerifiedIdentity,
    doc: string,
    after: number,
    limit: number,
  ): Promise<CommitPage> {
    const role = identity.docs[doc];
    if (!role) throw new DataPlaneError('forbidden', 'the token gives no role in this document');
    if (!Number.isSafeInteger(after) || after < 0)
      throw new DataPlaneError('validation_failed', 'after must be a sequence number');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new DataPlaneError('validation_failed', 'limit must be from 1 to 200');
    const ref: DocRef = { tenant: identity.tenant, doc };
    const conn = connectionOf(identity, role);
    const d = this.#deps;
    try {
      if (d.faults.databaseDown)
        throw new DataPlaneError('unavailable', 'the database is unreachable');
      const record = await d.documents.get(ref);
      if (!record || record.deletedAt !== null)
        throw new DataPlaneError('not_found', 'no such document');
      const head = await d.logs.head(ref);
      if (after > head.seq) throw new DataPlaneError('not_found', `no commit after ${after}`);
      const stored = await d.grants.current(ref);
      const room = this.get(ref);
      let gate: number;
      let hides: boolean;
      if (room && room.head === head.seq) {
        if (stored.revision > room.permissions.revision) room.permissionsChanged(stored);
        gate = room.minVisibleSeq(conn);
        hides = d.restricted && room.hidesFor(conn);
      } else {
        const setting = historySetting(record.historyVisibility);
        const cheap =
          setting === 'all' || (setting === 'editors' && (role === 'owner' || role === 'editor'));
        if (cheap && !d.restricted) {
          gate = setting === 'all' ? 0 : 0;
          hides = false;
        } else if (setting === 'since_access' && !d.restricted) {
          const log = await d.logs.read(ref, 1, head.seq);
          gate = gateOf(conn, {
            setting,
            head: schemaOf().nodeFromJSON(emptyDocJson()),
            headSeq: head.seq,
            perms: stored,
            log,
            now: d.now(),
          });
          hides = false;
        } else {
          const m = await this.#materialise(ref, head.seq);
          const headDoc = schemaOf().nodeFromJSON(m.doc);
          gate = gateOf(conn, {
            setting,
            head: headDoc,
            headSeq: head.seq,
            perms: stored,
            log: m.log,
            now: d.now(),
          });
          hides = d.restricted && !hidesNothing(d.tokens.hidden(conn, headDoc, stored));
        }
      }
      if (hides)
        throw new DataPlaneError(
          'forbidden',
          'the commits resource serves only the full view; reload instead',
        );
      if (!rangeAllowed(gate, after))
        throw new DataPlaneError('forbidden', 'the history before your access is not visible');
      const to = Math.min(head.seq, after + limit);
      const commits = to > after ? await d.logs.read(ref, after + 1, to) : [];
      const cut = commits.findIndex((c) => isSnapshot(c));
      if (cut === 0)
        throw new DataPlaneError(
          'conflict',
          'a snapshot commit follows; reload the content instead',
        );
      const page = cut > 0 ? commits.slice(0, cut) : commits;
      const users = [...new Set(page.map((c) => c.user))].filter((u) => u !== 'system');
      const subs =
        d.users && users.length
          ? await d.users.subsOf(ref.tenant, users)
          : new Map<string, string>();
      const items = page.map((c) =>
        toRemoteCommit(c as Exclude<LogCommit, SnapshotCommit>, 0, (u) =>
          d.users ? (subs.get(u) ?? u) : u,
        ),
      );
      const last = items.length ? items[items.length - 1]!.seq : after;
      return {
        items,
        next: last < head.seq ? last : null,
        head: head.seq,
        incarnation: head.incarnation,
      };
    } catch (e) {
      throw this.#readError(e, `commits of ${doc}`, { tenant: identity.tenant, doc });
    }
  }

  // --- Stopping (06 §2.2 steps 4, 5; BE-018, BE-022) --------------------------------------------

  /**
   * Drains every room (BE-022): new channels are refused, commits in flight are written and
   * answered, rooms with changes are checkpointed. The caller then closes the connections and
   * calls `close`, which releases ownership.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.#draining = true;
    await Promise.allSettled([...this.#loading.values()]);
    await Promise.all(this.rooms.map((r) => r.drain(timeoutMs)));
  }

  /** The node lost its lease (BE-018): every room stops now, viewers' rooms too. */
  fence(reason: string): void {
    for (const r of this.rooms) r.fence(reason);
  }

  /** Stops one room as a crash would (BE-079). */
  kill(ref: DocRef): boolean {
    const r = this.get(ref);
    if (!r) return false;
    r.fence('the room was stopped');
    return true;
  }

  /** Stops every room, checkpoints those with changes, and releases ownership (step 5). */
  async close(reason: string): Promise<void> {
    this.#closed = true;
    if (this.#budgetTimer) clearInterval(this.#budgetTimer);
    await Promise.allSettled([...this.#loading.values(), ...this.#transients.values()]);
    await Promise.all(
      [...this.#rooms.values()].map((r) =>
        r.shutdown(reason, true, {
          checkpoint: true,
          timeoutMs: this.#deps.settings.drainTimeoutMs,
        }),
      ),
    );
    this.#rooms.clear();
  }
}

/** The room's connection for an identity and a role (05 §3.1; 08 §9 `access_since`). */
export function connectionOf(
  identity: VerifiedIdentity,
  role: RoomConnection['role'],
): RoomConnection {
  return {
    ...identity.connection,
    role,
    ...(identity.accessSince !== undefined ? { accessSince: identity.accessSince } : {}),
    ...(identity.restrict.length > 0 ? { restrictions: identity.restrict } : {}),
  };
}

/** The head as of time `t` from the log after a checkpoint (D126); the checkpoint when none is older. */
function recentHeadOf(m: { cp: LoadedCheckpoint; log: readonly LogCommit[] }, t: number): number {
  let head = m.cp.seq;
  for (const c of m.log) if (c.time <= t) head = c.seq;
  return head;
}

/** The size the room's estimate starts from (BE-021): the canonical bytes when known. */
function baseBytesOf(cp: LoadedCheckpoint): number {
  return JSON.stringify(cp.envelope.doc).length;
}

/** A document with a body and nothing in it, for gates that need no regions. */
function emptyDocJson(): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          {
            type: 'settings',
            attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
          },
          {
            type: 'style_def',
            attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
          },
          {
            type: 'page_setup',
            attrs: {
              id: 'ps1',
              width: 11906,
              height: 16838,
              marginTop: 1440,
              marginRight: 1440,
              marginBottom: 1440,
              marginLeft: 1440,
            },
          },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [{ type: 'paragraph', attrs: { id: 'p0000000000000001', style: 'Normal' } }],
      },
    ],
  };
}
