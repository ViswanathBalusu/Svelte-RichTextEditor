/**
 * The data plane (PLAN-1a packet A1; phase 1b packet A): DEP over WebSocket (05 §4, §5), the room
 * host (06 §2), sync, presence, control commits for permission changes, the commit record with its
 * hash chain (through the log store), checkpoints, snapshot commits, the outbox, node leases, the
 * audit of rejections, rate limits, send queues, metrics and traces. The composition in
 * `src/server.ts` creates it with `createDataPlane(deps)`, routes HTTP upgrades of the DEP address
 * to `handleUpgrade`, and tells it about grant and document changes (`permissionsChanged`,
 * `documentChanged`, `sessionsRevoked`). Every phase 1b port is optional in `DataPlaneDeps`: a
 * composition without it runs as in phase 1a.
 *
 * See docs/adr/0035-data-plane.md and docs/adr/0053-data-plane-phase-1b.md for the choices the
 * spec leaves open.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PermissionState } from '@docedit/authority';
import { uuid7, type JsonEnvelope } from '@docedit/model';
import type { Notification } from '@docedit/protocol';
import { WebSocketServer } from 'ws';
import type {
  CommitPage,
  ContentRead,
  CreateDataPlane,
  DataPlane,
  DataPlaneDeps,
  DataPlaneTestHooks,
  VerifiedIdentity,
} from '../seams.ts';
import type { DocRef } from '../storage/types.ts';
import { Auditor } from './audit.ts';
import { Checkpointer } from './checkpoints.ts';
import { derivedCommitId } from './commit-id.ts';
import { Faults, testHooks } from './hooks.ts';
import { NodeLease } from './lease.ts';
import { RateLimits } from './limits.ts';
import type { LiveQuotaGate } from './session.ts';
import { Metrics } from './metrics.ts';
import { OutboxDelivery } from './outbox.ts';
import { CANONICAL_LIMIT, RoomHost } from './room-host.ts';
import { Session } from './session.ts';
import { settingsFrom, type Settings } from './settings.ts';
import { Tracer, parseTraceparent } from './tracing.ts';
import { SEES_EVERYTHING, ViewTokens } from './view.ts';
import { DataPlaneError } from './wire.ts';
import { Workers } from './workers.ts';

export { DataPlaneError, Refusal, RequestRefused } from './wire.ts';
export {
  DEFAULT_FEATURES,
  DEFAULT_LIMIT_VALUES,
  DEFAULT_RATES,
  PROTOCOL_FEATURES,
  type Settings,
} from './settings.ts';
export { SEES_EVERYTHING, keyedViewToken } from './view.ts';
export { Metrics } from './metrics.ts';
export { SEQ_INPUTS, type SeqInput } from './gate.ts';
export {
  MemoryAudit,
  MemoryCheckpointIndex,
  MemoryNodeLeases,
  MemoryOutbox,
  MemoryOutboxWriter,
} from './memory-ports.ts';
export { PgAuditStore, insertAuditEvent } from './pg/audit.ts';
export { PgCheckpointIndex } from './pg/checkpoint-index.ts';
export { PgNodeLeases } from './pg/leases.ts';
export { PgOutbox, PgOutboxWriter, insertOutboxItem } from './pg/outbox.ts';

const SUBPROTOCOL = 'dep.v1';

/**
 * A session gauge per tenant (06 §11; BE-086). A session that has not said `hello` has no tenant
 * yet: its share goes to a series with the node label only. No series gets an empty or invented
 * tenant, and a group with no session has no series.
 */
function byTenant(
  sessions: Iterable<Session>,
  value: (s: Session) => number,
): Array<{ labels: Record<string, string>; value: number }> {
  const by = new Map<string | null, number>();
  for (const s of sessions) {
    const tenant = s.identity?.tenant ?? null;
    by.set(tenant, (by.get(tenant) ?? 0) + value(s));
  }
  return [...by].map(([tenant, v]) => ({ labels: tenant === null ? {} : { tenant }, value: v }));
}

/** Refuses an upgrade with a plain HTTP answer: no WebSocket, so no close code applies. */
function refuse(socket: Duplex, status: number, text: string, headers: string[] = []): void {
  socket.write(
    [
      `HTTP/1.1 ${status} ${text}`,
      'Connection: close',
      'Content-Length: 0',
      ...headers,
      '',
      '',
    ].join('\r\n'),
  );
  socket.destroy();
}

/** Shorter timers in test mode (BE-079 criterion 2), where the settings do not name them. */
function testDefaults(deps: DataPlaneDeps): DataPlaneDeps['settings'] {
  const s = deps.settings ?? {};
  if (!s.testMode) return s;
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('test mode is refused in production (BE-079)');
  return {
    roomIdleMs: 2000,
    helloTimeoutMs: 2000,
    // 05 §4: silence for two heartbeat intervals ends a connection; the kit waits for it.
    ...s,
    limits: { heartbeatMs: 2000, ...s.limits },
    lease: { durationMs: 3000, renewMs: 500, marginMs: 250, ...s.lease },
  };
}

class DepDataPlane implements DataPlane {
  readonly features: readonly string[];
  readonly settings: Settings;
  readonly metricsRegistry: Metrics;
  readonly #host: RoomHost;
  readonly #wss: WebSocketServer;
  readonly #sessions = new Set<Session>();
  readonly #deps: DataPlaneDeps;
  readonly #limits: RateLimits;
  /** The node's live-use quota gate (BE-091), or none. */
  readonly #quotas: LiveQuotaGate | undefined;
  readonly #tracer: Tracer;
  readonly #workers: Workers;
  readonly #audit: Auditor;
  readonly #faults = new Faults();
  readonly #lease: NodeLease | null;
  readonly #leaseReady: Promise<boolean>;
  readonly #outbox: OutboxDelivery | null;
  readonly #hooks: DataPlaneTestHooks | undefined;
  #closing: Promise<void> | null = null;

  constructor(deps: DataPlaneDeps) {
    this.#deps = deps;
    this.settings = settingsFrom(testDefaults(deps));
    this.features = this.settings.features;
    const s = this.settings;
    this.metricsRegistry = new Metrics(deps.node);
    this.#tracer = new Tracer(s.onSpan, deps.now);
    this.#workers = new Workers({ size: s.workers, timeoutMs: s.workerTimeoutMs });
    this.#audit = new Auditor(deps.audit, s.onError);
    this.#limits = deps.limits ?? new RateLimits(s.rates);
    this.#quotas = deps.quotas;
    this.#lease = deps.leases
      ? new NodeLease({
          // The hook that makes the database unreachable (BE-079) cuts the renewals too, so a long
          // outage ends in the node's loss of proof and in the stop of BE-018 (BE-077 criterion 4).
          store: {
            renew: (node, leaseMs) =>
              this.#faults.databaseDown
                ? Promise.reject(new Error('the database is unreachable'))
                : deps.leases!.renew(node, leaseMs),
            alive: (node) => deps.leases!.alive(node),
            release: (node) => deps.leases!.release(node),
          },
          node: deps.node,
          settings: s.lease,
          onLost: (why) => this.#host.fence(why),
          onError: s.onError,
        })
      : null;
    this.#leaseReady = this.#lease ? this.#lease.start() : Promise.resolve(true);
    const tokens = new ViewTokens(s.viewKey, deps.visibility ?? SEES_EVERYTHING);
    this.#host = new RoomHost({
      logs: deps.logs,
      ownership: deps.ownership,
      grants: deps.grants,
      documents: deps.documents,
      checkpoints: deps.checkpoints,
      node: deps.node,
      now: deps.now,
      settings: s,
      tokens,
      users: deps.users,
      checkpointer: new Checkpointer({
        store: deps.checkpoints,
        index: deps.checkpointIndex,
        workers: this.#workers,
      }),
      workers: this.#workers,
      audit: this.#audit,
      ...(deps.events ? { events: deps.events } : {}),
      metrics: this.metricsRegistry,
      tracer: this.#tracer,
      faults: this.#faults,
      lease: this.#lease,
      leases: deps.leases,
      restricted: deps.visibility !== undefined,
      ...(deps.assets ? { assets: deps.assets } : {}),
    });
    this.#outbox = deps.outbox
      ? new OutboxDelivery({
          store: deps.outbox,
          host: this.#host,
          node: deps.node,
          settings: s,
          metrics: this.metricsRegistry,
          tracer: this.#tracer,
        })
      : null;
    // Items left by a process that died are delivered by this one (BE-039 criterion 4).
    if (this.#outbox) void this.#leaseReady.then(() => this.#outbox?.start());
    this.metricsRegistry.gauge('dep_connections', 'Open DEP connections', () =>
      byTenant(this.#sessions, () => 1),
    );
    this.metricsRegistry.gauge('dep_send_queue_bytes', 'Bytes waiting in send queues', () =>
      byTenant(this.#sessions, (x) => x.queuedBytes),
    );
    this.#hooks = s.testMode
      ? testHooks({
          faults: this.#faults,
          logs: deps.logs,
          audit: deps.audit,
          now: deps.now,
          kill: async (ref) => this.#host.kill(ref),
          log: (fields) =>
            s.onError(Object.assign(new Error('test hook used'), fields), 'test-hook'),
        })
      : undefined;
    this.#wss = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      // 05 §4: compression is optional and off by default.
      perMessageDeflate: s.compression,
      maxPayload: s.maxFrameBytes,
      // UTF-8 is checked by the session, so that a bad frame closes with 4400, not 1007.
      skipUTF8Validation: true,
      handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    });
  }

  /** Resolves once the node holds its lease (at once without leases); false when it could not. */
  ready(): Promise<boolean> {
    return this.#leaseReady;
  }

  /** The rooms open on this node, for tests and operations. */
  get host(): RoomHost {
    return this.#host;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get sessions(): Session[] {
    return [...this.#sessions];
  }

  get workers(): Workers {
    return this.#workers;
  }

  get audit(): Auditor {
    return this.#audit;
  }

  get lease(): NodeLease | null {
    return this.#lease;
  }

  get outbox(): OutboxDelivery | null {
    return this.#outbox;
  }

  get hooks(): DataPlaneTestHooks | undefined {
    return this.#hooks;
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.#closing || this.#host.draining) return refuse(socket, 503, 'Service Unavailable');
    // BE-030: upgrades per address, before any token is verified.
    const address = req.socket.remoteAddress ?? 'unknown';
    const wait = this.#limits.connection(address, Date.now());
    if (wait > 0) {
      this.metricsRegistry.rateLimited.inc({ scope: 'address' });
      return refuse(socket, 429, 'Too Many Requests', [`Retry-After: ${Math.ceil(wait / 1000)}`]);
    }
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim());
    // 05 §4: the client connects with the subprotocol dep.v1 (ADR 0035: refused without it).
    if (!offered.includes(SUBPROTOCOL)) return refuse(socket, 400, 'Bad Request');
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new Session(ws, req, {
        settings: this.settings,
        verify: this.#deps.verify,
        allowedOrigins: this.#deps.allowedOrigins,
        host: this.#host,
        grants: this.#deps.grants,
        usersOnWire: this.#deps.users !== undefined,
        now: this.#deps.now,
        ended: (s) => this.#sessions.delete(s),
        limits: this.#limits,
        quotas: this.#quotas,
        metrics: this.metricsRegistry,
        tracer: this.#tracer,
        address,
      });
      this.#sessions.add(session);
      if (this.#closing) session.goaway(0);
    });
  }

  permissionsChanged(ref: DocRef, perms: PermissionState): void {
    this.#host.permissionsChanged(ref, perms);
  }

  documentChanged(ref: DocRef): void {
    void this.#host.documentChanged(ref);
  }

  sessionsRevoked(tenant: string, user: string, doc: string | null): void {
    for (const s of [...this.#sessions]) s.revoked(tenant, user, doc);
  }

  readContent(identity: VerifiedIdentity, doc: string, seq?: number): Promise<ContentRead> {
    return this.#host.readContent(identity, doc, seq);
  }

  readCommits(
    identity: VerifiedIdentity,
    doc: string,
    after: number,
    limit: number,
  ): Promise<CommitPage> {
    return this.#host.readCommits(identity, doc, after, limit);
  }

  notify(
    ref: DocRef,
    n: Notification,
    opts: { user?: string; scopes?: readonly string[] } = {},
  ): void {
    this.#host.notify(ref, n, opts.user, opts.scopes);
  }

  /**
   * `PUT /documents/{id}/content` (05 §6.2; BE-037, PRO-050): the content becomes a snapshot commit
   * with origin `import`, through the outbox when there is one (BE-039), so that a crash between
   * the request and the room cannot lose it. Open channels receive `sync.reset`.
   */
  async replaceContent(
    ref: DocRef,
    content: JsonEnvelope,
    actor: string,
    opts: {
      traceparent?: string;
      reason?: 'import' | 'restore';
      requestId?: string;
      head?: string;
    } = {},
  ): Promise<{ seq: number }> {
    if (this.#closing || this.#host.draining)
      throw new DataPlaneError('unavailable', 'the service is stopping', 1000);
    const encoded = await this.#host.encode(content);
    if (encoded.bytes > CANONICAL_LIMIT)
      throw new DataPlaneError('too_large', 'the content is larger than 16 MiB (I7)');
    // The commit identifier is derived from the request, so a retry is one commit (BE-039 criterion 1;
    // SYN-030 criterion 3; ADR 0377, proposed). The caller's own request identifier names it (an
    // import job); otherwise the head the caller authorised the change against and the hash of the
    // content do (PUT /content with its If-Match, a restore at its head): the same replacement of the
    // same head is the same request, and a later one, made after the head moved, is another. Only a
    // caller with neither gets a random identifier.
    const id =
      opts.requestId !== undefined
        ? derivedCommitId(opts.reason ?? 'import', ref.tenant, ref.doc, actor, opts.requestId)
        : opts.head !== undefined
          ? derivedCommitId(
              opts.reason ?? 'import',
              ref.tenant,
              ref.doc,
              actor,
              `head:${opts.head}`,
              encoded.hash,
            )
          : uuid7();
    const trace = parseTraceparent(opts.traceparent);
    // HIS-019 criterion 1: a whole-document restore is a snapshot commit with reason `restore`.
    const reason = opts.reason ?? 'import';
    if (this.#outbox && this.#deps.outbox) {
      const item = await this.#deps.outbox.enqueue({
        tenant: ref.tenant,
        doc: ref.doc,
        commitId: id,
        kind: 'snapshot',
        request: {
          reason,
          actor,
          ...(opts.traceparent !== undefined && trace ? { traceparent: opts.traceparent } : {}),
        },
        payload: encoded.encoded,
      });
      const out = await this.#outbox.outcome(item, this.settings.drainTimeoutMs * 3);
      if (out.state === 'done') return { seq: out.seq };
      throw new DataPlaneError(
        out.code as DataPlaneError['code'],
        out.message,
        out.code === 'unavailable' ? 1000 : undefined,
      );
    }
    return this.#host.apply(ref, {
      kind: 'snapshot',
      id,
      reason,
      actor,
      content: { envelope: content, ...encoded },
      trace,
    });
  }

  metrics(): string {
    return this.metricsRegistry.text();
  }

  /**
   * Drains the node (06 §2.2 step 5; BE-022): no new connections or channels; commits in flight
   * are written and answered; rooms with changes are checkpointed; then every connection gets
   * `goaway` with a jittered hint and 4503, and ownership is released, so another node can take
   * the documents without waiting for a lease to expire.
   */
  drain(reason = 'the service is restarting'): Promise<void> {
    this.#closing ??= (async () => {
      for (const s of this.#sessions) s.draining();
      await this.#host.drain(this.settings.drainTimeoutMs);
      for (const s of [...this.#sessions]) s.goaway(1000 + Math.floor(Math.random() * 4000));
      await this.#host.close(reason);
      await this.#outbox?.stop();
      await this.#audit.flush();
      await this.#lease?.stop(true);
      await this.#workers.close();
      await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    })();
    return this.#closing;
  }

  close(): Promise<void> {
    return this.drain('the service is stopping');
  }
}

export const createDataPlane: CreateDataPlane = (deps) => new DepDataPlane(deps);

/** The data plane with what tests and operations read from it. */
export type DepDataPlaneInstance = DepDataPlane;
export function createDepDataPlane(deps: DataPlaneDeps): DepDataPlane {
  return new DepDataPlane(deps);
}
