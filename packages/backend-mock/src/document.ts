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
  type Outbound,
  type PermissionState,
  type RegionGrant,
  type WriteRequest,
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
import { MemoryLog } from './storage.ts';

export interface DocumentHooks {
  now(): number;
  limits: Limits;
  presence: boolean;
}

interface Segment {
  /** External seq of the content the segment starts from: 0, or the seq of a snapshot commit. */
  start: number;
  /** External seq = room seq + offset. */
  offset: number;
  initial: Node;
  requires: string[];
  log: MemoryLog;
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
  private held = false;
  private answering: string | null = null;
  /** The room's output as DEP payloads (`@docedit/protocol/bridge`; S6 report, section 6). */
  private readonly bridge: RoomBridge;
  private nextChannel = 1;
  state: 'active' | 'locked' | 'archived' = 'active';

  constructor(
    id: string,
    content: CdmEnvelope,
    grants: readonly GrantSpec[],
    hooks: DocumentHooks,
  ) {
    this.id = id;
    this.hooks = hooks;
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
      log: new MemoryLog(this.perms),
    });
    this.room = this.newRoom(initial, content.requires);
    this.bridge = new RoomBridge({
      source: () => this.room,
      now: () => this.hooks.now(),
      offset: () => this.segment.offset,
    });
  }

  /** A room whose sequence number 0 is `initial`, under the current grants revision. */
  private newRoom(initial: Node, requires: readonly string[]): Room {
    return new Room({
      schema,
      initial,
      requires,
      log: [],
      perms: this.perms,
      initialRevision: this.perms.revision,
      epoch: 1,
      incarnation: this.incarnation,
      now: () => this.hooks.now(),
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
    if (this.held || this.writeScheduled) return;
    this.writeScheduled = true;
    void Promise.resolve().then(() => {
      this.writeScheduled = false;
      this.performWrites(false);
    });
  }

  /** Performs pending writes until none is left; with `fail`, the first one fails. */
  private performWrites(fail: boolean): void {
    let failNext = fail;
    while (this.pendingWrite && (!this.held || failNext)) {
      const req = this.pendingWrite;
      this.pendingWrite = null;
      const seg = this.segment;
      const result = seg.log.write(req, failNext);
      failNext = false;
      if (result.status === 'ok')
        for (const c of req.commits)
          this.stored.set(c.id, { seq: c.seq + seg.offset, user: c.user });
      const fx = this.room.writeCompleted(result);
      this.deliver(fx.send);
      // A commit that adds or removes a region is followed by perm.changed (07 §4; D12; G46).
      this.dispatch(this.bridge.regionsChanged(this.head));
      if (fx.write) this.pendingWrite = fx.write;
    }
  }

  /** Test hook: holds writes; `release` performs them at once, `fail` makes the held one fail. */
  holdWrites(): { release(): Promise<void>; fail(): Promise<void> } {
    this.held = true;
    return {
      release: async () => {
        this.held = false;
        this.performWrites(false);
      },
      fail: async () => {
        this.held = false;
        this.performWrites(true);
      },
    };
  }

  // --- Room output --------------------------------------------------------------------------

  /**
   * Delivers room messages, translated to DEP by the bridge, in order per channel: commits are
   * coalesced, and `perm.changed` waits for the control commit of its revision (D12).
   */
  private deliver(send: readonly Outbound[]): void {
    this.dispatch(this.bridge.translate(send));
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
    const fx = this.room.permissionsChanged(next);
    this.deliver(fx.send);
    if (fx.write) this.queueWrite(fx.write);
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

  /** The derived region list of `GET /documents/{id}/regions`, in document order. */
  regions(): RegionInfo[] {
    const out: RegionInfo[] = [];
    const doc = this.room.document;
    doc.child(doc.childCount - 1).forEach((n) => {
      if (n.type.name !== 'region') return;
      const id = String(n.attrs['id']);
      out.push({
        id,
        title: String(n.attrs['title'] ?? ''),
        policy: n.attrs['policy'] === 'restricted' ? 'restricted' : 'inherit',
        order: out.length,
        state: this.perms.regionStates.get(id) ?? 'draft',
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

  // --- Snapshot commits (04 §3.2; PUT /documents/{id}/content) ------------------------------

  replaceContent(content: CdmEnvelope): void {
    if (this.held) throw new PortError('unavailable', 'writes are held');
    this.performWrites(false);
    if (this.room.pendingCount > 0)
      throw new PortError('unavailable', 'commits are still being stored');
    const initial = schema.nodeFromJSON(content.doc);
    initial.check();
    // The snapshot commit takes the next seq; the new room's seq 0 is its content.
    const seq = this.head + 1;
    this.segments.push({
      start: seq,
      offset: seq,
      initial,
      requires: [...content.requires],
      log: new MemoryLog(this.perms),
    });
    this.stored.set(uuid7(), { seq, user: 'system' });
    const old = this.room;
    this.room = this.newRoom(initial, content.requires);
    this.bridge.resetRegions();
    for (const [roomId, a] of this.attached) {
      old.close(roomId);
      // Re-attach the channel to the new room; its answers are internal.
      this.room.open(roomId, a.conn, { seq: 0, incarnation: this.incarnation, inflight: null });
      a.channel.reset({ seq, reason: 'import' });
    }
    this.dispatch(this.bridge.recomputeAccess(seq));
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
