/**
 * One document of the mock service. It runs the real authority (`Room` from @docedit/authority) in
 * process over an in-memory log, and does what the document service does around the room (06 §2,
 * §3): the write pipeline, permission changes with a new grants revision written first (04 G7),
 * snapshot commits, notifications, presence and checkpoints.
 *
 * The room has no snapshot commits (04 §3.2): a snapshot starts a new segment, a new Room whose
 * content at its sequence number 0 is the snapshot. External sequence numbers are the room's plus
 * the segment's offset.
 */
import {
  Room,
  applySteps,
  regionsOf,
  type Connection,
  type ThreadAnchor,
  type Outbound,
  type PermissionState,
  type RegionGrant,
  type StoredCommit,
  type WriteRequest,
  type WriteResult,
} from '@docedit/authority';
import {
  documentHash,
  formatTimestamp,
  uuid7,
  type CdmEnvelope,
  type JsonEnvelope,
} from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import {
  PortError,
  depCodec,
  utf8Length,
  type Commit,
  type Content,
  type FieldInfo,
  type FieldValues,
  type Grants,
  type GrantsPatch,
  type Inflight,
  type Limits,
  type PresenceUpdate,
  type RegionInfo,
  type RegionState,
  type Resume,
  type SessionUser,
  type Tagged,
} from '@docedit/protocol';
import { RoomBridge, type DepOutbound } from '@docedit/protocol/bridge';
import type { Node } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { MockChannel, type ChannelHost, type ChannelForward } from './channel.ts';
import { fieldsOf, prefillSteps, valuesByKey } from './fields.ts';
import {
  packPerms,
  unpackPerms,
  type DocumentPersistence,
  type DocumentRecord,
  type RestoredDocument,
  type SegmentRecord,
} from './persist.ts';
import { MemoryLog, PersistedLog, type SegmentLog } from './storage.ts';
import { MockThreads } from './threads.ts';

export interface DocumentHooks {
  now(): number;
  limits: Limits;
  presence: boolean;
  mathGate?: (latex: string, display: boolean) => string | null;
  /** Where the document keeps its log, when it outlives the process (PRO-100). Absent: memory only. */
  persist?: DocumentPersistence;
}

interface Segment {
  /** External seq of the content the segment starts from: 0, or the seq of a snapshot commit. */
  start: number;
  /** External seq = room seq + offset. */
  offset: number;
  initial: Node;
  requires: string[];
  /** The grants revision in force at `start`. */
  revision: number;
  log: SegmentLog;
}

interface Attached {
  channel: MockChannel;
  conn: Connection;
  user: SessionUser;
}

const schema = cdmSchema();
const codec = depCodec();

export class MockDocument implements ChannelHost {
  readonly id: string;
  readonly incarnation: string = uuid7();
  private readonly hooks: DocumentHooks;
  private perms: PermissionState;
  private readonly segments: Segment[] = [];
  private room: Room;
  private readonly attached = new Map<string, Attached>();
  /** Every stored commit, across segments: identifier to external seq and author (inflight on resume). */
  private readonly stored = new Map<string, { seq: number; user: string }>();
  private pendingWrite: WriteRequest | null = null;
  private writeScheduled = false;
  /** The write the store has not answered yet, when the log is persistent (PRO-100). */
  private writing: Promise<void> | null = null;
  private held = false;
  private answering: string | null = null;
  /** The room's output as DEP payloads (`@docedit/protocol/bridge`; S6 report, section 6). */
  private readonly bridge: RoomBridge;
  private nextChannel = 1;
  /** Answers to server-authored commits: the requester is not a channel (04 §10). */
  private readonly requesters = new Map<string, Outbound['msg'][]>();
  state: 'active' | 'locked' | 'archived' = 'active';
  /** The comment threads of the document (05 §6.2; ADR 0015; ADR 0417). */
  readonly threads: MockThreads = new MockThreads({
    now: () => this.hooks.now(),
    room: () => this.room,
    offset: () => this.segment.offset,
    head: () => this.head,
    notify: (n, readable) => {
      for (const a of this.attached.values()) if (readable(a.conn)) a.channel.event(n);
    },
  });

  constructor(
    id: string,
    content: CdmEnvelope,
    grants: readonly GrantSpec[],
    hooks: DocumentHooks,
    restored?: RestoredDocument,
  ) {
    this.id = id;
    this.hooks = hooks;
    if (restored) {
      // A document read back from its store: the segments, the log and the permissions as they were.
      this.incarnation = restored.record.incarnation;
      this.perms = unpackPerms(restored.record.perms);
      this.state = this.perms.documentState;
      this.loadSegments(restored);
      this.room = this.newRoom(this.segment.initial, this.segment.requires, this.segment);
      this.bridge = new RoomBridge({
        source: () => this.room,
        now: () => this.hooks.now(),
        offset: () => this.segment.offset,
      });
      return;
    }
    const initial = schema.nodeFromJSON(content.doc);
    initial.check();
    // The content a document is created with is the content at seq 0, and its grants are revision 0
    // (G97): creation is not a change, so no control commit records it.
    this.perms = {
      revision: 0,
      grants: grants.map(
        (g) =>
          ({
            region: g.region,
            principal: g.principal,
            role: g.role,
            expiresAt: g.expiresAt ?? null,
          }) satisfies RegionGrant,
      ),
      regionStates: new Map(),
      leases: [],
      documentState: 'active',
      workflowActive: false,
    };
    this.segments.push({
      start: 0,
      offset: 0,
      initial,
      requires: [...content.requires],
      revision: 0,
      log: this.newLog(this.perms, 0, []),
    });
    this.room = this.newRoom(initial, content.requires, this.segment);
    this.bridge = new RoomBridge({
      source: () => this.room,
      now: () => this.hooks.now(),
      offset: () => this.segment.offset,
    });
  }

  /** The log of a segment: in memory, or in the store when the document has one (PRO-100). */
  private newLog(perms: PermissionState, start: number, seed: readonly StoredCommit[]): SegmentLog {
    const persist = this.hooks.persist;
    if (!persist) return new MemoryLog(perms, seed);
    const index = this.segments.length;
    return new PersistedLog(perms, seed, (req) => persist.append(index, start, req));
  }

  /** Builds `this.segments` and `this.stored` from what a store holds. */
  private loadSegments(restored: RestoredDocument): void {
    const recs = restored.record.segments;
    this.segments.length = 0;
    this.stored.clear();
    recs.forEach((r, i) => {
      const next = recs[i + 1];
      const entries = restored.commits.filter(
        (e) => e.ext > r.start && (next === undefined || e.ext < next.start),
      );
      const initial = schema.nodeFromJSON(r.initial);
      initial.check();
      this.segments.push({
        start: r.start,
        offset: r.start,
        initial,
        requires: [...r.requires],
        revision: r.revision,
        log: this.newLog(
          this.perms,
          r.start,
          entries.map((e) => e.commit),
        ),
      });
      for (const e of entries) this.stored.set(e.commit.id, { seq: e.ext, user: e.commit.user });
    });
  }

  /** A room whose sequence number 0 is `initial`, under the grants revision of its segment. */
  private newRoom(
    initial: Node,
    requires: readonly string[],
    seg?: Segment,
    threads?: readonly ThreadAnchor[],
  ): Room {
    return new Room({
      ...(threads && threads.length > 0 ? { threads } : {}),
      schema,
      initial,
      requires,
      log: seg ? [...seg.log.commits] : [],
      perms: this.perms,
      initialRevision: seg ? seg.revision : this.perms.revision,
      epoch: 1,
      incarnation: this.incarnation,
      now: () => this.hooks.now(),
      ...(this.hooks.mathGate ? { mathGate: this.hooks.mathGate } : {}),
    });
  }

  /**
   * The thread anchors a new room starts with (ADR 0015). After a snapshot commit (`replaced`) a
   * range cannot follow the content: each range thread is detached and keeps the scopes it covered,
   * and a block thread follows its identifier. Otherwise the anchors keep their place, with their
   * seq counted from the new room's start (`shift` is the old offset minus the new one).
   */
  private carryThreads(old: Room, replaced: boolean, shift: number): ThreadAnchor[] {
    return old.threadAnchors().map((a): ThreadAnchor => {
      if (!replaced) return { ...a, seq: Math.max(0, a.seq + shift) };
      if (!('range' in a.target)) return { ...a, seq: 0 };
      return {
        ...a,
        seq: 0,
        detached: true,
        target: { range: { from: 0, to: 0 } },
        scopes: a.detached ? (a.scopes ?? []) : (old.threadScopes(a.id) ?? []),
      };
    });
  }

  private get segment(): Segment {
    return this.segments[this.segments.length - 1]!;
  }

  get head(): number {
    return this.room.head + this.segment.offset;
  }

  // --- Content (GET /documents/{id}/content) --------------------------------------------------

  content(seq?: number): Content {
    const head = this.head;
    if (seq === undefined || seq === head)
      return {
        seq: head,
        incarnation: this.incarnation,
        cdm: 1,
        requires: [...this.segment.requires],
        doc: this.room.document.toJSON(),
      };
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > head)
      throw new PortError('not_found', `no content at seq ${seq} (head ${head})`);
    const seg = [...this.segments].reverse().find((s) => s.start <= seq)!;
    let doc = seg.initial;
    for (const c of seg.log.commits) {
      if (c.seq + seg.offset > seq) break;
      // The authority's apply (04 §5 step 5, SYN-001): this backend has no implementation of its own.
      const r = applySteps(
        doc,
        c.steps.map((s) => Step.fromJSON(schema, s)),
      );
      if (!r.ok)
        throw new PortError('internal', `stored commit ${c.seq} does not replay: ${r.reason}`);
      doc = r.value.doc;
    }
    return {
      seq,
      incarnation: this.incarnation,
      cdm: 1,
      requires: [...seg.requires],
      doc: doc.toJSON(),
    };
  }

  // --- Channels -------------------------------------------------------------------------------

  open(
    conn: Connection,
    user: SessionUser,
    resume: Resume | undefined,
    forward: ChannelForward,
  ): MockChannel {
    const seg = this.segment;
    const head = this.head;
    // A resume before the latest snapshot commit cannot stream (04 §3.2): the room is asked
    // without one and answers `reload`. The fate of resume.inflight comes from the whole log (D08).
    const streamable =
      resume !== undefined &&
      resume.incarnation === this.incarnation &&
      resume.seq >= seg.start &&
      resume.seq <= head;
    const roomId = `c${this.nextChannel++}`;
    const fx = this.room.open(
      roomId,
      conn,
      streamable
        ? {
            seq: resume.seq - seg.offset,
            incarnation: resume.incarnation,
            inflight: resume.inflight ?? null,
            ...(resume.view !== undefined ? { view: resume.view } : {}),
          }
        : undefined,
    );
    const first = fx.send[0]?.msg;
    if (!first || first.t !== 'ch.opened')
      throw new PortError('unavailable', 'the room stopped serving the document');
    let inflight: Inflight | undefined;
    if (resume?.inflight !== undefined) {
      // Only the caller's own commit is reported as accepted, as the room does.
      const at = this.stored.get(resume.inflight);
      inflight =
        at === undefined || at.user !== conn.sub
          ? { state: 'unknown' }
          : { state: 'accepted', seq: at.seq };
    }
    // The plain room serves the full view and sets no token; a projecting gateway would (ADR 0019).
    const opened = this.bridge.opened(roomId, conn, first, {
      catchUp: streamable ? first.catchUp : 'reload',
      ...(inflight ? { inflight } : {}),
    });
    const channel = new MockChannel(this, this.id, roomId, conn.session, opened, forward);
    this.attached.set(roomId, { channel, conn, user });
    this.deliver(fx.send.slice(1));
    return channel;
  }

  closeChannel(channel: MockChannel): void {
    const a = this.attached.get(channel.roomId);
    if (!a) return;
    this.attached.delete(channel.roomId);
    this.bridge.detach(channel.roomId);
    this.room.close(channel.roomId);
    if (this.hooks.presence)
      for (const o of this.attached.values())
        o.channel.presence({ peers: [], left: [channel.session] });
  }

  /** The server closes every channel of a user (revocation, 05 §3.3). */
  closeChannelsOf(sub: string, reason: string): void {
    for (const a of [...this.attached.values()])
      if (a.conn.sub === sub) {
        this.closeChannel(a.channel);
        a.channel.serverClosed('forbidden', reason);
      }
  }

  submit(channel: MockChannel, commit: Commit): void {
    const seg = this.segment;
    if (commit.base < seg.start) {
      // 04 §3.2 and §5 step 3: stale_base with action rebase. The client has already received
      // sync.reset, re-applied its steps to the new content, and resubmits what still applies.
      channel.reject(
        {
          id: commit.id,
          code: 'stale_base',
          message: 'a snapshot commit lies after the base; resubmit on the new content',
          action: 'rebase',
          head: this.head,
        },
        'newest',
      );
      return;
    }
    const input = {
      id: commit.id,
      base: commit.base - seg.offset,
      steps: commit.steps,
      ...(commit.origin !== undefined ? { origin: commit.origin } : {}),
    };
    this.answering = channel.roomId;
    try {
      const fx = this.room.submit(channel.roomId, input);
      this.deliver(fx.send);
      if (fx.write) this.queueWrite(fx.write);
    } finally {
      this.answering = null;
    }
  }

  // --- Writes (04 §5 steps 9 and 10) ------------------------------------------------------------

  private queueWrite(req: WriteRequest): void {
    this.pendingWrite = req;
    if (this.held || this.writeScheduled || this.writing) return;
    this.writeScheduled = true;
    void Promise.resolve().then(() => {
      this.writeScheduled = false;
      this.performWrites(false);
    });
  }

  /**
   * Performs pending writes until none is left; with `fail`, the first one fails. A memory log
   * answers at once. A store may answer later: the loop then waits for it, and `drain` tells when
   * it is over (PRO-100).
   */
  private performWrites(fail: boolean): void {
    if (this.writing) return;
    let failNext = fail;
    const step = (): void => {
      while (this.pendingWrite && (!this.held || failNext)) {
        const req = this.pendingWrite;
        this.pendingWrite = null;
        const seg = this.segment;
        const result = seg.log.write(req, failNext);
        failNext = false;
        if (result instanceof Promise) {
          this.writing = result.then((r) => {
            this.writing = null;
            this.writeCompleted(req, seg, r);
            step();
          });
          return;
        }
        this.writeCompleted(req, seg, result);
      }
    };
    step();
  }

  private writeCompleted(req: WriteRequest, seg: Segment, result: WriteResult): void {
    if (result.status === 'ok')
      for (const c of req.commits) this.stored.set(c.id, { seq: c.seq + seg.offset, user: c.user });
    if (result.status === 'fenced') this.hooks.persist?.stale();
    const fx = this.room.writeCompleted(result);
    this.deliver(fx.send);
    // A commit that adds or removes a region is followed by perm.changed (07 §4; D12; G46).
    this.dispatch(this.bridge.regionsChanged(this.head));
    if (fx.write) this.pendingWrite = fx.write;
  }

  /** Resolves when no write is pending or waiting for the store (a held write is not waited for). */
  async drain(): Promise<void> {
    for (;;) {
      if (this.writing) {
        await this.writing;
        continue;
      }
      if (this.pendingWrite && !this.held) {
        this.performWrites(false);
        if (this.writing) continue;
      }
      return;
    }
  }

  /** Test hook: holds writes; `release` performs them at once, `fail` makes the held one fail. */
  holdWrites(): { release(): Promise<void>; fail(): Promise<void> } {
    this.held = true;
    return {
      release: async () => {
        this.held = false;
        this.performWrites(false);
        await this.drain();
      },
      fail: async () => {
        this.held = false;
        this.performWrites(true);
        await this.drain();
      },
    };
  }

  // --- Room output --------------------------------------------------------------------------

  /**
   * Delivers room messages, translated to DEP by the bridge, in order per channel: commits are
   * coalesced, and `perm.changed` waits for the control commit of its revision (D12).
   */
  private deliver(send: readonly Outbound[]): void {
    const rest: Outbound[] = [];
    for (const o of send) {
      const answers = this.requesters.get(o.channel);
      if (answers) answers.push(o.msg);
      else rest.push(o);
    }
    this.dispatch(this.bridge.translate(rest));
  }

  private dispatch(out: readonly DepOutbound[]): void {
    for (const { channel: id, event } of out) {
      const a = this.attached.get(id);
      if (!a) continue;
      const which = this.answering === id ? 'newest' : 'oldest';
      switch (event.t) {
        case 'sync.commit':
          a.channel.commits(event.d.commits);
          break;
        case 'sync.ack':
          a.channel.ack(event.d, which);
          break;
        case 'sync.reject':
          a.channel.reject(event.d, which);
          break;
        case 'sync.caughtUp':
          a.channel.state({ status: 'live', seq: event.d.seq });
          break;
        case 'sync.reset':
          a.channel.reset(event.d);
          break;
        case 'perm.changed':
          a.channel.setAccess(event.d);
          break;
        case 'ch.closed':
          this.attached.delete(id);
          // The bridge closes only with `unavailable`: the room moved, was fenced or stopped.
          a.channel.serverClosed('unavailable', event.d.reason);
          break;
      }
    }
  }

  // --- Permissions (07 §9; 05 §6.2) ---------------------------------------------------------

  /** A new grants revision, written to the database first (04 G7), then announced to the room. */
  private changePermissions(f: (p: PermissionState) => Omit<PermissionState, 'revision'>): void {
    const next: PermissionState = { ...f(this.perms), revision: this.perms.revision + 1 };
    this.perms = next;
    this.segment.log.perms = next;
    this.persistPerms(next);
    const fx = this.room.permissionsChanged(next);
    this.deliver(fx.send);
    if (fx.write) this.queueWrite(fx.write);
  }

  /** The next revision goes to the store before any commit written under it (04 G7). */
  private persistPerms(next: PermissionState): void {
    const persist = this.hooks.persist;
    if (!persist) return;
    void persist.putPerms(next).then((ok) => {
      if (!ok) persist.stale();
    });
  }

  setGrants(grants: readonly GrantSpec[]): void {
    this.changePermissions((p) => ({
      ...p,
      grants: grants.map((g) => ({
        region: g.region,
        principal: g.principal,
        role: g.role,
        expiresAt: g.expiresAt ?? null,
      })),
    }));
  }

  /**
   * Replaces the leases in force (07 §10), as the lease routes of a service store them: a new
   * permission revision, announced to the room. A break is a call with the lease left out.
   */
  setLeases(leases: PermissionState['leases']): void {
    this.changePermissions((p) => ({ ...p, leases: leases.map((l) => ({ ...l })) }));
  }

  setState(state: 'active' | 'locked' | 'archived'): void {
    this.state = state;
    for (const a of this.attached.values())
      a.channel.event({ type: 'document.updated', resource: `/documents/${this.id}` });
    this.changePermissions((p) => ({ ...p, documentState: state }));
  }

  grants(): Tagged<Grants> {
    return {
      value: {
        rev: this.perms.revision,
        grants: this.perms.grants.map((g) => ({
          region: g.region,
          principal: g.principal,
          role: g.role,
          expiresAt: g.expiresAt === null ? null : formatTimestamp(g.expiresAt),
        })),
      },
      etag: `"g${this.perms.revision}"`,
    };
  }

  updateGrants(patch: GrantsPatch, ifMatch: string): Tagged<Grants> {
    if (ifMatch !== '*' && ifMatch !== this.grants().etag)
      throw new PortError('precondition_failed', 'the grants changed since they were read');
    if (patch.grants) {
      // `everyone` on a restricted region is forbidden (07 §17; owner decision 12, 2026-11-15; PRM-061).
      const restricted = new Set(
        this.regions()
          .filter((r) => r.policy === 'restricted')
          .map((r) => r.id),
      );
      if (patch.grants.some((g) => g.principal === 'everyone' && restricted.has(g.region)))
        throw new PortError(
          'validation_failed',
          'everyone cannot hold a role on a restricted region',
        );
      this.setGrants(
        patch.grants.map((g) => ({ region: g.region, principal: g.principal, role: g.role })),
      );
    }
    return this.grants();
  }

  /**
   * The derived region list of `GET /documents/{id}/regions`, in document order, with who can edit
   * each region as the document service derives it (05 §6.2 `RegionEditors`; PRM-032 criterion 5):
   * the document roles that may edit by role alone, the principals with an `editor` grant that has
   * not expired, and the holder of a lease. Nobody while the region is approved or the document is
   * not active.
   */
  regions(): RegionInfo[] {
    const out: RegionInfo[] = [];
    const doc = this.room.document;
    const now = this.hooks.now();
    doc.child(doc.childCount - 1).forEach((n) => {
      if (n.type.name !== 'region') return;
      const id = String(n.attrs['id']);
      const policy = n.attrs['policy'] === 'restricted' ? 'restricted' : 'inherit';
      const state = this.perms.regionStates.get(id) ?? 'draft';
      const frozen = state === 'approved' || this.perms.documentState !== 'active';
      const lease = this.perms.leases.find((l) => l.region === id && l.expiresAt > now);
      const principals = frozen
        ? []
        : this.perms.grants
            .filter(
              (g) =>
                g.region === id &&
                g.role === 'editor' &&
                (g.expiresAt === null || g.expiresAt > now),
            )
            .map((g) => g.principal);
      out.push({
        id,
        title: String(n.attrs['title'] ?? ''),
        policy,
        order: out.length,
        state,
        editors: {
          roles: frozen ? [] : policy === 'inherit' ? ['editor', 'owner'] : ['owner'],
          principals: [...new Set(principals)].sort(),
          ...(lease && !frozen ? { leasedTo: lease.holder } : {}),
        },
      });
    });
    return out;
  }

  setRegionState(region: string, state: 'draft' | 'in_review' | 'approved'): Tagged<RegionState> {
    if (!regionsOf(this.room.document).some((r) => r.id === region))
      throw new PortError('not_found', `no region ${region}`);
    this.changePermissions((p) => ({
      ...p,
      regionStates: new Map(p.regionStates).set(region, state),
    }));
    const out: RegionState = state === 'approved' ? { state, seq: this.head } : { state };
    return { value: out, etag: `"r${this.perms.revision}"` };
  }

  // --- Fields (12 §3, §9, §10) ---------------------------------------------------------------

  /** `GET /documents/{id}/fields`: the derived list, in document order. */
  fieldList(): FieldInfo[] {
    return fieldsOf(this.room.document).map((f) => f.info);
  }

  /** `GET /documents/{id}/field-values`: by key, at the head or pinned with `seq`. */
  fieldValues(seq?: number, keys: readonly string[] = []): Tagged<FieldValues & { seq: number }> {
    const at = seq ?? this.head;
    const doc = seq === undefined ? this.room.document : schema.nodeFromJSON(this.content(seq).doc);
    return {
      value: { values: valuesByKey(fieldsOf(doc), keys), seq: at },
      etag: `"v.${this.incarnation}.${at}"`,
    };
  }

  /**
   * `PATCH /documents/{id}/field-values`: prefill by key (12 §9). One server-authored commit with
   * origin `prefill`, all or nothing. The room applies it like a client commit (04 §5) and the
   * answer is read back from its effects.
   */
  prefill(values: Readonly<Record<string, unknown>>, ifMatch: string): Tagged<FieldValues> {
    if (ifMatch !== '*' && ifMatch !== this.fieldValues().etag)
      throw new PortError('precondition_failed', 'the field values changed since they were read');
    if (Object.keys(values).length === 0)
      throw new PortError('validation_failed', 'a prefill names at least one key');
    if (this.perms.workflowActive)
      throw new PortError('workflow_active', 'a workflow is active; participants fill the fields');
    if (this.held) throw new PortError('unavailable', 'writes are held');
    this.performWrites(false);
    const steps = prefillSteps(this.room.document, values);
    const requester = `r${this.nextChannel++}`;
    const answers: Outbound['msg'][] = [];
    this.requesters.set(requester, answers);
    try {
      const fx = this.room.author(requester, {
        id: uuid7(this.hooks.now()),
        base: this.room.head,
        steps,
        origin: 'prefill',
        as: 'system',
        preconditions: {
          revision: this.perms.revision,
          head: this.room.head,
          documentState: this.perms.documentState,
          workflowActive: this.perms.workflowActive,
        },
      });
      this.deliver(fx.send);
      if (fx.write) {
        this.pendingWrite = fx.write;
        this.performWrites(false);
      }
    } finally {
      this.requesters.delete(requester);
    }
    const reject = answers.find((m) => m.t === 'sync.reject');
    if (reject?.t === 'sync.reject') {
      const code = reject.code === 'field_invalid' ? 'field_invalid' : 'conflict';
      throw new PortError(code, `the prefill was refused (${reject.code})`);
    }
    return {
      value: { values: valuesByKey(fieldsOf(this.room.document), Object.keys(values)) },
      etag: this.fieldValues().etag,
    };
  }

  // --- Snapshot commits (04 §3.2; PUT /documents/{id}/content) ------------------------------

  replaceContent(content: CdmEnvelope): void {
    if (this.held) throw new PortError('unavailable', 'writes are held');
    this.performWrites(false);
    if (this.writing || this.room.pendingCount > 0)
      throw new PortError('unavailable', 'commits are still being stored');
    const initial = schema.nodeFromJSON(content.doc);
    initial.check();
    // The snapshot commit takes the next seq; the new room's seq 0 is its content.
    const seq = this.head + 1;
    const expectHead = this.head;
    const record: SegmentRecord = {
      start: seq,
      revision: this.perms.revision,
      initial: initial.toJSON(),
      requires: [...content.requires],
    };
    this.segments.push({
      start: seq,
      offset: seq,
      initial,
      requires: [...content.requires],
      revision: this.perms.revision,
      log: this.newLog(this.perms, seq, []),
    });
    const persist = this.hooks.persist;
    if (persist)
      void persist.addSegment(record, expectHead).then((ok) => {
        if (!ok) persist.stale();
      });
    this.stored.set(uuid7(), { seq, user: 'system' });
    const old = this.room;
    this.room = this.newRoom(
      initial,
      content.requires,
      this.segment,
      this.carryThreads(old, true, 0),
    );
    this.bridge.resetRegions();
    for (const [roomId, a] of this.attached) {
      old.close(roomId);
      // Re-attach the channel to the new room; its answers are internal.
      this.room.open(roomId, a.conn, { seq: 0, incarnation: this.incarnation, inflight: null });
      a.channel.reset({ seq, reason: 'import' });
    }
    this.dispatch(this.bridge.recomputeAccess(seq));
  }

  // --- Following the store (PRO-100) ---------------------------------------------------------

  /**
   * Takes on what another writer stored: a second tab on the same store. The room is built again
   * from the store, and every channel resumes at the head it had, so it streams what it missed
   * (04 §9). Call it when no write of this document is waiting (`drain`). A channel behind a new
   * snapshot gets `sync.reset`, as after `replaceContent`.
   */
  adopt(restored: RestoredDocument): void {
    const newSegments = restored.record.segments.length !== this.segments.length;
    const oldOffset = this.segment.offset;
    const oldHead = this.head;
    const revision = this.perms.revision;
    if (this.incarnation !== restored.record.incarnation)
      throw new PortError('internal', 'the store holds another incarnation of the document');
    this.perms = unpackPerms(restored.record.perms);
    this.state = this.perms.documentState;
    this.loadSegments(restored);
    const old = this.room;
    this.room = this.newRoom(
      this.segment.initial,
      this.segment.requires,
      this.segment,
      this.carryThreads(old, newSegments, oldOffset - this.segment.offset),
    );
    this.bridge.resetRegions();
    const seg = this.segment;
    for (const [roomId, a] of this.attached) {
      old.close(roomId);
      if (newSegments || oldHead < seg.start) {
        this.room.open(roomId, a.conn, { seq: 0, incarnation: this.incarnation, inflight: null });
        a.channel.reset({ seq: seg.start, reason: 'import' });
        continue;
      }
      const fx = this.room.open(roomId, a.conn, {
        seq: oldHead - seg.offset,
        incarnation: this.incarnation,
        inflight: null,
      });
      this.deliver(fx.send.slice(1));
    }
    if (newSegments || this.perms.revision !== revision || this.head !== oldHead)
      this.dispatch(this.bridge.recomputeAccess(this.head));
  }

  /** Whether nothing of this document is waiting to be stored: the moment to `adopt`. */
  get quiet(): boolean {
    return !this.writing && !this.pendingWrite && this.room.pendingCount === 0;
  }

  /** The document row a store keeps (everything but the commits). */
  toRecord(): DocumentRecord {
    return {
      id: this.id,
      incarnation: this.incarnation,
      perms: packPerms(this.perms),
      segments: this.segments.map((s) => ({
        start: s.start,
        revision: s.revision,
        initial: s.initial.toJSON(),
        requires: [...s.requires],
      })),
      head: this.head,
    };
  }

  // --- Presence (05 §5.4) and checkpoints (04 §13) ------------------------------------------

  presence(from: MockChannel, update: PresenceUpdate): void {
    if (!this.hooks.presence) return;
    const a = this.attached.get(from.roomId);
    if (!a) return;
    // The server validates `state` against its schema and the presenceBytes limit (05 §5.4).
    if (codec.check({ t: 'presence.update', ch: 1, d: update }, 'server').length) return;
    if (utf8Length(JSON.stringify(update.state)) > this.hooks.limits.presenceBytes) return;
    const peer = { session: from.session, user: a.user, seq: update.seq, state: update.state };
    for (const o of this.attached.values())
      if (o.channel !== from) o.channel.presence({ peers: [peer], left: [] });
  }

  async checkpoint(): Promise<void> {
    const env = {
      cdm: 1,
      requires: this.segment.requires,
      doc: this.room.document.toJSON(),
    } as unknown as JsonEnvelope;
    const hash = await documentHash(env);
    const seq = this.head;
    for (const a of this.attached.values()) a.channel.check({ seq, hash });
  }
}

export interface GrantSpec {
  region: string;
  principal: string;
  role: 'viewer' | 'commenter' | 'suggester' | 'editor';
  /** When the grant runs out, Unix milliseconds on the service clock (07 §1); never, when left out. */
  expiresAt?: number;
}
