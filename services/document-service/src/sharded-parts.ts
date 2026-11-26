/**
 * The service's parts over several PostgreSQL shards (BE-070; 06 §6). `pgParts` builds the parts
 * of one database; this builds them once per shard and joins them, so that each request or job goes
 * to the shard of its tenant (`storage/shards.ts`, `control-plane/jobs/sharding.ts`).
 *
 * - Stores whose methods start with a tenant or a `DocRef` are routed by it (`routeByTenant`).
 *   The tenant registry's `list` and `originRegistered` ask every shard.
 * - The job queue is a `ShardedJobQueue`, the outbox a `ShardedOutbox`, node leases are renewed on
 *   every shard (`FanOutNodeLeases`).
 * - Readiness is the answer of every shard: the service is ready when each shard can run this
 *   code (`shardedReadiness`).
 * - `pool` is null: no single pool stands for the service. Parts that take `parts.pool` fall back
 *   to what they do without one (the search index is the in-memory one). The object store is
 *   shared, because object keys carry the tenant.
 *
 * A tenant must be in the map before it is used; adding one is a change of the map, not of this
 * code. Moving a tenant between shards is not supported (06 §6 does not describe it).
 */
import { ShardedJobQueue, type ShardMap } from './control-plane/jobs/sharding.ts';
import { pgParts, readiness, type Readiness, type ServiceParts } from './server.ts';
import type { Pool } from './storage/db.ts';
import {
  FanOutNodeLeases,
  foldAny,
  foldVoid,
  foldUnion,
  routeByTenant,
  ShardedOutbox,
} from './storage/shards.ts';

/** Parts that are routed by the tenant in their first argument, when the shard's parts have them. */
const ROUTED = [
  'logs',
  'ownership',
  'grants',
  'documents',
  'users',
  'idempotency',
  'assetRegistry',
  'checkpointIndex',
  'audit',
  'retention',
  // HIS-025: the setting is read and written with the store and the documents of its tenant's shard.
  'historyVisibility',
  'holds',
  'workflows',
  'templates',
  'reminders',
  'evidence',
  'accessCodes',
  'quotaAdmin',
  'readMarkers',
  // HIS-003: a session's record goes to the shard of its tenant, where its document is.
  'sessionRecords',
  // HIS-036: a tenant's anchor records and covered heads are on the shard of its documents.
  'headAnchorStore',
  'homeRegions',
  'threads',
  'versions',
] as const satisfies readonly (keyof ServiceParts)[];

export function shardedPgParts(
  map: ShardMap,
  pools: Readonly<Record<string, Pool>>,
  now: () => number = Date.now,
): ServiceParts {
  const perShard: Record<string, ServiceParts> = {};
  for (const shard of map.shards) {
    const pool = pools[shard];
    if (pool === undefined) throw new RangeError(`shard ${shard} has no pool`);
    perShard[shard] = pgParts(pool, now);
  }
  const first = perShard[map.shards[0]!]!;
  const parts: ServiceParts = {
    ...first,
    registry: routeByTenant(
      map,
      Object.fromEntries(map.shards.map((s) => [s, perShard[s]!.registry])),
      { fanOut: { list: foldUnion, originRegistered: foldAny } },
    ),
    queue: new ShardedJobQueue(
      map,
      Object.fromEntries(map.shards.map((s) => [s, perShard[s]!.queue])),
    ),
    pool: null,
    readiness: () => shardedReadiness(map, pools),
  };
  const writable = parts as unknown as Record<string, unknown>;
  for (const key of ROUTED) {
    const stores = map.shards.map((s) => [s, perShard[s]![key]] as const);
    if (stores.some(([, v]) => v === undefined)) {
      Reflect.deleteProperty(writable, key);
      continue;
    }
    // The setters of a PostgreSQL log store (document keys, cold segments) name no tenant: every
    // shard's store gets them.
    const setters =
      key === 'logs' || key === 'ownership'
        ? { fanOut: { useDocumentKeys: foldVoid, useColdSegments: foldVoid } }
        : {};
    writable[key] = routeByTenant(
      map,
      Object.fromEntries(stores) as Record<string, object>,
      setters,
    );
  }
  // `ownership` is the log store of each shard under another name; both routes reach the same one.
  if (first.outbox)
    parts.outbox = new ShardedOutbox(
      map,
      Object.fromEntries(map.shards.map((s) => [s, perShard[s]!.outbox!])),
    );
  if (first.leases)
    parts.leases = new FanOutNodeLeases(
      map,
      Object.fromEntries(map.shards.map((s) => [s, perShard[s]!.leases!])),
    );
  return parts;
}

/**
 * Ready when every shard is: the first shard that is not ready names the answer, with its name
 * in the reason. The schema shown is the oldest one among the shards.
 */
export async function shardedReadiness(
  map: ShardMap,
  pools: Readonly<Record<string, Pool>>,
): Promise<Readiness> {
  const answers = await Promise.all(
    map.shards.map(async (s) => [s, await readiness(pools[s]!)] as const),
  );
  const bad = answers.find(([, r]) => !r.ready);
  if (bad) {
    const [shard, r] = bad;
    return { ...r, reason: `shard ${shard}: ${r.reason ?? 'not ready'}` };
  }
  const schemas = answers.map(([, r]) => r.schema ?? '').sort();
  const expected = answers[0]![1].expected;
  return {
    ready: true,
    schema: schemas[0] === '' ? null : (schemas[0] ?? null),
    ...(expected !== undefined ? { expected } : {}),
  };
}
