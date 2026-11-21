/**
 * The S12 simulation (SPK-029): the S3 schedule with a projection gateway between the room and the
 * clients. One region is confidential and one field value is sensitive; both carry unique
 * "TOPSECRET" markers. Checks: every client converges to the projection of the head for its view,
 * no message ever carries a marker to a client that may not read it, and the permission oracle of
 * S3 holds on the full log. The region's text marker counts as a secret until a stored version holds
 * it outside the region (`markerIsPublic`).
 */
import { canonicalize } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import { Step, Transform } from 'prosemirror-transform';
import type { Connection, PermissionState, RegionGrant } from '../../src/permissions/model.ts';
import { type Visibility, ProjectionGateway } from '../../src/projection/gateway.ts';
import { type HiddenSet, project, projectionSchema } from '../../src/projection/projection.ts';
import { applySteps } from '../../src/rebase.ts';
import { Room, type SnapshotRequest } from '../../src/room/room.ts';
import {
  type Effects,
  type LogCommit,
  type SnapshotCommit,
  type WriteRequest,
  isSnapshot,
} from '../../src/room/types.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, schema, type UserName } from '../fixtures.ts';
import { SimClient, resetIds, simId, type ToServer } from './client.ts';
import type { Op } from './sim.ts';
import { oracleViolations, sugsOf } from './oracle.ts';
import { type Fault, MemoryStorage } from './storage.ts';

/** The control plane's pseudo channel for server-authored commits (04 §10). */
const CONTROL = 'control-plane';

export const LEGAL = 'rLegal000000000B';
export const INCOME = 'fIncomeSecret001';
export const SECRET_REGION = 'TOPSECRET-LEGAL';
export const SECRET_TITLE = 'TOPSECRET-TITLE';
export const SECRET_VALUE = 'TOPSECRET-VALUE';

/** The base document with a confidential region and a sensitive field in the body. */
export function secretDoc(): Node {
  const json = structuredClone(BASE_JSON) as unknown as {
    content: Array<{ type: string; content: Array<Record<string, unknown>> }>;
  };
  const body = json.content[1]!.content;
  for (const block of body) {
    if (block['type'] === 'region' && (block['attrs'] as Record<string, unknown>)['id'] === LEGAL) {
      (block['attrs'] as Record<string, unknown>)['title'] = SECRET_TITLE;
      (block['content'] as Array<Record<string, unknown>>).push({
        type: 'paragraph',
        attrs: { id: 'pSecret00000001B' },
        content: [{ type: 'text', text: `The ${SECRET_REGION} clause.` }],
      });
    }
  }
  body.splice(1, 0, {
    type: 'paragraph',
    attrs: { id: 'pIncome00000001X' },
    content: [
      { type: 'text', text: 'Income: ' },
      {
        type: 'form_field',
        attrs: {
          id: INCOME,
          key: 'tenant.income',
          kind: 'text',
          label: 'Income',
          assignee: 'role_tenant',
          sensitive: true,
          value: `${SECRET_VALUE}-0`,
        },
      },
    ],
  });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

/** Independent of the gateway: who may read the confidential region and the sensitive value. */
export function canReadRegion(conn: Connection, perms: PermissionState, now: number): boolean {
  if (conn.role === 'owner') return true;
  return perms.grants.some(
    (g) =>
      g.region === LEGAL &&
      (g.expiresAt === null || now < g.expiresAt) &&
      (g.principal === `user:${conn.sub}` ||
        (g.principal.startsWith('group:') && conn.groups.includes(g.principal.slice(6))) ||
        g.principal === 'everyone'),
  );
}
export function canReadValue(conn: Connection): boolean {
  return conn.role === 'owner' || conn.participantRoles.includes('role_tenant');
}

/**
 * Whether the confidential region's marker stands in text that is not in that region: in a
 * paragraph everyone reads, or in what was the region's content once the region itself is gone.
 * Independent of the gateway: it reads a document, not a projection.
 */
export function markerOutsideRegion(doc: Node): boolean {
  let found = false;
  doc.descendants((n) => {
    if (found || (n.type.name === 'region' && n.attrs['id'] === LEGAL)) return false;
    if (n.isTextblock && n.textContent.includes(SECRET_REGION)) found = true;
    return !found;
  });
  return found;
}

export class ProjectionSim {
  readonly storage: MemoryStorage;
  readonly clients: SimClient[];
  private readonly pipes: Array<{
    toServer: ToServer[];
    toClient: Array<{ channel: string; msg: unknown }>;
  }>;
  room!: Room;
  gateway!: ProjectionGateway;
  private pendingWrite: WriteRequest | null = null;
  /** A snapshot request the control plane has not had an answer to. */
  private outstanding: SnapshotRequest | null = null;
  now = 1_760_000_000_000;
  readonly leaks: string[] = [];
  readonly stats = {
    stored: 0,
    reloads: 0,
    rejected: new Map<string, number>(),
    leakChecks: 0,
    secretsSent: 0,
    /** Secrets sent under the room's permissions to a reader whom the stored permissions no longer allow (the room had not yet learnt of the change). */
    staleReads: 0,
    /** Hidden-region content in a commit broadcast, as opposed to a content read on open. */
    staleInCommits: 0,
    /** Readers closed because their visibility class changed (SYN-053). */
    accessClosed: 0,
    /** Snapshot resets delivered, and those whose content was a projection. */
    resets: 0,
    /** How the gateways routed the steps of stored commits, summed over failovers (SYN-051). */
    routes: { mapped: 0, noop: 0, inside: 0, value: 0, diff: 0 },
    empty: 0,
    /** Refreshed tokens, and the `perm.changed` messages the room sent for them. */
    refreshes: 0,
    permChanged: 0,
    /** 1 when a stored version held the region's marker outside the region (see `markerIsPublic`). */
    declassified: 0,
  };
  readonly pschema = projectionSchema();
  /** The stored log replayed so far, independently of the room and the gateway. */
  private replayed: { seq: number; doc: Node } | null = null;
  /**
   * Whether a stored version has held the confidential region's marker outside the region. The
   * marker is a secret only as long as it has stood nowhere else, and two things the room rightly
   * stores put it elsewhere. A user who may edit the region and the body removes the region and
   * keeps its paragraphs, which are then body text. And a client that may read the region re-applies
   * its unconfirmed typing by position after a snapshot reset (04 §8), on content that is laid out
   * differently, so that the typing lands in another paragraph; the room cannot know where a client
   * meant its text to go. From then on a message that carries the marker is no leak by the room or
   * the gateway, and the simulation stops counting it as one for the rest of the run. Both findings
   * are recorded in ADR 0423.
   */
  private markerIsPublic = false;

  private readonly visibility: Visibility = (conn, _doc, perms) => ({
    regions: canReadRegion(conn, perms, this.now) ? new Set() : new Set([LEGAL]),
    values: canReadValue(conn) ? new Set() : new Set([INCOME]),
    titles: false,
  });

  constructor(users: readonly UserName[], malicious: readonly UserName[]) {
    resetIds();
    this.storage = new MemoryStorage(secretDoc(), REQUIRES, basePermissions());
    this.boot();
    this.clients = users.map(
      (u) => new SimClient(u, USERS[u], malicious.includes(u), this.pschema),
    );
    this.pipes = this.clients.map(() => ({ toServer: [], toClient: [] }));
    for (let i = 0; i < this.clients.length; i++) {
      this.connect(i);
      while (this.deliverToServer(i));
      while (this.deliverToClient(i));
    }
  }

  private boot(): void {
    if (this.gateway) this.collectRoutes();
    const resolve = (c: SnapshotCommit) => this.storage.snapshotContent(c);
    this.room = new Room({
      schema,
      initial: this.storage.initial,
      requires: this.storage.requires,
      log: this.storage.log,
      perms: this.storage.perms,
      initialRevision: this.storage.initialRevision,
      epoch: this.storage.epoch,
      incarnation: this.storage.incarnation,
      now: () => this.now,
      snapshotContent: resolve,
    });
    this.gateway = new ProjectionGateway(this.room, schema, this.visibility, this.pschema, {
      initial: this.storage.initial,
      log: this.storage.log,
      resolve,
    });
  }

  /** Adds the gateway's routing counts to the totals and checks its projections. */
  private collectRoutes(): void {
    for (const k of ['mapped', 'noop', 'inside', 'value', 'diff'] as const)
      this.stats.routes[k] += this.gateway.stats.routes[k];
    this.stats.empty += this.gateway.stats.empty;
    for (const m of this.gateway.audit()) this.leaks.push(`gateway audit: ${m}`);
  }

  hiddenFor(conn: Connection): HiddenSet {
    return this.visibility(conn, this.gateway.fullHead, this.room.permissions);
  }

  /** The head of the stored log, replayed here and not asked of the room or the gateway. */
  private storedHead(): Node {
    let at = this.replayed ?? { seq: 0, doc: this.storage.initial };
    try {
      for (const c of this.storage.log.slice(at.seq))
        at = { seq: at.seq + 1, doc: this.replay(at.doc, c) };
    } catch {
      // A stored commit that does not apply is reported by `check`; the replay stops before it.
    }
    this.replayed = at;
    return at.doc;
  }

  private apply(fx: Effects): void {
    if (!this.markerIsPublic && fx.send.length > 0 && markerOutsideRegion(this.storedHead())) {
      this.markerIsPublic = true;
      this.stats.declassified = 1;
    }
    for (const o of fx.send) {
      if (o.channel === CONTROL) {
        // The control plane's answer to a snapshot request: done, or kept for a retry.
        const m = o.msg;
        if (
          (m.t === 'sync.ack' || m.t === 'sync.reject') &&
          m.id === this.outstanding?.id &&
          (m.t === 'sync.ack' || m.action !== 'retry')
        )
          this.outstanding = null;
        continue;
      }
      if (o.msg.t === 'ch.closed' && o.msg.reason === 'access_changed') this.stats.accessClosed++;
      if (o.msg.t === 'perm.changed') this.stats.permChanged++;
      const i = this.clients.findIndex((c) => c.channel === o.channel);
      if (i < 0) continue;
      if (o.msg.t === 'sync.reset') this.stats.resets++;
      const c = this.clients[i]!;
      // The leak oracle: what this client may read now, derived independently of the gateway.
      const text = JSON.stringify(o.msg);
      this.stats.leakChecks++;
      const readsRegion = canReadRegion(c.conn, this.room.permissions, this.now);
      const readsValue = canReadValue(c.conn);
      // The region's title is never anywhere but on the region. Its text marker is a secret until a
      // stored version holds it outside the region (`markerIsPublic`).
      if (
        !readsRegion &&
        (text.includes(SECRET_TITLE) || (!this.markerIsPublic && text.includes(SECRET_REGION)))
      )
        this.leaks.push(`${c.name} received hidden region content in ${o.msg.t}`);
      if (!readsValue && text.includes(SECRET_VALUE))
        this.leaks.push(`${c.name} received a hidden value in ${o.msg.t}`);
      if (text.includes('TOPSECRET')) this.stats.secretsSent++;
      // The window of stale read permissions: the room allowed it, the stored grants no longer do.
      if (
        readsRegion &&
        !canReadRegion(c.conn, this.storage.perms, this.now) &&
        (text.includes(SECRET_REGION) || text.includes(SECRET_TITLE))
      ) {
        this.stats.staleReads++;
        if (o.msg.t !== 'ch.opened') this.stats.staleInCommits++;
      }
      this.pipes[i]!.toClient.push({ channel: o.channel, msg: o.msg });
      if (o.msg.t === 'sync.reject')
        this.stats.rejected.set(o.msg.code, (this.stats.rejected.get(o.msg.code) ?? 0) + 1);
      if (o.msg.t === 'ch.opened' && o.msg.catchUp === 'reload') this.stats.reloads++;
    }
    if (fx.write) {
      if (this.pendingWrite) throw new Error('second write in flight');
      this.pendingWrite = fx.write;
    }
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
    if (c.channel) this.gateway.close(c.channel);
    c.disconnected();
    this.pipes[i]!.toServer = [];
    this.pipes[i]!.toClient = [];
  }

  private deliverToServer(i: number): boolean {
    const m = this.pipes[i]!.toServer.shift();
    if (!m) return false;
    const c = this.clients[i]!;
    if (m.channel !== c.channel) return true;
    // Content reads check the grants revision in storage (ADR 0019 change 3; SYN-053): the host
    // passes the stored permission state with every open.
    if (m.t === 'open')
      this.apply(this.gateway.open(m.channel, m.conn, m.resume, this.storage.perms));
    else this.apply(this.gateway.submit(m.channel, m.commit));
    return true;
  }

  private deliverToClient(i: number): boolean {
    const m = this.pipes[i]!.toClient.shift();
    if (!m) return false;
    const c = this.clients[i]!;
    if (m.channel !== c.channel) return true;
    c.receive(m.msg as Parameters<SimClient['receive']>[0]);
    this.pipes[i]!.toServer.push(...c.outbox);
    c.outbox = [];
    if (!c.channel) {
      this.gateway.close(m.channel);
      this.pipes[i]!.toServer = [];
      this.pipes[i]!.toClient = [];
    }
    return true;
  }

  private completeWrite(fault: Fault): boolean {
    const w = this.pendingWrite;
    if (!w) return false;
    this.pendingWrite = null;
    const result = this.storage.write(w, fault);
    this.apply(this.gateway.writeCompleted(result));
    return true;
  }

  /** A client that can read the confidential region types a secret marker inside it. */
  private secretEdit(i: number): void {
    const c = this.clients[i]!;
    if (!c.visible || !canReadRegion(c.conn, this.room.permissions, this.now)) return;
    let at = -1;
    c.visible.descendants((n, pos) => {
      if (at < 0 && n.type.name === 'paragraph' && n.attrs['id'] === 'pSecret00000001B')
        at = pos + 1;
      return at < 0;
    });
    if (at < 0) return;
    const tr = new Transform(c.visible).insert(at, c.schema.text(` ${SECRET_REGION} `));
    c.queue.push(...tr.steps);
    c.visible = tr.doc;
  }

  /** The participant who may read the sensitive value fills it with a secret marker. */
  private secretFill(i: number, n: number): void {
    const c = this.clients[i]!;
    if (!c.visible || !canReadValue(c.conn)) return;
    let at = -1;
    c.visible.descendants((node, pos) => {
      if (node.type.name === 'form_field' && node.attrs['id'] === INCOME) at = pos;
      return at < 0;
    });
    if (at < 0) return;
    const tr = new Transform(c.visible).setNodeAttribute(at, 'value', `${SECRET_VALUE}-${n}`);
    c.queue.push(...tr.steps);
    c.visible = tr.doc;
  }

  /** Each user's connection from a server time on, as refreshed tokens changed it. */
  private readonly connHistory = new Map<string, Array<{ from: number; conn: Connection }>>();

  /** The connection a user's commits were checked with at `time`. */
  userAt(sub: string, time: number): Connection {
    const history = this.connHistory.get(sub) ?? [];
    let conn: Connection = Object.values(USERS).find((u) => u.sub === sub)!;
    for (const h of history) if (h.from <= time) conn = h.conn;
    return conn;
  }

  /**
   * A refreshed token (05 §3.1): the same user with another role, other groups or other workflow
   * roles. The room swaps the channel's connection and sends `perm.changed`; the gateway closes
   * the channel only when the reader's visibility class changed (SYN-053).
   */
  private refreshToken(i: number, a: number): void {
    const c = this.clients[i]!;
    const base: Connection = Object.values(USERS).find((u) => u.sub === c.conn.sub)!;
    const variants: Connection[] = [
      base,
      { ...base, groups: c.conn.groups.includes('legal') ? [] : ['legal'] },
      { ...base, role: c.conn.role === 'viewer' ? 'commenter' : 'viewer' },
      { ...base, role: c.conn.role === 'editor' ? 'suggester' : 'editor' },
      {
        ...base,
        participantRoles: c.conn.participantRoles.includes('role_tenant') ? [] : ['role_tenant'],
        participantActive: true,
      },
    ];
    const next = variants[a % variants.length]!;
    c.conn = next;
    const history = this.connHistory.get(next.sub) ?? [];
    history.push({ from: this.now, conn: next });
    this.connHistory.set(next.sub, history);
    this.stats.refreshes++;
    // The session's token is replaced: an open still on its way is served under the new one.
    for (const m of this.pipes[i]!.toServer) if (m.t === 'open') m.conn = next;
    if (c.channel) this.apply(this.gateway.refresh(c.channel, next));
  }

  private toggleLegalGrant(dropNotification: boolean): void {
    const next = this.storage.changePermissions((p) => ({
      ...p,
      grants: p.grants.some((g) => g.principal === 'group:legal')
        ? p.grants.filter((g) => g.principal !== 'group:legal')
        : [
            ...p.grants,
            {
              region: LEGAL,
              principal: 'group:legal',
              role: 'editor',
              expiresAt: null,
            } as RegionGrant,
          ],
    }));
    if (!dropNotification) this.apply(this.gateway.permissionsChanged(next));
  }

  private crash(): void {
    this.pendingWrite = null;
    this.storage.claimOwnership();
    for (let i = 0; i < this.clients.length; i++) this.drop(i);
    this.boot();
  }

  /**
   * The control plane restores an earlier version as a snapshot commit (SYN-005): every reader must
   * receive the projection of the restored content, never the content itself.
   */
  private restore(a: number): void {
    if (this.outstanding) {
      this.apply(this.gateway.snapshot(CONTROL, this.outstanding));
      return;
    }
    const log = this.storage.log;
    const target = a % (log.length + 1);
    let doc: Node = this.storage.initial;
    for (const c of log.slice(0, target)) doc = this.replay(doc, c);
    const checkpoint = `ckpt-${this.storage.checkpoints.size + 1}`;
    this.storage.checkpoints.set(checkpoint, doc);
    this.outstanding = {
      id: simId(),
      reason: 'restore',
      content: doc,
      checkpoint,
      as: 'system',
    };
    this.apply(this.gateway.snapshot(CONTROL, this.outstanding));
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

  step(op: Op): void {
    this.now += 1;
    const c = 'c' in op ? op.c % this.clients.length : 0;
    const client = this.clients[c]!;
    switch (op.k) {
      case 'edit':
        if (op.a % 7 === 0) this.secretEdit(c);
        else if (op.a % 7 === 1) this.secretFill(c, op.b);
        else client.edit(op.a, op.b, op.a + op.b, op.s);
        break;
      case 'evil':
        if (client.evil(op.a, op.b, op.a)) {
          this.pipes[c]!.toServer.push(...client.outbox);
          client.outbox = [];
        }
        break;
      case 'send':
        if (client.trySend()) {
          this.pipes[c]!.toServer.push(...client.outbox);
          client.outbox = [];
        }
        break;
      case 'toServer':
        this.deliverToServer(c);
        break;
      case 'toClient':
        this.deliverToClient(c);
        break;
      case 'write':
        this.completeWrite(
          (['none', 'none', 'none', 'fail', 'unknown-applied', 'unknown-lost'] as Fault[])[
            op.a % 6
          ]!,
        );
        break;
      case 'drop':
        this.drop(c);
        break;
      case 'reconnect':
        if (!client.channel) this.connect(c);
        break;
      case 'grants':
        this.toggleLegalGrant(op.b % 3 === 0);
        break;
      case 'crash':
        if (op.a % 4 === 0) this.crash();
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
      case 'refresh':
        this.refreshToken(c, op.a);
        break;
    }
  }

  quiesce(maxRounds = 5000): void {
    for (let round = 0; round < maxRounds; round++) {
      let moved = false;
      this.now += 1;
      if (this.outstanding && !this.pendingWrite && this.room.pendingCount === 0) {
        this.apply(this.gateway.snapshot(CONTROL, this.outstanding));
        moved = true;
      }
      for (let i = 0; i < this.clients.length; i++) {
        if (!this.clients[i]!.channel) {
          this.connect(i);
          moved = true;
        }
        while (this.deliverToServer(i)) moved = true;
      }
      if (this.completeWrite('none')) moved = true;
      for (let i = 0; i < this.clients.length; i++) {
        while (this.deliverToClient(i)) moved = true;
        const cl = this.clients[i]!;
        if (cl.trySend()) {
          this.pipes[i]!.toServer.push(...cl.outbox);
          cl.outbox = [];
          moved = true;
        }
      }
      if (!moved) return;
    }
    throw new Error('no quiescence: a stall');
  }

  check(): string[] {
    // The steps every class received give exactly the projection of each version (SYN-051).
    this.collectRoutes();
    const failures = [...this.leaks];
    const log = this.storage.log;
    let doc = this.storage.initial;
    const owners = new Map<string, string>();
    for (const c of log) {
      const before = doc;
      try {
        doc = this.replay(doc, c);
      } catch {
        return [...failures, `stored commit ${c.seq} does not apply`];
      }
      this.stats.stored++;
      if (c.kind !== 'steps') continue;
      const perms = this.storage.permsHistory.get(c.revision)!;
      const user = this.userAt(c.user, c.time);
      for (const v of oracleViolations({
        user,
        perms,
        time: c.time,
        before,
        after: doc,
        owners,
        origin: c.origin,
        serverAuthored: c.session === 'system',
      }))
        failures.push(`commit ${c.seq} by ${c.user}: ${v}`);
      // The oracle's own index of suggestion identifiers: the user each first named (03 §5).
      doc.descendants((n) => {
        for (const m of sugsOf(n))
          if (!owners.has(String(m.attrs['id'])))
            owners.set(String(m.attrs['id']), String(m.attrs['user']));
        return true;
      });
    }
    if (!this.gateway.fullHead.eq(doc)) failures.push('the gateway lost track of the log');
    for (const c of this.clients) {
      if (!c.idle)
        failures.push(
          `${c.name} is not idle (inflight ${c.inflight?.id ?? 'none'}, queue ${c.queue.length})`,
        );
      if (c.confirmedSeq !== log.length)
        failures.push(`${c.name} at ${c.confirmedSeq}, head ${log.length}`);
      const expected = project(doc, this.hiddenFor(c.conn), this.pschema).doc;
      if (!c.confirmed || canonicalize(c.confirmed.toJSON()) !== canonicalize(expected.toJSON()))
        failures.push(`${c.name} does not hold the projection of the head for its view`);
    }
    return failures;
  }
}
