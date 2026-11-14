/**
 * Control-plane reads served from read replicas (BE-064; 06 §6 PostgreSQL row, "plus read replicas
 * for the control API"). Read-only routes (lists, pinned content, history reads) try the replica
 * first. The rules this module holds:
 *
 * - A read goes to the replica only when the replica can answer it correctly. A pinned read names a
 *   sequence number; a replica that has not applied it yet is skipped, and the primary answers.
 * - A write followed by a read in the same session waits for the replica: a read whose documents
 *   the session wrote is served from the primary unless the replica has reached those writes.
 * - A replica that returns nothing for a read it was asked (the row is not there yet) or fails
 *   sends the read to the primary, so the answer is the primary's answer.
 * - Replica lag is reported per tenant when metrics are scraped (BE-064 criterion 4). Labels carry
 *   the tenant and the route codes only, never a document identifier.
 *
 * The module is transport-free: the composition gives it a store for each side and two sequence
 * lookups. It does not know whether the replica is PostgreSQL, a standby or a cache.
 */
import type { DocRef, DocumentStore, LogStore } from '../storage/types.ts';
import type { ContentReader } from './content.ts';
import type { Metrics } from './metrics.ts';

/** The writes one client session made, so that its later reads can wait for them. */
export class ReadSession {
  readonly #writes = new Map<string, Map<string, number>>();

  /** Records a write this session made to a document, at the sequence number it was stored at. */
  wrote(tenant: string, doc: string, seq: number): void {
    let docs = this.#writes.get(tenant);
    if (!docs) this.#writes.set(tenant, (docs = new Map()));
    docs.set(doc, Math.max(seq, docs.get(doc) ?? -1));
  }

  /** The writes of a tenant (one document when `doc` is given). */
  writesIn(tenant: string, doc?: string): Array<{ doc: string; seq: number }> {
    const docs = this.#writes.get(tenant);
    if (!docs) return [];
    return [...docs.entries()]
      .filter(([d]) => doc === undefined || d === doc)
      .map(([d, seq]) => ({ doc: d, seq }));
  }

  /** Forgets a write the replica has reached: later reads need not wait for it. */
  reached(tenant: string, doc: string, applied: number): void {
    const docs = this.#writes.get(tenant);
    const seq = docs?.get(doc);
    if (seq === undefined || applied < seq) return;
    docs!.delete(doc);
    if (docs!.size === 0) this.#writes.delete(tenant);
  }

  /** Whether the session has no write the replica may still lack. */
  get empty(): boolean {
    return this.#writes.size === 0;
  }
}

/**
 * The sessions of REST callers (BE-064 criterion 3). REST has no session of its own, so a session is
 * one credential acting for one actor: the same caller sees its own writes. A session is kept only
 * while it holds a write the replica has not reached, and at most `maxSessions` of them (a setting;
 * beyond it the least recently used is dropped, so its later reads may meet a replica that lags).
 * Kept in the process: a caller whose requests reach another process has another session.
 */
export class ReadSessions {
  readonly #max: number;
  readonly #sessions = new Map<string, ReadSession>();

  constructor(maxSessions: number) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1)
      throw new RangeError('maxSessions must be a positive integer');
    this.#max = maxSessions;
  }

  /** The number of sessions held (for tests). */
  get size(): number {
    return this.#sessions.size;
  }

  /** The session of a caller, made when it writes. */
  of(key: string): ReadSession {
    let s = this.#sessions.get(key);
    if (s) this.#sessions.delete(key);
    else s = new ReadSession();
    this.#sessions.set(key, s);
    while (this.#sessions.size > this.#max) {
      const oldest = this.#sessions.keys().next().value as string;
      this.#sessions.delete(oldest);
    }
    return s;
  }

  /** The session of a caller when it has writes to wait for, else undefined. */
  find(key: string): ReadSession | undefined {
    const s = this.#sessions.get(key);
    if (s?.empty) {
      this.#sessions.delete(key);
      return undefined;
    }
    return s;
  }
}

/** The stores one side of a routed control-plane read uses: the primary's or the replica's. */
export interface ReadStores {
  documents: Pick<DocumentStore, 'list'>;
  content: Pick<ContentReader, 'read'>;
}

/** The newest `seq` a log store holds for a document, or null when it holds none. */
export async function headSeq(logs: Pick<LogStore, 'head'>, ref: DocRef): Promise<number | null> {
  try {
    return (await logs.head(ref)).seq;
  } catch {
    return null;
  }
}

/** What the router needs from the replica side. */
export interface ReplicaPort<S> {
  /** The store that answers reads from the replica. */
  readonly store: S;
  /** The newest sequence number the replica has applied for the document, or null when it has none. */
  appliedSeq(tenant: string, doc: string): Promise<number | null>;
  /** The newest sequence number the primary holds for the document, or null when unknown. */
  primarySeq(tenant: string, doc: string): Promise<number | null>;
}

export type ReadKind = 'list' | 'pinned' | 'history';

export interface ReadRequest {
  readonly kind: ReadKind;
  readonly tenant: string;
  /** The document read; absent for a list of the tenant's documents. */
  readonly doc?: string;
  /** The sequence number a pinned read asks for. */
  readonly seq?: number;
  /** The client session the read belongs to, for read-your-writes. */
  readonly session?: ReadSession;
}

export type RouteReason =
  'no-replica' | 'replica' | 'behind-pin' | 'behind-write' | 'replica-missing' | 'replica-error';

export interface RouteResult<R> {
  readonly value: R;
  readonly from: 'replica' | 'primary';
  readonly reason: RouteReason;
}

export interface ReadRouterOptions<S> {
  primary: S;
  replica?: ReplicaPort<S>;
  /** Where the route counters and the lag gauge are registered (optional). */
  metrics?: Metrics;
  /**
   * The most documents whose replica lag is sampled again at each metrics scrape (BE-064 criterion
   * 4). The documents are those read on the replica, most recent first kept. A setting with no
   * default, because the spec gives none. Absent: nothing is sampled at a scrape.
   */
  lagDocuments?: number;
}

const ROUTE_COUNTER = 'docedit_read_route_total';
const LAG_GAUGE = 'docedit_replica_lag_seq';

export class ReadRouter<S> {
  readonly #o: ReadRouterOptions<S>;
  /** The latest lag observed per tenant and document (kept in memory; never exported by name). */
  readonly #lag = new Map<string, Map<string, number>>();
  readonly routes: Partial<Record<RouteReason, number>> = {};
  /** The documents read on the replica, least recent first, for the sampling at a scrape. */
  readonly #recent = new Map<string, { tenant: string; doc: string }>();

  constructor(options: ReadRouterOptions<S>) {
    this.#o = options;
    const m = options.metrics;
    if (m) {
      m.gauge(
        LAG_GAUGE,
        'Sequence numbers the replica is behind the primary, the largest per tenant (BE-064).',
        async () => {
          await this.#sampleRecent();
          return this.lagSamples();
        },
      );
    }
  }

  /** Remembers a document read on the replica, and forgets the least recent beyond the limit. */
  #remember(tenant: string, doc: string): void {
    const limit = this.#o.lagDocuments;
    if (limit === undefined || limit < 1 || this.#o.replica === undefined) return;
    const key = JSON.stringify([tenant, doc]);
    this.#recent.delete(key);
    this.#recent.set(key, { tenant, doc });
    while (this.#recent.size > limit) {
      const oldest = this.#recent.keys().next().value as string;
      const gone = this.#recent.get(oldest);
      this.#recent.delete(oldest);
      if (gone) this.#lag.get(gone.tenant)?.delete(gone.doc);
    }
  }

  /** Samples the lag of every remembered document again, for a metrics scrape. */
  async #sampleRecent(): Promise<void> {
    for (const { tenant, doc } of [...this.#recent.values()]) {
      try {
        await this.observeLag(tenant, doc);
      } catch {
        // A document whose lag cannot be read keeps its last sample; the scrape goes on.
      }
    }
  }

  /** The primary's store: a caller compares with it to run its own primary read. */
  get primary(): S {
    return this.#o.primary;
  }

  /** The largest observed lag per tenant, for the gauge. */
  lagSamples(): Array<{ labels: Record<string, string>; value: number }> {
    return [...this.#lag.entries()].map(([tenant, docs]) => ({
      labels: { tenant },
      value: Math.max(0, ...docs.values()),
    }));
  }

  /** Records how far the replica is behind for one document (called by the composition's sampler). */
  async observeLag(tenant: string, doc: string): Promise<number | null> {
    const r = this.#o.replica;
    if (!r) return null;
    const [applied, primary] = await Promise.all([
      r.appliedSeq(tenant, doc),
      r.primarySeq(tenant, doc),
    ]);
    if (applied === null || primary === null) return null;
    const lag = Math.max(0, primary - applied);
    let docs = this.#lag.get(tenant);
    if (!docs) this.#lag.set(tenant, (docs = new Map()));
    docs.set(doc, lag);
    return lag;
  }

  /**
   * Runs a read on the replica when it can answer correctly, else on the primary. `run` returns the
   * answer, or null when the store has no such row. Null from the primary is the answer "not found".
   */
  async read<R>(
    req: ReadRequest,
    run: (store: S) => Promise<R | null>,
  ): Promise<RouteResult<R> | null> {
    const replica = this.#o.replica;
    if (!replica) return this.#primary(run, 'no-replica');
    if (req.doc !== undefined) this.#remember(req.tenant, req.doc);

    const reason = await this.#replicaRefusal(replica, req);
    if (reason) return this.#primary(run, reason);

    let value: R | null;
    try {
      value = await run(replica.store);
    } catch {
      return this.#primary(run, 'replica-error');
    }
    if (value === null) return this.#primary(run, 'replica-missing');
    this.#count('replica');
    return { value, from: 'replica', reason: 'replica' };
  }

  /** Why the replica may not answer this read, or undefined when it may. */
  async #replicaRefusal(
    replica: ReplicaPort<S>,
    req: ReadRequest,
  ): Promise<RouteReason | undefined> {
    if (req.kind === 'pinned' || req.kind === 'history') {
      if (req.seq !== undefined && req.doc !== undefined) {
        const applied = await replica.appliedSeq(req.tenant, req.doc);
        if (applied === null || applied < req.seq) return 'behind-pin';
      }
    }
    const writes = req.session?.writesIn(req.tenant, req.doc) ?? [];
    for (const w of writes) {
      const applied = await replica.appliedSeq(req.tenant, w.doc);
      if (applied === null || applied < w.seq) return 'behind-write';
      req.session?.reached(req.tenant, w.doc, applied);
    }
    return undefined;
  }

  async #primary<R>(
    run: (store: S) => Promise<R | null>,
    reason: RouteReason,
  ): Promise<RouteResult<R> | null> {
    this.#count(reason);
    const value = await run(this.#o.primary);
    if (value === null) return null;
    return { value, from: 'primary', reason };
  }

  #count(reason: RouteReason): void {
    this.routes[reason] = (this.routes[reason] ?? 0) + 1;
    const route = reason === 'replica' ? 'replica' : 'primary';
    this.#o.metrics?.inc(ROUTE_COUNTER, 'Control-plane reads by the store that answered them.', {
      route,
      reason,
    });
  }
}
