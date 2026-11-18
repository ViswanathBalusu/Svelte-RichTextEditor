/**
 * Tenants spread over several PostgreSQL shards (BE-070; 06 §6; ADR 0006). Each tenant is assigned
 * to one shard by an explicit map, and all of its tables live on that shard. This module holds the
 * rules for the job queue path and for any transaction that names several tenants:
 *
 * - A call that names a tenant goes to that tenant's shard and to no other. A tenant the map does
 *   not know is refused before any shard is touched; there is no default shard, because a default
 *   would quietly send a tenant's data to the wrong place.
 * - A job reference names its tenant, so heartbeats, completions and failures go to the same shard
 *   that created the job.
 * - `claim` is not a tenant call: it asks the shards in turn, starting after the shard that gave
 *   the last job, so no shard starves. The highest-priority-first rule of the single queue (ADR 0054)
 *   holds within a shard only. Across shards a lower-priority job on an earlier shard can start
 *   before a higher-priority job on a later one. This is a known consequence, not a measured one.
 * - `depth` is the sum over the shards, because it reports the whole queue (BE-050 criterion 5).
 * - A transaction that names several tenants runs only when they share one shard
 *   (`assertSingleShard`), because a commit transaction must never span shards.
 *
 * The shards are `JobQueue` values; the composition gives each one its own PostgreSQL pool
 * (`PgJobQueue`) or, in tests, an in-memory queue. Nothing here opens a connection.
 */
import type {
  ClaimOptions,
  Heartbeat,
  JobError,
  JobQueue,
  JobRecord,
  JobRef,
  NewJob,
  QueueDepth,
} from './queue.ts';

/** A tenant that the map does not place on any shard. */
export class UnknownTenantShard extends Error {
  constructor(tenant: string) {
    super(`no shard is assigned to tenant ${tenant}`);
    this.name = 'UnknownTenantShard';
  }
}

/** A transaction named tenants on more than one shard, which the design never allows. */
export class CrossShardError extends Error {
  constructor(shards: readonly string[]) {
    super(`a transaction would span shards: ${shards.join(', ')}`);
    this.name = 'CrossShardError';
  }
}

/** The explicit tenant-to-shard map. Shard names are the keys the composition uses for its pools. */
export class ShardMap {
  readonly #shards: readonly string[];
  readonly #byTenant: ReadonlyMap<string, string>;

  constructor(shards: readonly string[], assignments: Readonly<Record<string, string>>) {
    if (shards.length === 0) throw new RangeError('a shard map needs at least one shard');
    if (new Set(shards).size !== shards.length) throw new RangeError('shard names are unique');
    const known = new Set(shards);
    const byTenant = new Map<string, string>();
    for (const [tenant, shard] of Object.entries(assignments)) {
      if (!known.has(shard))
        throw new RangeError(`tenant ${tenant} is assigned to an unknown shard`);
      byTenant.set(tenant, shard);
    }
    this.#shards = [...shards];
    this.#byTenant = byTenant;
  }

  /** The shards, in the order given. */
  get shards(): readonly string[] {
    return this.#shards;
  }

  /** The shard that holds all of a tenant's tables. Throws for a tenant the map does not know. */
  shardOf(tenant: string): string {
    const shard = this.#byTenant.get(tenant);
    if (shard === undefined) throw new UnknownTenantShard(tenant);
    return shard;
  }
}

/**
 * The one shard that holds every tenant named, for a transaction over several tenants. Throws
 * `CrossShardError` when they are on different shards, and a RangeError for an empty list, because
 * a transaction with no tenant has no shard to run on.
 */
export function assertSingleShard(map: ShardMap, tenants: readonly string[]): string {
  if (tenants.length === 0) throw new RangeError('a transaction names at least one tenant');
  const shards = new Set(tenants.map((t) => map.shardOf(t)));
  if (shards.size !== 1) throw new CrossShardError([...shards]);
  return [...shards][0]!;
}

/** A `JobQueue` over one queue per shard, routed by the tenant map. */
export class ShardedJobQueue implements JobQueue {
  readonly #map: ShardMap;
  readonly #queues: ReadonlyMap<string, JobQueue>;
  #cursor = 0;

  constructor(map: ShardMap, queues: Readonly<Record<string, JobQueue>>) {
    const byShard = new Map<string, JobQueue>();
    for (const shard of map.shards) {
      const q = queues[shard];
      if (q === undefined) throw new RangeError(`shard ${shard} has no queue`);
      byShard.set(shard, q);
    }
    for (const shard of Object.keys(queues)) {
      if (!byShard.has(shard)) throw new RangeError(`queue for unknown shard ${shard}`);
    }
    this.#map = map;
    this.#queues = byShard;
  }

  /** The queue of the shard that holds the tenant. Throws before any call for an unknown tenant. */
  #on(tenant: string): JobQueue {
    const shard = this.#map.shardOf(tenant);
    const q = this.#queues.get(shard);
    if (q === undefined) throw new RangeError(`shard ${shard} has no queue`);
    return q;
  }

  async enqueue(tenant: string, job: NewJob): Promise<JobRecord> {
    return this.#on(tenant).enqueue(tenant, job);
  }

  async get(tenant: string, id: string): Promise<JobRecord | null> {
    return this.#on(tenant).get(tenant, id);
  }

  async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: ClaimOptions,
  ): Promise<JobRecord | null> {
    const shards = this.#map.shards;
    for (let i = 0; i < shards.length; i += 1) {
      const index = (this.#cursor + i) % shards.length;
      const q = this.#queues.get(shards[index]!);
      if (q === undefined) throw new RangeError('a shard has no queue');
      const job = await q.claim(kinds, worker, leaseMs, opts);
      if (job !== null) {
        this.#cursor = (index + 1) % shards.length;
        return job;
      }
    }
    return null;
  }

  async heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report?: { stage?: string; progress?: number },
  ): Promise<Heartbeat> {
    return this.#on(job.tenant).heartbeat(job, worker, leaseMs, report);
  }

  async complete(job: JobRef, worker: string, result: Record<string, unknown>): Promise<boolean> {
    return this.#on(job.tenant).complete(job, worker, result);
  }

  async fail(
    job: JobRef,
    worker: string,
    error: JobError,
    retryAfterMs?: number,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.#on(job.tenant).fail(job, worker, error, retryAfterMs, result);
  }

  async cancel(tenant: string, id: string): Promise<JobRecord | null> {
    return this.#on(tenant).cancel(tenant, id);
  }

  async findCompleted(tenant: string, cacheKey: string, since: number): Promise<JobRecord | null> {
    return this.#on(tenant).findCompleted(tenant, cacheKey, since);
  }

  async latestFor(tenant: string, doc: string, kind: string): Promise<JobRecord | null> {
    return this.#on(tenant).latestFor(tenant, doc, kind);
  }

  /** Queued and running jobs over every shard, summed by kind and priority. */
  async depth(): Promise<QueueDepth[]> {
    const sums = new Map<string, QueueDepth>();
    for (const q of this.#queues.values()) {
      for (const row of await q.depth()) {
        const key = `${row.kind}\u0000${row.priority}`;
        const seen = sums.get(key);
        if (seen === undefined) sums.set(key, { ...row });
        else {
          seen.queued += row.queued;
          seen.running += row.running;
        }
      }
    }
    return [...sums.values()];
  }

  async setLimit(tenant: string, kind: string, maxRunning: number | null): Promise<void> {
    return this.#on(tenant).setLimit(tenant, kind, maxRunning);
  }

  async activeCount(tenant: string, kind: string): Promise<number> {
    return this.#on(tenant).activeCount(tenant, kind);
  }
}
