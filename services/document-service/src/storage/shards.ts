/**
 * Tenants spread over several PostgreSQL shards (BE-070; 06 §6; ADR 0006). `control-plane/jobs/
 * sharding.ts` holds the tenant-to-shard map and routes the job queue. This module carries the
 * same rule over the rest of storage:
 *
 * - `routeByTenant` wraps one store per shard in a single store of the same type. A call goes to
 *   the shard of the tenant that its first argument names (a tenant identifier, a `DocRef`, or any
 *   object with a `tenant`), and to no other. A tenant the map does not know is refused before any
 *   shard is touched. A first argument that names no tenant is refused too, so a method that
 *   cannot be routed fails loudly instead of landing on a default shard.
 * - A call whose argument is a list (an audit batch) must name tenants of one shard, because a
 *   transaction never spans shards (`assertSingleShard`).
 * - A few operations belong to no tenant. They are named in `fanOut` and run on every shard, with
 *   a fold that joins the answers (`list` of the tenant registry, node leases, the outbox claim).
 * - `ShardPools` hands out the pool of a tenant's shard for code that opens its own transaction.
 * - `migrateShards` and `shardCompatibility` apply the migrations to every shard and judge them
 *   one by one, with the rules of `migrate.ts` (expand and contract, BE-016).
 *
 * Nothing here opens a connection of its own: the composition builds the pools.
 */
import { assertSingleShard, type ShardMap } from '../control-plane/jobs/sharding.ts';
import { inTenant, type Pool, type PoolClient } from './db.ts';
import {
  appliedMigrations,
  compatibility,
  loadMigrations,
  migrate,
  MIGRATIONS_DIR,
  type Compatibility,
} from './migrate.ts';
import type {
  NewOutboxItem,
  NodeInfo,
  NodeLeaseStore,
  NodeTraits,
  OutboxItem,
  OutboxStore,
} from './types.ts';

/** Joins the answers of one operation that ran on every shard, in the order of `map.shards`. */
export type Fold = (answers: readonly unknown[]) => unknown;

export interface RouteOptions {
  /** Methods that name no tenant and run on every shard, each with the fold of its answers. */
  fanOut?: Readonly<Record<string, Fold>>;
}

/** Fold for a method that returns nothing. */
export const foldVoid: Fold = () => undefined;
/** Fold for a method that answers true when any shard says so. */
export const foldAny: Fold = (answers) => answers.some((a) => a === true);
/** Fold for a method that returns lists of strings: the union, in first-seen order. */
export const foldUnion: Fold = (answers) => [...new Set(answers.flatMap((a) => a as string[]))];

function requireSameShards(map: ShardMap, byShard: Readonly<Record<string, unknown>>): void {
  for (const shard of map.shards)
    if (byShard[shard] === undefined) throw new RangeError(`shard ${shard} has no store`);
  for (const shard of Object.keys(byShard))
    if (!map.shards.includes(shard)) throw new RangeError(`store for unknown shard ${shard}`);
}

/** The tenants a call names, from its first argument; null when it names none. */
function tenantsNamedBy(args: readonly unknown[]): string[] | null {
  const first = args[0];
  if (typeof first === 'string') return [first];
  if (Array.isArray(first)) {
    const tenants: string[] = [];
    for (const item of first) {
      const t = (item as { tenant?: unknown } | null)?.tenant;
      if (typeof t !== 'string') return null;
      tenants.push(t);
    }
    return tenants;
  }
  if (typeof first === 'object' && first !== null) {
    const t = (first as { tenant?: unknown }).tenant;
    if (typeof t === 'string') return [t];
  }
  return null;
}

/**
 * One store over a store per shard. The result has the methods of `T` that the first shard's store
 * has (so an optional method that the stores lack stays absent). Every routed method returns a
 * promise, and a routing failure rejects it.
 */
export function routeByTenant<T extends object>(
  map: ShardMap,
  byShard: Readonly<Record<string, T>>,
  options: RouteOptions = {},
): T {
  requireSameShards(map, byShard);
  const first = byShard[map.shards[0]!]! as Record<string, unknown>;
  const fanOut = options.fanOut ?? {};
  const wrapped = new Map<string, unknown>();
  const call = (shard: string, name: string, args: readonly unknown[]): unknown =>
    (byShard[shard]! as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
  return new Proxy(first as T, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      const member = first[name];
      if (typeof member !== 'function') return member;
      let fn = wrapped.get(name);
      if (fn === undefined) {
        const fold = fanOut[name];
        fn = async (...args: unknown[]): Promise<unknown> => {
          if (fold !== undefined)
            return fold(await Promise.all(map.shards.map((s) => call(s, name, args))));
          const tenants = tenantsNamedBy(args);
          if (tenants === null)
            throw new TypeError(`${name}: the first argument names no tenant, so it has no shard`);
          // An empty batch writes nothing; the first shard answers it.
          const shard = tenants.length === 0 ? map.shards[0]! : assertSingleShard(map, tenants);
          return call(shard, name, args);
        };
        wrapped.set(name, fn);
      }
      return fn;
    },
    has(_target, name) {
      return typeof name === 'string' && name in first;
    },
  });
}

/** The pool of each shard, by tenant. */
export class ShardPools {
  readonly #map: ShardMap;
  readonly #pools: ReadonlyMap<string, Pool>;

  constructor(map: ShardMap, pools: Readonly<Record<string, Pool>>) {
    requireSameShards(map, pools);
    this.#map = map;
    this.#pools = new Map(map.shards.map((s) => [s, pools[s]!]));
  }

  get map(): ShardMap {
    return this.#map;
  }

  /** The pool of the shard that holds the tenant. Throws for a tenant the map does not know. */
  poolOf(tenant: string): Pool {
    return this.#pools.get(this.#map.shardOf(tenant))!;
  }

  /** One transaction for the tenant, on the tenant's shard (row-level security applies). */
  inTenant<T>(
    tenant: string,
    fn: (client: PoolClient) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ): Promise<T> {
    return inTenant(this.poolOf(tenant), tenant, fn, options);
  }

  /** The pool of every shard, in the order of the map. */
  entries(): Array<[string, Pool]> {
    return this.#map.shards.map((s) => [s, this.#pools.get(s)!]);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#pools.values()].map((p) => p.end().catch(() => {})));
  }
}

/** A migration that failed on one shard; the shards before it are done, the ones after untouched. */
export class ShardMigrationError extends Error {
  readonly shard: string;
  readonly done: readonly string[];
  constructor(shard: string, done: readonly string[], cause: unknown) {
    super(
      `migration of shard ${shard} failed (done: ${done.join(', ') || 'none'}): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'ShardMigrationError';
    this.shard = shard;
    this.done = done;
  }
}

/**
 * Applies the migrations to every shard, one shard at a time and in the order of the map, each
 * with `migrate` (so with its checks: a file changed after it was applied is refused, each file
 * runs in its own transaction). A shard that fails stops the rollout, and the shards after it are
 * not touched; because every step is expand or contract (BE-016), a service of the previous
 * release can run against the shards in either state. Pools connect as the schema owner.
 * Returns the versions applied on each shard.
 */
export async function migrateShards(
  map: ShardMap,
  pools: Readonly<Record<string, Pool>>,
  dir = MIGRATIONS_DIR,
): Promise<Record<string, string[]>> {
  requireSameShards(map, pools);
  const applied: Record<string, string[]> = {};
  const done: string[] = [];
  for (const shard of map.shards) {
    const client = await pools[shard]!.connect();
    try {
      applied[shard] = await migrate(client, dir);
    } catch (e) {
      throw new ShardMigrationError(shard, done, e);
    } finally {
      client.release();
    }
    done.push(shard);
  }
  return applied;
}

export interface ShardCompatibility extends Compatibility {
  shard: string;
}

/**
 * Whether this code may run against each shard (`compatibility` of `migrate.ts`, which BE-016
 * defines). A shard that cannot be asked is reported as not ready with every migration pending.
 */
export async function shardCompatibility(
  map: ShardMap,
  pools: Readonly<Record<string, Pool>>,
  dir = MIGRATIONS_DIR,
): Promise<ShardCompatibility[]> {
  requireSameShards(map, pools);
  const known = (await loadMigrations(dir)).map((m) => m.version);
  return Promise.all(
    map.shards.map(async (shard) => {
      try {
        return { shard, ...compatibility(known, await appliedMigrations(pools[shard]!)) };
      } catch {
        return { shard, ok: false, pending: [...known], unknown: [] };
      }
    }),
  );
}

/**
 * The outbox over one outbox per shard. `enqueue`, `get`, `settle` and `unlock` go to the item's
 * tenant's shard; `claim` asks the shards in turn, starting after the one that gave items last,
 * and returns up to `limit` items from the first shards that have any.
 */
export class ShardedOutbox implements OutboxStore {
  readonly #map: ShardMap;
  readonly #byShard: Readonly<Record<string, OutboxStore>>;
  #cursor = 0;

  constructor(map: ShardMap, byShard: Readonly<Record<string, OutboxStore>>) {
    requireSameShards(map, byShard);
    this.#map = map;
    this.#byShard = byShard;
  }

  #on(tenant: string): OutboxStore {
    return this.#byShard[this.#map.shardOf(tenant)]!;
  }

  enqueue(item: NewOutboxItem): Promise<OutboxItem> {
    return this.#on(item.tenant).enqueue(item);
  }

  get(tenant: string, id: string): Promise<OutboxItem | null> {
    return this.#on(tenant).get(tenant, id);
  }

  async claim(node: string, leaseMs: number, limit: number): Promise<OutboxItem[]> {
    const shards = this.#map.shards;
    const out: OutboxItem[] = [];
    for (let i = 0; i < shards.length && out.length < limit; i += 1) {
      const index = (this.#cursor + i) % shards.length;
      const items = await this.#byShard[shards[index]!]!.claim(node, leaseMs, limit - out.length);
      if (items.length > 0) {
        out.push(...items);
        this.#cursor = (index + 1) % shards.length;
      }
    }
    return out;
  }

  settle(
    item: Pick<OutboxItem, 'tenant' | 'id'>,
    node: string,
    state: 'done' | 'failed',
    result: Record<string, unknown>,
  ): Promise<boolean> {
    return this.#on(item.tenant).settle(item, node, state, result);
  }

  unlock(item: Pick<OutboxItem, 'tenant' | 'id'>, node: string): Promise<void> {
    return this.#on(item.tenant).unlock(item, node);
  }
}

/**
 * Node leases over one lease table per shard. The claim of a document asks its shard's
 * `node_leases` whether the owner's node is alive (06 §2.1; BE-018), so a node renews its lease on
 * every shard, and a lease counts as live only when every shard holds it. A node whose renewal
 * reached one shard and not another is therefore not taken as live by the shard that missed it,
 * which can cost a takeover but never allows two owners: ownership is decided by the epoch.
 */
export class FanOutNodeLeases implements NodeLeaseStore {
  readonly #map: ShardMap;
  readonly #byShard: Readonly<Record<string, NodeLeaseStore>>;

  constructor(map: ShardMap, byShard: Readonly<Record<string, NodeLeaseStore>>) {
    requireSameShards(map, byShard);
    this.#map = map;
    this.#byShard = byShard;
  }

  #all(): NodeLeaseStore[] {
    return this.#map.shards.map((s) => this.#byShard[s]!);
  }

  async renew(node: string, leaseMs: number, address?: string, traits?: NodeTraits): Promise<void> {
    await Promise.all(this.#all().map((s) => s.renew(node, leaseMs, address, traits)));
  }

  async alive(node: string): Promise<boolean> {
    return (await Promise.all(this.#all().map((s) => s.alive(node)))).every((a) => a);
  }

  async live(): Promise<NodeInfo[]> {
    const lists = await Promise.all(this.#all().map((s) => s.live()));
    const [head, ...rest] = lists;
    if (head === undefined) return [];
    return head.filter((n) => rest.every((l) => l.some((m) => m.node === n.node)));
  }

  async release(node: string): Promise<void> {
    await Promise.all(this.#all().map((s) => s.release(node)));
  }
}
