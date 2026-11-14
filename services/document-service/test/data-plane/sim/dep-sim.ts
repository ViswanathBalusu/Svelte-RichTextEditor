/**
 * The S3 simulation against the data plane (SYN-047; packages/authority/test/harness/sim.ts). The
 * operations, the reference clients (`SimClient`) and the permission oracle are the harness's; what
 * changes is everything between a client and storage. Every client speaks DEP over a real
 * WebSocket to `createDataPlane`, which runs the room behind the projection gateway over the real
 * stores, through the DEP bridge, the room host and its write pipeline.
 *
 * The schedule keeps control of timing as in the harness:
 * - `toServer` sends one queued client message as a DEP frame; `toClient` hands one received DEP
 *   message to the client, translated back into the room's in-process form, which the reference
 *   client reads (content for a reload comes from a content read, as over REST);
 * - every log write is held until a `write` operation completes it, with the harness's faults
 *   applied to the real write;
 * - after every operation the driver waits until the server has handled everything it was sent
 *   and every client has received everything the server sent (a `ping` on every connection);
 * - a failover starts a new node over the same storage. As in the harness, the old node's
 *   pending write lands or never happens and every client is dropped; in a third case the new
 *   node takes ownership while the old node keeps its clients, so that the old node's next write
 *   meets the epoch check for real (an epoch conflict, SYN-047 criterion 3). An old node that
 *   never writes again stops when the run quiesces, as its node lease would make it (BE-018).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applySteps,
  parseSteps,
  type Access,
  type PermissionState,
  type LogCommit,
  type RegionGrant,
  type WriteRequest,
  type WriteResult,
} from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import {
  SimClient,
  resetIds,
  type ToServer,
} from '../../../../../packages/authority/test/harness/client.ts';
import {
  changedScopes,
  oracleViolations,
} from '../../../../../packages/authority/test/harness/oracle.ts';
import type { Op } from '../../../../../packages/authority/test/harness/sim.ts';
import {
  BASE_JSON,
  REQUIRES,
  USERS,
  basePermissions,
  schema,
  type UserName,
} from '../../../../../packages/authority/test/fixtures.ts';
import { createDepDataPlane, type DepDataPlaneInstance } from '../../../src/data-plane/index.ts';
import { diffPermissions } from '../../../src/storage/grant-store.ts';
import type {
  CheckpointStore,
  DocRef,
  DocumentStore,
  GrantStore,
  LogStore,
  OwnershipStore,
} from '../../../src/storage/types.ts';
import { DepClient, type Received } from '../client.ts';
import { MemoryCheckpoints, Tokens } from '../support.ts';

export type Fault = 'none' | 'fail' | 'unknown-applied' | 'unknown-lost';
export type FailPoint = 'before-insert' | 'before-commit';

/** The stores of a run, and how a fault of the simulation is applied to a real write. */
export interface SimStores {
  logs: LogStore;
  ownership: OwnershipStore;
  grants: GrantStore;
  documents: DocumentStore;
  writeWithFault(
    ref: DocRef,
    req: WriteRequest,
    fault: Fault,
    failAt: FailPoint,
  ): Promise<WriteResult>;
}

type Node = ReturnType<typeof schema.nodeFromJSON>;

/** A DEP payload as the driver reads it: members of any shape (the codec checked them). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A node's log store: every write waits for the schedule; a dead node's writes fail. */
class Gate implements LogStore {
  readonly #stores: SimStores;
  pending: { ref: DocRef; req: WriteRequest; resolve: (r: WriteResult) => void } | null = null;
  dead = false;
  readonly violations: string[] = [];

  constructor(stores: SimStores) {
    this.#stores = stores;
  }

  append(ref: DocRef, req: WriteRequest): Promise<WriteResult> {
    if (this.dead) return Promise.resolve({ status: 'failed' });
    if (this.pending) {
      this.violations.push('the room started a second write while one was in flight');
      return Promise.resolve({ status: 'failed' });
    }
    return new Promise((resolve) => {
      this.pending = { ref, req, resolve };
    });
  }

  /** Completes the held write with a fault; false when none is held. */
  async complete(fault: Fault): Promise<WriteResult | null> {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    // Alternate the point at which a failed write is rolled back, as the PostgreSQL bridge does.
    const failAt: FailPoint = p.req.fromSeq % 2 === 0 ? 'before-insert' : 'before-commit';
    const r = await this.#stores.writeWithFault(p.ref, p.req, fault, failAt);
    p.resolve(r);
    await new Promise((resolve) => setImmediate(resolve));
    return r;
  }

  /** The node is gone: its held write never completes for it, and nothing more is written. */
  kill(): void {
    this.dead = true;
    const p = this.pending;
    this.pending = null;
    p?.resolve({ status: 'failed' });
  }

  read(ref: DocRef, fromSeq?: number, toSeq?: number): Promise<LogCommit[]> {
    return this.#stores.logs.read(ref, fromSeq, toSeq);
  }

  head(ref: DocRef): ReturnType<LogStore['head']> {
    return this.#stores.logs.head(ref);
  }
}

interface PlaneNode {
  name: string;
  plane: DepDataPlaneInstance;
  server: Server;
  url: string;
  gate: Gate;
}

/** A client's current connection to a node, for one channel of the reference client. */
interface Link {
  ws: DepClient;
  node: PlaneNode;
  channel: string;
  token: string;
  /** DEP messages received and not yet handed to the client. */
  inbound: Received[];
  /** Envelope id of each submit, to its commit id. */
  submits: Map<string, string>;
  /** Order checking (04 §5 step 10, G5), as the harness does on the room's output. */
  delivered: number | undefined;
  resumeAt: number | undefined;
  pings: number;
}

const SIM_MESSAGES = new Set([
  'ch.opened',
  'ch.closed',
  'sync.commit',
  'sync.ack',
  'sync.reject',
  'sync.caughtUp',
  'perm.changed',
  'error',
]);

/** The DEP access object as the room's in-process `Access`, for the reference client's guard. */
function roomAccess(d: Json): Access {
  const scopes = d['scopes'] as Record<string, string[]>;
  const regions = new Map<string, Set<string>>();
  for (const [k, v] of Object.entries(scopes))
    if (k.startsWith('region:')) regions.set(k.slice(7), new Set(v));
  return {
    revision: d['rev'],
    at: 0,
    docRole: new Set(d['caps']),
    body: new Set(scopes['body'] ?? []),
    structureScopes: new Set(scopes['doc'] ?? []),
    regions,
    // DEP: a region not listed is not editable until an access lists it (05 §5.5).
    newRegion: new Set(['view']),
    fill: {
      roles: d['fill']?.roles ?? [],
      active: d['fill']?.active ?? false,
      allowed: d['fill'] !== null,
      participant: d['fill']?.participant ?? null,
    },
    granted: new Set(),
  } as unknown as Access;
}

export interface SimOptions {
  users: readonly UserName[];
  malicious: readonly UserName[];
  stores: SimStores;
  tenant: string;
}

export class DepSimulation {
  readonly clients: SimClient[];
  readonly stats = {
    faults: 0,
    crashes: 0,
    splitBrains: 0,
    grantChanges: 0,
    lostNotifications: 0,
    rejected: new Map<string, number>(),
    writes: 0,
    /** Writes the store refused because another node holds the epoch (BE-017). */
    fenced: 0,
  };
  now = 1_760_000_000_000;
  orderChecked = 0;
  readonly orderFailures: string[] = [];
  /** Diagnostics: every message sent and received, when set. */
  trace: ((line: string) => void) | undefined;
  readonly errors: unknown[] = [];
  readonly doc: string;
  readonly ref: DocRef;
  readonly #stores: SimStores;
  readonly #tokens: Tokens;
  readonly #checkpoints: CheckpointStore;
  readonly #nodes: PlaneNode[] = [];
  #current!: PlaneNode;
  readonly #links: Array<Link | null>;
  readonly #toServer: ToServer[][];
  #nodeCount = 0;
  #pingCount = 0;

  private constructor(opts: SimOptions, doc: string, checkpoints: CheckpointStore) {
    resetIds();
    this.#stores = opts.stores;
    this.doc = doc;
    this.ref = { tenant: opts.tenant, doc };
    this.#checkpoints = checkpoints;
    this.#tokens = new Tokens(opts.tenant, () => this.now);
    this.clients = opts.users.map((u) => new SimClient(u, USERS[u], opts.malicious.includes(u)));
    this.#links = this.clients.map(() => null);
    this.#toServer = this.clients.map(() => []);
  }

  static async create(opts: SimOptions): Promise<DepSimulation> {
    const id = uuid7();
    const checkpoints = new MemoryCheckpoints();
    await opts.stores.documents.create(opts.tenant, {
      id,
      cdmVersion: 1,
      requires: REQUIRES,
      createdBy: 'sim',
      permissions: basePermissions(),
    });
    await checkpoints.put({ tenant: opts.tenant, doc: id }, 0, {
      cdm: 1,
      requires: [...REQUIRES],
      doc: BASE_JSON as JsonEnvelope['doc'],
    });
    const sim = new DepSimulation(opts, id, checkpoints);
    await sim.#startNode();
    // Every client starts connected with the document loaded, as a session does.
    for (let i = 0; i < sim.clients.length; i++) {
      sim.#connect(i);
      while (await sim.#deliverToServer(i));
      while (await sim.#deliverToClient(i));
    }
    return sim;
  }

  // --- Nodes ------------------------------------------------------------------------------------

  async #startNode(): Promise<PlaneNode> {
    const gate = new Gate(this.#stores);
    const name = `sim-node-${++this.#nodeCount}`;
    const plane = createDepDataPlane({
      logs: gate,
      ownership: this.#stores.ownership,
      grants: this.#stores.grants,
      documents: this.#stores.documents,
      checkpoints: this.#checkpoints,
      verify: this.#tokens.verify,
      node: name,
      now: () => this.now,
      settings: {
        // The schedule drives the clock; expiries are found at every check of access.
        expiryTimers: false,
        // Checkpoints and replays run inline: a node per crash would otherwise start a thread.
        workers: 0,
        onError: (e) => this.errors.push(e),
      },
    });
    const server = createServer((_q, s) => s.end());
    server.on('upgrade', (req, socket, head) => plane.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const node: PlaneNode = {
      name,
      plane,
      server,
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/dep`,
      gate,
    };
    this.#nodes.push(node);
    this.#current = node;
    return node;
  }

  // --- Clients ----------------------------------------------------------------------------------

  #connect(i: number): void {
    const c = this.clients[i]!;
    this.#unlink(i);
    c.connect();
    this.#toServer[i] = [...c.outbox];
    c.outbox = [];
  }

  #unlink(i: number): void {
    const l = this.#links[i];
    if (!l) return;
    l.ws.terminate();
    this.#links[i] = null;
  }

  async #drop(i: number): Promise<void> {
    const node = this.#links[i]?.node;
    this.#unlink(i);
    this.clients[i]!.disconnected();
    this.#toServer[i] = [];
    if (node) await this.#gone(node);
  }

  /** Waits until a node has seen every closed connection go (its rooms closed the channels). */
  async #gone(node: PlaneNode): Promise<void> {
    const live = () => this.#links.filter((l) => l?.node === node).length;
    const deadline = Date.now() + 5000;
    while (node.plane.sessionCount > live()) {
      if (Date.now() > deadline) throw new Error('a closed connection was never noticed');
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  #flushOutbox(i: number): void {
    const c = this.clients[i]!;
    this.#toServer[i]!.push(...c.outbox);
    c.outbox = [];
  }

  #watch(l: Link, m: Received): void {
    if (m.t === 'sync.commit' || m.t === 'sync.ack' || m.t === 'sync.reject') this.orderChecked++;
    const bad = (why: string): void => void this.orderFailures.push(`${l.channel}: ${why}`);
    const d = m.d ?? {};
    switch (m.t) {
      case 'ch.opened':
        l.delivered = d['catchUp'] === 'stream' ? (l.resumeAt ?? d['head']) : d['head'];
        return;
      case 'sync.commit':
        for (const c of d['commits'] as Array<{ seq: number }>) {
          if (l.delivered === undefined) return bad(`sync.commit ${c.seq} before ch.opened`);
          if (c.seq !== l.delivered + 1) bad(`sync.commit ${c.seq} after ${l.delivered}`);
          l.delivered = c.seq;
        }
        return;
      case 'sync.ack': {
        if (l.delivered === undefined) return bad(`sync.ack ${d['seq']} before ch.opened`);
        if (d['seq'] > l.delivered + 1)
          bad(`sync.ack ${d['seq']} before the commits after ${l.delivered}`);
        if (d['seq'] === l.delivered + 1) l.delivered = d['seq'];
        return;
      }
      case 'sync.reject':
        if (l.delivered !== undefined && d['head'] > l.delivered)
          bad(`sync.reject with head ${d['head']} before the commits after ${l.delivered}`);
        this.stats.rejected.set(d['code'], (this.stats.rejected.get(d['code']) ?? 0) + 1);
        return;
      case 'sync.caughtUp':
        if (d['seq'] !== l.delivered)
          bad(`sync.caughtUp at ${d['seq']} after delivering up to ${l.delivered}`);
        return;
      default:
        return;
    }
  }

  async #deliverToServer(i: number): Promise<boolean> {
    const m = this.#toServer[i]!.shift();
    if (!m) return false;
    const c = this.clients[i]!;
    if (m.channel !== c.channel) return true;
    if (m.t === 'open') {
      this.#unlink(i);
      const u = c.name as UserName;
      const token = this.#tokens.issue({
        user: u,
        docs: { [this.doc]: USERS[u].role },
        groups: USERS[u].groups,
      });
      const node = this.#current;
      const ws = await DepClient.connect(node.url);
      const l: Link = {
        ws,
        node,
        channel: m.channel,
        token,
        inbound: [],
        submits: new Map(),
        delivered: undefined,
        resumeAt: m.resume?.seq,
        pings: 0,
      };
      ws.onMessage = (msg) => {
        if (!SIM_MESSAGES.has(msg.t) || this.#links[i] !== l) return;
        if (msg.t === 'error' && !(msg.re && l.submits.has(msg.re))) return;
        this.trace?.(`  <- ${c.name} ${msg.t} ${JSON.stringify(msg.d).slice(0, 300)}`);
        this.#watch(l, msg);
        l.inbound.push(msg);
      };
      const w = await ws.hello(token);
      if (w.t !== 'welcome') throw new Error(`hello refused: ${JSON.stringify(w.d)}`);
      this.#links[i] = l;
      const r = m.resume;
      ws.send({
        t: 'ch.open',
        id: ws.nextId(),
        ch: 1,
        d: {
          kind: 'doc',
          doc: this.doc,
          engine: 'pm-steps/1',
          cdm: 1,
          features: ['fields', 'regions'],
          ...(r
            ? {
                resume: {
                  seq: r.seq,
                  incarnation: r.incarnation,
                  ...(r.inflight !== null ? { inflight: r.inflight } : {}),
                  ...(r.view !== undefined ? { view: r.view } : {}),
                },
              }
            : {}),
        },
      });
    } else {
      const l = this.#links[i];
      if (!l) return true;
      const envelope = l.ws.nextId();
      const commit = m.commit as { id: unknown; base: unknown; steps: unknown; origin?: unknown };
      if (typeof commit.id === 'string') l.submits.set(envelope, commit.id);
      this.trace?.(
        `  -> ${c.name} submit ${String(commit.id).slice(-4)} base ${String(commit.base)}`,
      );
      l.ws.send({ t: 'sync.submit', id: envelope, ch: 1, d: commit });
    }
    await this.#settle();
    return true;
  }

  /**
   * Every connection: a `ping`, answered once the server has handled what came before. And every
   * live node whose room asked for a write that waits for its backoff: until the write is held.
   */
  async #settle(): Promise<void> {
    await this.#pingAll();
    for (const node of this.#nodes) {
      if (node.gate.dead) continue;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const room = node.plane.host.get(this.ref);
        if (!room || !room.writing || node.gate.pending) break;
        if (Date.now() > deadline) throw new Error('a write never reached the store');
        await new Promise((r) => setTimeout(r, 2));
      }
    }
  }

  async #pingAll(): Promise<void> {
    const links = this.#links.filter((l): l is Link => l !== null);
    await Promise.all(
      links.map(async (l) => {
        if (l.ws.closeInfo) return;
        const id = `sim-ping-${++this.#pingCount}`;
        l.ws.send({ t: 'ping', id });
        await l.ws
          .take((m) => m.t === 'pong' && m.re === id, 10_000, 'pong')
          .catch((e: unknown) => {
            if (!l.ws.closeInfo) throw e;
          });
      }),
    );
  }

  async #toInProcess(l: Link, m: Received): Promise<unknown[]> {
    const d = (m.d ?? {}) as Json;
    switch (m.t) {
      case 'ch.opened': {
        const msg: Record<string, unknown> = {
          t: 'ch.opened',
          head: d['head'],
          incarnation: d['incarnation'],
          catchUp: d['catchUp'] === 'stream' ? 'stream' : 'reload',
          inflight: d['inflight'] ?? null,
          access: roomAccess(d['access']),
          view: d['view'],
        };
        if (d['catchUp'] !== 'stream') {
          // 05 §5.2: on reload the client reads the content at `head` (REST in a deployment).
          const content = await l.node.plane.readContent(
            this.#tokens.identity(l.token),
            this.doc,
            d['head'],
          );
          msg['content'] = { seq: content.seq, doc: content.doc, requires: content.requires };
          msg['view'] = content.view;
        }
        return [msg];
      }
      case 'sync.commit':
        return (d['commits'] as Json[]).map((c) => ({
          t: 'sync.commit',
          commit: { ...c, user: c['author'].user, time: Date.parse(c['serverTime']) },
        }));
      case 'sync.ack':
        return [{ ...d, t: 'sync.ack', time: Date.parse(d['serverTime']) }];
      case 'sync.reject':
        return [{ ...d, t: 'sync.reject', reason: d['message'] }];
      case 'sync.caughtUp':
        return [{ t: 'sync.caughtUp', head: d['seq'] }];
      case 'perm.changed':
        return [{ t: 'perm.changed', revision: d['rev'], access: roomAccess(d) }];
      case 'ch.closed':
        return [{ t: 'ch.closed', code: 'unavailable' }];
      case 'error': {
        // A submit the codec refused (an empty or malformed commit): for the client, a drop.
        const id = l.submits.get(m.re!);
        return [
          {
            t: 'sync.reject',
            id,
            code: 'invalid_op',
            action: 'drop',
            head: l.delivered ?? 0,
            reason: d['message'],
          },
        ];
      }
      default:
        return [];
    }
  }

  async #deliverToClient(i: number): Promise<boolean> {
    const l = this.#links[i];
    const c = this.clients[i]!;
    if (!l) return false;
    const m = l.inbound.shift();
    if (!m) return false;
    if (l.channel !== c.channel) return true;
    for (const x of await this.#toInProcess(l, m)) {
      c.receive(x as Parameters<SimClient['receive']>[0]);
      if (!c.channel) break;
    }
    this.#flushOutbox(i);
    if (!c.channel) {
      // The client closed the channel itself (gap, reload or ch.closed).
      this.#unlink(i);
      this.#toServer[i] = [];
      await this.#gone(l.node);
    }
    return true;
  }

  // --- Storage and the control plane ------------------------------------------------------------

  /** Completes the oldest held write of any node; old nodes first (split brain). */
  async #completeWrite(fault: Fault): Promise<boolean> {
    for (const node of this.#nodes) {
      if (!node.gate.pending) continue;
      if (fault !== 'none') this.stats.faults++;
      this.stats.writes++;
      const r = await node.gate.complete(fault);
      if (r?.status === 'fenced') this.stats.fenced++;
      await this.#settle();
      return true;
    }
    return false;
  }

  async #changeGrants(a: number, dropNotification: boolean): Promise<void> {
    const legal = 'rLegal000000000B';
    const now = this.now;
    const changes: Array<(p: PermissionState) => Omit<PermissionState, 'revision'>> = [
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
      (p) => ({
        ...p,
        grants: [
          ...p.grants.filter((g) => g.principal !== 'user:carol'),
          { region: legal, principal: 'user:carol', role: 'editor', expiresAt: now + 50 },
        ],
      }),
      (p) => {
        const states = new Map(p.regionStates);
        if (states.get('rTerms000000000A') === 'approved') states.delete('rTerms000000000A');
        else states.set('rTerms000000000A', 'approved');
        return { ...p, regionStates: states };
      },
      (p) => ({
        ...p,
        leases: p.leases.length
          ? []
          : [{ region: 'rNotes000000000C', holder: 'alice', expiresAt: now + 100 }],
      }),
      (p) => ({ ...p, documentState: p.documentState === 'locked' ? 'active' : 'locked' }),
    ];
    const g = this.#stores.grants;
    const current = await g.current(this.ref);
    const change = diffPermissions(current, changes[a % changes.length]!(current));
    // The control plane refuses grants, states and leases on retired regions (BE-010).
    const retired = new Set(await g.retired(this.ref));
    if (change.putGrants) change.putGrants = change.putGrants.filter((x) => !retired.has(x.region));
    if (change.setRegionStates)
      change.setRegionStates = change.setRegionStates.filter((x) => !retired.has(x.region));
    if (change.putLeases) change.putLeases = change.putLeases.filter((x) => !retired.has(x.region));
    const next = await g.change(this.ref, change, { actor: 'sim' });
    this.stats.grantChanges++;
    if (dropNotification) this.stats.lostNotifications++;
    else this.#current.plane.permissionsChanged(this.ref, next);
    await this.#settle();
  }

  async #crash(a: number): Promise<void> {
    this.stats.crashes++;
    const old = this.#current;
    const variant = a % 3;
    if (variant === 2) {
      // Split brain: a new node takes ownership; the old one keeps its clients until its next
      // write meets the epoch check and it closes their channels (BE-017).
      this.stats.splitBrains++;
      await this.#startNode();
      await this.#stores.ownership.claim(this.ref, this.#current.name);
      return;
    }
    // A write already sent may still land, or never happen; then every client is dropped.
    for (let i = 0; i < this.clients.length; i++) {
      this.#unlink(i);
      this.clients[i]!.disconnected();
      this.#toServer[i] = [];
    }
    if (old.gate.pending && variant === 0) await old.gate.complete('none');
    old.gate.kill();
    await this.#startNode();
  }

  // --- The schedule -----------------------------------------------------------------------------

  async run(ops: readonly Op[]): Promise<void> {
    for (const op of ops) await this.step(op);
    await this.quiesce();
  }

  async step(op: Op): Promise<void> {
    this.now += 1;
    const c = 'c' in op ? op.c % this.clients.length : 0;
    const client = this.clients[c]!;
    switch (op.k) {
      case 'edit':
        client.edit(op.a, op.b, op.a + op.b, op.s);
        break;
      case 'evil':
        if (client.evil(op.a, op.b, op.a)) this.#flushOutbox(c);
        break;
      case 'send':
        if (client.trySend()) this.#flushOutbox(c);
        break;
      case 'toServer':
        await this.#deliverToServer(c);
        break;
      case 'toClient':
        await this.#deliverToClient(c);
        break;
      case 'write': {
        const faults: Fault[] = [
          'none',
          'none',
          'none',
          'none',
          'fail',
          'unknown-applied',
          'unknown-lost',
        ];
        await this.#completeWrite(faults[op.a % faults.length]!);
        break;
      }
      case 'drop':
        await this.#drop(c);
        break;
      case 'reconnect':
        if (!client.channel) this.#connect(c);
        break;
      case 'grants':
        await this.#changeGrants(op.a, op.b % 3 === 0);
        break;
      case 'crash':
        // One in four is a failover; the rest bring every client back.
        if (op.a % 4 === 0) await this.#crash(op.a >> 2);
        else
          for (let i = 0; i < this.clients.length; i++)
            if (!this.clients[i]!.channel) this.#connect(i);
        break;
      case 'tick':
        this.now += op.a % 200;
        break;
    }
  }

  /** No more faults: reconnect, deliver, store and flush until nothing moves. */
  async quiesce(maxRounds = 5000): Promise<void> {
    // A node that lost ownership in a split brain and never wrote again still serves its clients
    // a frozen document. Its node lease would make it stop serving (06 §2.1, §8; BE-018), which
    // this harness has no clock for: it stops now, and its clients reconnect to the owner.
    for (const node of this.#nodes) {
      if (node === this.#current || node.gate.dead) continue;
      node.gate.kill();
      await new Promise((r) => setImmediate(r));
      node.plane.host.fence('the node lost its lease');
      await node.plane.host.close('the node lost its lease');
      await this.#pingAll();
    }
    const perms = await this.#stores.grants.current(this.ref);
    if (perms.documentState !== 'active') {
      const next = await this.#stores.grants.change(
        this.ref,
        { documentState: 'active' },
        { actor: 'sim' },
      );
      this.#current.plane.permissionsChanged(this.ref, next);
      await this.#settle();
    }
    for (let round = 0; round < maxRounds; round++) {
      let moved = false;
      this.now += 1;
      for (let i = 0; i < this.clients.length; i++) {
        if (!this.clients[i]!.channel) {
          this.#connect(i);
          moved = true;
        }
        while (await this.#deliverToServer(i)) moved = true;
      }
      if (await this.#completeWrite('none')) moved = true;
      for (let i = 0; i < this.clients.length; i++) {
        while (await this.#deliverToClient(i)) moved = true;
        if (this.clients[i]!.trySend()) {
          this.#flushOutbox(i);
          moved = true;
        }
      }
      if (!moved) return;
    }
    throw new Error(`no quiescence after ${maxRounds} rounds: a stall`);
  }

  /** The checks of the harness (SPK-016), on the real log. Empty means the run passed. */
  async check(): Promise<string[]> {
    const failures: string[] = [...this.orderFailures];
    for (const n of this.#nodes) failures.push(...n.gate.violations);
    for (const e of this.errors)
      failures.push(`server error: ${e instanceof Error ? e.message : String(e)}`);
    const log = await this.#stores.logs.read(this.ref);
    const history = new Map(
      (await this.#stores.grants.history(this.ref)).map((p) => [p.revision, p]),
    );
    const ids = new Set<string>();
    log.forEach((c, i) => {
      if (c.seq !== i + 1) failures.push(`log gap at index ${i}: seq ${c.seq}`);
      if (ids.has(c.id)) failures.push(`commit ${c.id} stored twice (G4)`);
      ids.add(c.id);
    });
    let doc: Node = schema.nodeFromJSON(BASE_JSON);
    const owners = new Map<string, string>();
    for (const c of log) {
      const before = doc;
      const steps = parseSteps(schema, c.steps, {
        maxStepsPerCommit: 1e9,
        maxCommitBytes: 1e12,
        maxRebaseSteps: 1e9,
      });
      if (c.kind === 'steps' && !steps.ok) {
        failures.push(`stored commit ${c.seq} does not parse`);
        return failures;
      }
      if (steps.ok) {
        const r = applySteps(doc, steps.value);
        if (!r.ok) {
          failures.push(`stored commit ${c.seq} does not apply: ${r.reason}`);
          return failures;
        }
        doc = r.value.doc;
      }
      if (c.kind !== 'steps') continue;
      const creator = this.clients.find((cl) => cl.created.has(c.id));
      if (!creator) failures.push(`commit ${c.seq} has an id no client created`);
      else if (creator.conn.sub !== c.user)
        failures.push(
          `commit ${c.seq} recorded as ${c.user} but created by ${creator.conn.sub} (G6)`,
        );
      const oracleScopes = changedScopes(before, doc);
      if (oracleScopes.join(',') !== [...c.scopes].sort().join(','))
        failures.push(
          `commit ${c.seq}: recorded scopes ${c.scopes.join(',')} but the oracle finds ${oracleScopes.join(',')}`,
        );
      const perms = history.get(c.revision);
      const user = Object.values(USERS).find((u) => u.sub === c.user);
      if (!perms || !user)
        failures.push(`commit ${c.seq}: unknown revision ${c.revision} or user ${c.user}`);
      else
        for (const v of oracleViolations({ user, perms, time: c.time, before, after: doc, owners }))
          failures.push(`commit ${c.seq} by ${c.user}: ${v}`);
      doc.descendants((n) => {
        for (const m of n.marks)
          if (['ins', 'del', 'fmt'].includes(m.type.name) && !owners.has(String(m.attrs['id'])))
            owners.set(String(m.attrs['id']), String(m.attrs['user']));
        return true;
      });
    }
    for (let i = 1; i < log.length; i++)
      if (log[i]!.revision < log[i - 1]!.revision)
        failures.push(
          `commit ${log[i]!.seq} was checked against an older revision than commit ${log[i - 1]!.seq}`,
        );
    // The serving room's durable state equals storage.
    const room = this.#current.plane.host.get(this.ref);
    if (room && room.head !== log.length)
      failures.push(`room head ${room.head} but log length ${log.length}`);
    const content = await this.#current.plane.readContent(
      this.#tokens.identity(this.#tokens.issue({ user: 'alice', docs: { [this.doc]: 'owner' } })),
      this.doc,
    );
    if (JSON.stringify(content.doc) !== JSON.stringify(doc.toJSON()))
      failures.push('the content served differs from the stored log');
    // G3, G2: every client converged to the head, with nothing unconfirmed; every ack is stored.
    for (const c of this.clients) {
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
      for (const a of c.acks)
        if (log[a.seq - 1]?.id !== a.id)
          failures.push(
            `${c.name} was acknowledged ${a.id} at ${a.seq}, which the log does not hold (G2)`,
          );
    }
    return failures;
  }

  /** The stored log, for the totals. */
  log(): Promise<LogCommit[]> {
    return this.#stores.logs.read(this.ref);
  }

  async dispose(): Promise<void> {
    for (let i = 0; i < this.#links.length; i++) this.#unlink(i);
    for (const n of this.#nodes) n.gate.kill();
    for (const n of this.#nodes) {
      await n.plane.close();
      await new Promise<void>((resolve) => n.server.close(() => resolve()));
    }
  }
}
