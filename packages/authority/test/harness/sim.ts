/**
 * The S3 simulation (SPK-016; SYN-047 in process). Clients, the room, storage and the network are
 * driven by a list of operations, so that fast-check can generate, replay and shrink schedules.
 * Faults: failed writes, writes with an unknown outcome (stored or not), grant changes whose
 * notification to the room is lost, dropped connections, and room crashes with failover, in which
 * the crashed room's write may land before the new owner's claim, never, or after it (so that the
 * old room is fenced). With `snapshots`, the control plane also restores earlier versions as
 * snapshot commits (SYN-005).
 *
 * After the operations, the run quiesces (no more faults; everything is delivered and flushed)
 * and the checks of `check()` run.
 */
import type { Node } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import type { PermissionState, RegionGrant } from '../../src/permissions/model.ts';
import { applySteps } from '../../src/rebase.ts';
import { Room, type SnapshotRequest } from '../../src/room/room.ts';
import {
  type Effects,
  type LogCommit,
  type SnapshotCommit,
  type StoredCommit,
  type WriteRequest,
  isSnapshot,
} from '../../src/room/types.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, schema, type UserName } from '../fixtures.ts';
import { SimClient, resetIds, simId, type ToServer } from './client.ts';
import { oracleViolations, changedScopes, scopeTexts, sugsOf } from './oracle.ts';
import { type Fault, MemoryStorage } from './storage.ts';

export type Op =
  | { k: 'edit'; c: number; a: number; b: number; s: string }
  | { k: 'evil'; c: number; a: number; b: number }
  | { k: 'send'; c: number }
  | { k: 'toServer'; c: number }
  | { k: 'toClient'; c: number }
  | { k: 'write'; a: number }
  | { k: 'drop'; c: number }
  | { k: 'reconnect'; c: number }
  | { k: 'grants'; a: number; b: number }
  | { k: 'crash'; a: number }
  | { k: 'tick'; a: number }
  | { k: 'snapshot'; a: number }
  /** A refreshed token changes the client's role, groups or participant roles (05 §3.1; S12 only). */
  | { k: 'refresh'; c: number; a: number };

export interface SimOptions {
  users: readonly UserName[];
  malicious: readonly UserName[];
  /** Whether the control plane restores earlier versions as snapshot commits (`snapshot` ops). */
  snapshots?: boolean;
}

interface Pipe {
  toServer: ToServer[];
  toClient: Array<{ channel: string; msg: unknown }>;
}

/** The control plane's pseudo channel for server-authored commits (04 §10). */
const CONTROL = 'control-plane';

export class Simulation {
  readonly storage: MemoryStorage;
  readonly clients: SimClient[];
  private readonly pipes: Pipe[];
  room: Room;
  private pendingWrite: WriteRequest | null = null;
  /**
   * After a failover, the old owner keeps serving the channels it had until storage fences its next
   * write or it notices it lost the document (04 §5, "When a write fails"; SYN-047 criterion 3).
   */
  private zombie: Room | null = null;
  private readonly zombieChannels = new Set<string>();
  private zombieWrite: WriteRequest | null = null;
  private readonly snapshots: boolean;
  /** A snapshot request the control plane has not had an answer to; retried on `retry`. */
  private outstanding: SnapshotRequest | null = null;
  now = 1_760_000_000_000;
  readonly events: string[] = [];
  readonly stats = {
    accepted: 0,
    rejected: new Map<string, number>(),
    crashes: 0,
    /** Writes of a crashed room that landed after the new owner's claim and were fenced. */
    fenced: 0,
    /** Old owners that stopped on their own before storage fenced them. */
    stopped: 0,
    faults: 0,
    grantChanges: 0,
    lostNotifications: 0,
    /** Step types of the commits clients submitted. */
    submittedTypes: new Map<string, number>(),
    snapshotsRequested: 0,
    snapshotAnswers: new Map<string, number>(),
    /** Stored commits checked against an approved region (PRM-047 criterion 8). */
    approvedChecked: 0,
  };

  constructor(opts: SimOptions) {
    resetIds();
    this.snapshots = opts.snapshots ?? false;
    this.storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
    this.room = this.newRoom();
    this.clients = opts.users.map((u) => new SimClient(u, USERS[u], opts.malicious.includes(u)));
    this.pipes = this.clients.map(() => ({ toServer: [], toClient: [] }));
    // Every client starts connected with the document loaded, as a session does.
    for (let i = 0; i < this.clients.length; i++) {
      this.connect(i);
      while (this.deliverToServer(i));
      while (this.deliverToClient(i));
    }
  }

  private newRoom(): Room {
    return new Room({
      schema,
      initial: this.storage.initial,
      requires: this.storage.requires,
      log: this.storage.log,
      perms: this.storage.perms,
      initialRevision: this.storage.initialRevision,
      epoch: this.storage.epoch,
      incarnation: this.storage.incarnation,
      now: () => this.now,
      ...(this.snapshots
        ? { snapshotContent: (c: SnapshotCommit) => this.storage.snapshotContent(c) }
        : {}),
    });
  }

  /**
   * The order of messages on each channel (04 §5 step 10, G5), watched as the room sends them:
   * commits and resets arrive one by one after the channel's starting point; an acknowledgement is
   * never ahead of the commits before it; a rejection's head was already delivered on that
   * channel. Every `ch.opened` names the log's incarnation (SYN-029).
   */
  private readonly delivered = new Map<string, number>();
  private readonly resumeAt = new Map<string, number>();
  readonly orderFailures: string[] = [];
  /** How many messages the order check looked at, so a run can show it was not vacuous. */
  orderChecked = 0;

  private watchOrder(channel: string, msg: Effects['send'][number]['msg']): void {
    if (channel === CONTROL) return;
    const last = this.delivered.get(channel);
    if (
      msg.t === 'sync.commit' ||
      msg.t === 'sync.ack' ||
      msg.t === 'sync.reject' ||
      msg.t === 'sync.reset'
    )
      this.orderChecked++;
    const bad = (why: string): void => void this.orderFailures.push(`${channel}: ${why}`);
    switch (msg.t) {
      case 'ch.opened':
        if (msg.incarnation !== this.storage.incarnation)
          bad(
            `ch.opened names incarnation ${msg.incarnation}, the log ${this.storage.incarnation}`,
          );
        this.delivered.set(
          channel,
          msg.catchUp === 'stream' ? (this.resumeAt.get(channel) ?? msg.head) : msg.head,
        );
        return;
      case 'sync.commit':
        if (last === undefined) return bad(`sync.commit ${msg.commit.seq} before ch.opened`);
        if (msg.commit.seq !== last + 1) bad(`sync.commit ${msg.commit.seq} after ${last}`);
        this.delivered.set(channel, msg.commit.seq);
        return;
      case 'sync.reset':
        if (last === undefined) return bad(`sync.reset ${msg.seq} before ch.opened`);
        if (msg.seq !== last + 1) bad(`sync.reset ${msg.seq} after ${last}`);
        this.delivered.set(channel, msg.seq);
        return;
      case 'sync.ack':
        if (last === undefined) return bad(`sync.ack ${msg.seq} before ch.opened`);
        // A fresh acknowledgement is the next seq; one rebuilt for a duplicate may be older.
        if (msg.seq > last + 1) bad(`sync.ack ${msg.seq} before the commits after ${last}`);
        if (msg.seq === last + 1) this.delivered.set(channel, msg.seq);
        return;
      case 'sync.reject':
        if (last !== undefined && msg.head > last)
          bad(`sync.reject with head ${msg.head} before the commits after ${last}`);
        return;
      case 'sync.caughtUp':
        if (msg.head !== last) bad(`sync.caughtUp at ${msg.head} after delivering up to ${last}`);
        return;
      default:
        return;
    }
  }

  /** The room a channel's messages reach: the old owner for the channels it still serves. */
  private roomFor(channel: string): Room {
    return this.zombie && this.zombieChannels.has(channel) ? this.zombie : this.room;
  }

  private applyFrom(room: Room, fx: Effects): void {
    if (room !== this.zombie) return this.apply(fx);
    this.apply({ send: fx.send, write: null });
    if (fx.write) {
      if (this.zombieWrite) throw new Error('the old room started a second write');
      this.zombieWrite = fx.write;
    }
  }

  /** The old owner's write reaches storage after the new owner's claim: it is fenced. */
  private fenceZombie(w: WriteRequest): void {
    const z = this.zombie!;
    this.zombie = null;
    this.zombieChannels.clear();
    this.zombieWrite = null;
    const result = this.storage.write(w, 'none');
    if (result.status === 'fenced') this.stats.fenced++;
    this.apply(z.writeCompleted(result));
  }

  /** The old owner notices it lost the document and stops (`Room.stop`). */
  private retireZombie(): void {
    if (this.zombieWrite) this.fenceZombie(this.zombieWrite);
    if (!this.zombie) return;
    const z = this.zombie;
    this.zombie = null;
    this.zombieChannels.clear();
    this.stats.stopped++;
    this.apply(z.stop());
  }

  private apply(fx: Effects): void {
    for (const o of fx.send) {
      this.watchOrder(o.channel, o.msg);
      if (o.channel === CONTROL) {
        this.controlAnswer(o.msg);
        continue;
      }
      const i = this.clients.findIndex((c) => c.channel === o.channel);
      if (i < 0) continue; // the connection is gone: the message is lost
      this.pipes[i]!.toClient.push({ channel: o.channel, msg: o.msg });
      if (o.msg.t === 'sync.reject') {
        this.stats.rejected.set(o.msg.code, (this.stats.rejected.get(o.msg.code) ?? 0) + 1);
        this.events.push(`reject ${o.channel} ${o.msg.code}/${o.msg.action}: ${o.msg.reason}`);
      }
    }
    if (fx.write) {
      if (this.pendingWrite)
        throw new Error('the room started a second write while one was in flight');
      this.pendingWrite = fx.write;
    }
  }

  /** The control plane's side of a snapshot request: done on an answer, kept for a retry. */
  private controlAnswer(msg: Effects['send'][number]['msg']): void {
    if (msg.t !== 'sync.ack' && msg.t !== 'sync.reject') return;
    const key = msg.t === 'sync.ack' ? 'ack' : `${msg.code}/${msg.action}`;
    this.stats.snapshotAnswers.set(key, (this.stats.snapshotAnswers.get(key) ?? 0) + 1);
    if (!this.outstanding || msg.id !== this.outstanding.id) return;
    if (msg.t === 'sync.ack' || msg.action !== 'retry') this.outstanding = null;
  }

  private connect(i: number): void {
    const c = this.clients[i]!;
    c.connect();
    this.pipes[i]!.toServer = [...c.outbox];
    c.outbox = [];
    this.pipes[i]!.toClient = [];
  }

  private drop(i: number): void {
    const c = this.clients[i]!;
    if (c.channel) this.roomFor(c.channel).close(c.channel);
    c.disconnected();
    this.pipes[i]!.toServer = [];
    this.pipes[i]!.toClient = [];
  }

  private flushOutbox(i: number): void {
    const c = this.clients[i]!;
    this.pipes[i]!.toServer.push(...c.outbox);
    c.outbox = [];
  }

  private deliverToServer(i: number): boolean {
    const m = this.pipes[i]!.toServer.shift();
    if (!m) return false;
    const c = this.clients[i]!;
    if (m.channel !== c.channel) return true;
    const room = this.roomFor(m.channel);
    if (m.t === 'open') {
      if (m.resume) this.resumeAt.set(m.channel, m.resume.seq);
      this.applyFrom(room, room.open(m.channel, m.conn, m.resume));
    } else {
      if (Array.isArray(m.commit.steps))
        for (const s of m.commit.steps as unknown[]) {
          const t = (s as { stepType?: unknown } | null)?.stepType;
          if (typeof t === 'string')
            this.stats.submittedTypes.set(t, (this.stats.submittedTypes.get(t) ?? 0) + 1);
        }
      this.applyFrom(room, room.submit(m.channel, m.commit));
    }
    return true;
  }

  private deliverToClient(i: number): boolean {
    const m = this.pipes[i]!.toClient.shift();
    if (!m) return false;
    const c = this.clients[i]!;
    if (m.channel !== c.channel) return true;
    c.receive(m.msg as Parameters<SimClient['receive']>[0]);
    // `catchUp: "page"`: the client reads the missing commits over REST before anything else.
    if (c.paging) c.paged(this.storage.log.filter((x): x is StoredCommit => !isSnapshot(x)));
    this.flushOutbox(i);
    if (!c.channel) {
      // The client closed the channel itself (gap, reload or ch.closed).
      this.roomFor(m.channel).close(m.channel);
      this.pipes[i]!.toServer = [];
      this.pipes[i]!.toClient = [];
    }
    return true;
  }

  private completeWrite(fault: Fault): boolean {
    const w = this.pendingWrite;
    if (!w) return false;
    this.pendingWrite = null;
    if (fault !== 'none') this.stats.faults++;
    const result = this.storage.write(w, fault);
    if (result.status === 'ok' || (result.status === 'unknown' && fault === 'unknown-applied'))
      this.stats.accepted += w.commits.length + (w.snapshot ? 1 : 0);
    this.apply(this.room.writeCompleted(result));
    return true;
  }

  private changeGrants(a: number, dropNotification: boolean): void {
    const legal = 'rLegal000000000B';
    const changes: Array<(p: PermissionState) => Omit<PermissionState, 'revision'>> = [
      // Revoke the legal group's grant, or give it back.
      (p) => ({
        ...p,
        grants: p.grants.some((g) => g.principal === 'group:legal')
          ? p.grants.filter((g) => g.principal !== 'group:legal')
          : [
              ...p.grants,
              {
                region: legal,
                principal: 'group:legal',
                role: 'editor',
                expiresAt: null,
              } as RegionGrant,
            ],
      }),
      // Grant Carol editing in the legal region for a short time.
      (p) => ({
        ...p,
        grants: [
          ...p.grants.filter((g) => g.principal !== 'user:carol'),
          { region: legal, principal: 'user:carol', role: 'editor', expiresAt: this.now + 50 },
        ],
      }),
      // Approve or reopen the terms region.
      (p) => {
        const states = new Map(p.regionStates);
        if (states.get('rTerms000000000A') === 'approved') states.delete('rTerms000000000A');
        else states.set('rTerms000000000A', 'approved');
        return { ...p, regionStates: states };
      },
      // Alice takes or releases a lease on the notes region.
      (p) => ({
        ...p,
        leases: p.leases.length
          ? []
          : [{ region: 'rNotes000000000C', holder: 'alice', expiresAt: this.now + 100 }],
      }),
      // Lock or unlock the document.
      (p) => ({ ...p, documentState: p.documentState === 'locked' ? 'active' : 'locked' }),
    ];
    const next = this.storage.changePermissions(changes[a % changes.length]!);
    this.stats.grantChanges++;
    this.events.push(`grants → r${next.revision}${dropNotification ? ' (notification lost)' : ''}`);
    if (dropNotification) this.stats.lostNotifications++;
    else this.apply(this.room.permissionsChanged(next));
  }

  private crash(a: number): void {
    this.stats.crashes++;
    this.retireZombie();
    const w = this.pendingWrite;
    this.pendingWrite = null;
    // Either the room's host died (its write, if any, lands before the new owner's claim or
    // never), or the new owner took over while the old room still runs (a partition): the old room
    // keeps serving its channels until storage fences its next write, and its clients learn of the
    // failover from its `ch.closed` (04 §5, "When a write fails").
    const partition = a % 3 === 2;
    if (w && a % 3 === 0) this.storage.write(w, 'none');
    const old = this.room;
    this.storage.claimOwnership();
    this.room = this.newRoom();
    if (partition) {
      this.zombie = old;
      for (const c of this.clients) if (c.channel) this.zombieChannels.add(c.channel);
      if (w) this.fenceZombie(w);
      return;
    }
    for (let i = 0; i < this.clients.length; i++) this.drop(i);
  }

  /** The control plane restores the version at an earlier sequence number (08 §8; SYN-005). */
  private restore(a: number): void {
    if (!this.snapshots || this.room.isStopped) return;
    if (this.outstanding) {
      this.apply(this.room.snapshot(CONTROL, this.outstanding));
      return;
    }
    const log = this.storage.log;
    const target = a % (log.length + 1);
    let doc: Node = this.storage.initial;
    for (const c of log.slice(0, target)) doc = this.replay(doc, c);
    const checkpoint = `ckpt-${this.storage.checkpoints.size + 1}`;
    this.storage.checkpoints.set(checkpoint, doc);
    this.stats.snapshotsRequested++;
    this.outstanding = {
      id: simId(),
      reason: 'restore',
      content: doc,
      checkpoint,
      as: a % 2 ? 'system' : USERS.alice,
    };
    this.apply(this.room.snapshot(CONTROL, this.outstanding));
  }

  private replay(doc: Node, c: LogCommit): Node {
    if (isSnapshot(c)) return this.storage.snapshotContent(c);
    const r = applySteps(
      doc,
      c.steps.map((s) => Step.fromJSON(schema, s)),
    );
    if (!r.ok) throw new Error(`stored commit ${c.seq} does not apply: ${r.reason}`);
    return r.value.doc;
  }

  run(ops: readonly Op[]): void {
    for (const op of ops) this.step(op);
    this.quiesce();
  }

  step(op: Op): void {
    {
      this.now += 1;
      const c = 'c' in op ? op.c % this.clients.length : 0;
      const client = this.clients[c]!;
      switch (op.k) {
        case 'edit':
          client.edit(op.a, op.b, op.a + op.b, op.s);
          break;
        case 'evil':
          if (client.evil(op.a, op.b, op.a)) this.flushOutbox(c);
          break;
        case 'send':
          if (client.trySend()) this.flushOutbox(c);
          break;
        case 'toServer':
          this.deliverToServer(c);
          break;
        case 'toClient':
          this.deliverToClient(c);
          break;
        case 'write': {
          // The old owner's write, if it made one, reaches storage too, and is fenced.
          if (this.zombieWrite && op.a % 2 === 0) {
            this.fenceZombie(this.zombieWrite);
            break;
          }
          const faults: Fault[] = [
            'none',
            'none',
            'none',
            'none',
            'fail',
            'unknown-applied',
            'unknown-lost',
          ];
          this.completeWrite(faults[op.a % faults.length]!);
          break;
        }
        case 'drop':
          this.drop(c);
          break;
        case 'reconnect':
          if (!client.channel) this.connect(c);
          break;
        case 'grants':
          this.changeGrants(op.a, op.b % 3 === 0);
          break;
        case 'crash':
          // One in four is a room crash with failover; the rest bring every client back.
          if (op.a % 4 === 0) this.crash(op.a >> 2);
          else
            for (let i = 0; i < this.clients.length; i++)
              if (!this.clients[i]!.channel) this.connect(i);
          break;
        case 'tick':
          this.now += op.a % 200;
          break;
        case 'snapshot':
          this.restore(op.a);
          break;
      }
    }
  }

  /** No more faults: reconnect, deliver, store and flush until nothing moves. */
  quiesce(maxRounds = 5000): void {
    // An old owner still running learns it lost the document: its write is fenced, or it stops.
    this.retireZombie();
    // Unlock the document so that queued work can drain; grants stay as they are.
    if (this.storage.perms.documentState !== 'active') {
      const next = this.storage.changePermissions((p) => ({ ...p, documentState: 'active' }));
      this.apply(this.room.permissionsChanged(next));
    }
    for (let round = 0; round < maxRounds; round++) {
      let moved = false;
      this.now += 1;
      if (this.outstanding && !this.pendingWrite && this.room.pendingCount === 0) {
        this.apply(this.room.snapshot(CONTROL, this.outstanding));
        moved = true;
      }
      for (let i = 0; i < this.clients.length; i++) {
        const c = this.clients[i]!;
        if (!c.channel) {
          this.connect(i);
          moved = true;
        }
        while (this.deliverToServer(i)) moved = true;
      }
      if (this.completeWrite('none')) moved = true;
      for (let i = 0; i < this.clients.length; i++) {
        while (this.deliverToClient(i)) moved = true;
        if (this.clients[i]!.trySend()) {
          this.flushOutbox(i);
          moved = true;
        }
      }
      if (!moved) return;
    }
    throw new Error(`no quiescence after ${maxRounds} rounds: a stall`);
  }

  /** Step types of the stored commits (PRM-017, SYN-047: every step type reaches the log). */
  storedTypes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const c of this.storage.log)
      for (const s of c.steps) out.set(s.stepType, (out.get(s.stepType) ?? 0) + 1);
    return out;
  }

  /** The checks of SPK-016. Returns a list of failures; empty means the run passed. */
  check(): string[] {
    const failures: string[] = [...this.orderFailures];
    const log = this.storage.log;

    // G4: each commit identifier is stored once; sequence numbers are gap-free.
    const ids = new Set<string>();
    log.forEach((c, i) => {
      if (c.seq !== i + 1) failures.push(`log gap at index ${i}: seq ${c.seq}`);
      if (ids.has(c.id)) failures.push(`commit ${c.id} stored twice (G4)`);
      ids.add(c.id);
    });

    // Replay the log: every stored step applies (the log never holds garbage).
    let doc: Node = this.storage.initial;
    const owners = new Map<string, string>();
    /** `field:<id>` scopes each commit changed, by sequence number (for P9). */
    const fieldChanges = new Map<number, string[]>();
    for (const c of log) {
      const before = doc;
      try {
        doc = this.replay(doc, c);
      } catch (e) {
        failures.push((e as Error).message);
        return failures;
      }
      // 07 §11 (PRM-047): while a region is approved, no commit, server-authored ones included,
      // changes its canonical content (field values aside), compared as serialised text.
      const statesAt = this.storage.permsHistory.get(c.revision)?.regionStates;
      for (const [region, state] of statesAt ?? []) {
        if (state !== 'approved') continue;
        this.stats.approvedChecked++;
        const b = scopeTexts(before).get(`region:${region}`);
        const a = scopeTexts(doc).get(`region:${region}`);
        if (b !== a)
          failures.push(`commit ${c.seq} changed the approved region ${region} (07 §11)`);
      }
      if (c.kind !== 'steps') continue;
      // G6: the recorded user is the user who created the commit.
      const creator = this.clients.find((cl) => cl.created.has(c.id));
      if (!creator) failures.push(`commit ${c.seq} has an id no client created`);
      else if (creator.conn.sub !== c.user)
        failures.push(
          `commit ${c.seq} recorded as ${c.user} but created by ${creator.conn.sub} (G6)`,
        );
      // The scopes recorded by the identity-pruned diff equal the oracle's serialised comparison.
      const oracleScopes = changedScopes(before, doc);
      if (oracleScopes.join(',') !== [...c.scopes].sort().join(','))
        failures.push(
          `commit ${c.seq}: recorded scopes ${c.scopes.join(',')} but the oracle finds ${oracleScopes.join(',')}`,
        );
      // The oracle: nothing outside the writable set, with the permissions of the revision it was checked against (G7).
      const perms = this.storage.permsHistory.get(c.revision);
      const user = Object.values(USERS).find((u) => u.sub === c.user);
      if (!perms || !user)
        failures.push(`commit ${c.seq}: unknown revision ${c.revision} or user ${c.user}`);
      else {
        // P9: the fields changed by commits after this commit's base, from this replay.
        const since = new Set<string>();
        if (c.base !== undefined)
          for (const [seq, fields] of fieldChanges)
            if (seq > c.base) fields.forEach((f) => since.add(f));
        for (const v of oracleViolations({
          user,
          perms,
          time: c.time,
          before,
          after: doc,
          owners,
          origin: c.origin,
          serverAuthored: c.session === 'system',
          ...(c.base !== undefined ? { fieldsChangedSinceBase: since } : {}),
        }))
          failures.push(`commit ${c.seq} by ${c.user}: ${v}`);
      }
      const fields = oracleScopes.filter((s) => s.startsWith('field:'));
      if (fields.length) fieldChanges.set(c.seq, fields);
      doc.descendants((n) => {
        for (const m of sugsOf(n))
          if (!owners.has(String(m.attrs['id'])))
            owners.set(String(m.attrs['id']), String(m.attrs['user']));
        return true;
      });
    }
    // G7 for every commit: its revision was current when it was written.
    for (let i = 1; i < log.length; i++) {
      if (log[i]!.revision < log[i - 1]!.revision)
        failures.push(
          `commit ${log[i]!.seq} was checked against an older revision than commit ${log[i - 1]!.seq}`,
        );
    }

    // The room's durable state equals storage.
    if (!this.room.document.eq(doc)) failures.push('the room document differs from the stored log');
    if (this.room.head !== log.length)
      failures.push(`room head ${this.room.head} but log length ${log.length}`);

    for (const c of this.clients) {
      // G3: every client converged to the head, with nothing unconfirmed.
      if (!c.idle)
        failures.push(
          `${c.name} is not idle after quiescence (inflight ${c.inflight?.id ?? 'none'}, queue ${c.queue.length})`,
        );
      if (c.confirmedSeq !== log.length)
        failures.push(`${c.name} confirmed seq ${c.confirmedSeq}, head ${log.length}`);
      if (!c.confirmed || !c.confirmed.eq(doc))
        failures.push(`${c.name} holds a different document (G3)`);
      if (c.visible && !c.visible.eq(doc))
        failures.push(`${c.name}'s visible document differs although nothing is unconfirmed`);
      // G2: every acknowledgement names a stored commit.
      for (const a of c.acks)
        if (log[a.seq - 1]?.id !== a.id)
          failures.push(
            `${c.name} was acknowledged ${a.id} at ${a.seq}, which the log does not hold (G2)`,
          );
      // G1: every client applied the log's commits, in the log's order.
      let last = 0;
      for (const a of c.applied) {
        const stored = log[a.seq - 1];
        if (a.id === null ? !stored || !isSnapshot(stored) : stored?.id !== a.id)
          failures.push(
            `${c.name} applied ${a.id ?? 'a reset'} at ${a.seq}, where the log holds ${stored?.id ?? 'nothing'} (G1)`,
          );
        if (a.seq <= last) failures.push(`${c.name} applied seq ${a.seq} after ${last} (G1)`);
        last = a.seq;
      }
      // SYN-029: the incarnation never changes in normal operation, failovers included.
      if (c.incarnation !== this.storage.incarnation)
        failures.push(
          `${c.name} holds incarnation ${c.incarnation}, the log ${this.storage.incarnation}`,
        );
    }
    return failures;
  }
}
