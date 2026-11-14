// Tenants spread over shards (BE-070; 06 §6; ADR 0006). The shards are in-memory queues that
// record the tenant of every call, so the test can see which shard each call reached. The
// PostgreSQL shards are not run here; the conformance kit and the fault tests (BE-080) are not built.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryJobQueue, type JobQueue, type JobRecord } from './queue.ts';
import {
  CrossShardError,
  ShardMap,
  ShardedJobQueue,
  UnknownTenantShard,
  assertSingleShard,
} from './sharding.ts';

const KIND = 'demo.kind';
const TENANTS = ['t1', 't2', 't3', 't4'] as const;
/** t1 and t2 live on shard a; t3 and t4 on shard b. */
const ASSIGN: Record<string, string> = { t1: 'a', t2: 'a', t3: 'b', t4: 'b' };

interface Call {
  shard: string;
  method: string;
  tenant: string;
}

/** An in-memory shard that records the tenant named by each call. */
function recordedShard(shard: string, log: Call[]): JobQueue {
  const inner = new MemoryJobQueue();
  return new Proxy(inner, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const first = args[0];
        const tenant =
          typeof first === 'string' ? first : (first as { tenant?: unknown } | undefined)?.tenant;
        if (typeof tenant === 'string') log.push({ shard, method: String(prop), tenant });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function build() {
  const log: Call[] = [];
  const map = new ShardMap(['a', 'b'], ASSIGN);
  const queues = { a: recordedShard('a', log), b: recordedShard('b', log) };
  return { log, map, queues, q: new ShardedJobQueue(map, queues) };
}

const newJob = () => ({ doc: randomUUID(), kind: KIND, payload: {}, createdBy: 'system' });

describe("a tenant call goes to the tenant's shard (BE-070 criterion 1)", () => {
  it("sends every call that names a tenant to that tenant's shard only", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...TENANTS), { minLength: 1, maxLength: 10 }),
        async (tenants) => {
          const { log, map, q } = build();
          const created: JobRecord[] = [];
          for (const t of tenants) created.push(await q.enqueue(t, newJob()));
          for (const job of created) {
            const got = await q.get(job.tenant, job.id);
            expect(got?.id).toBe(job.id);
            await q.setLimit(job.tenant, KIND, 2);
            await q.latestFor(job.tenant, job.doc!, KIND);
            await q.findCompleted(job.tenant, 'a'.repeat(64), 0);
          }
          expect(log.length).toBeGreaterThan(0);
          for (const call of log) expect(call.shard).toBe(map.shardOf(call.tenant));
        },
      ),
      { numRuns: 60 },
    );
  });

  it('a job reference goes to the shard that created the job', async () => {
    const { log, q } = build();
    const job = await q.enqueue('t3', newJob());
    const claimed = await q.claim([KIND], 'w1', 60_000);
    expect(claimed?.id).toBe(job.id);
    const ref = { tenant: job.tenant, id: job.id };
    expect(await q.heartbeat(ref, 'w1', 60_000)).toBe('ok');
    expect(await q.complete(ref, 'w1', {})).toBe(true);
    const onB = log.filter((c) => c.tenant === 't3');
    expect(onB.length).toBeGreaterThan(0);
    expect(onB.every((c) => c.shard === 'b')).toBe(true);
  });

  it('refuses a tenant the map does not know before any shard is touched', async () => {
    const { log, q } = build();
    await expect(q.enqueue('t9', newJob())).rejects.toBeInstanceOf(UnknownTenantShard);
    await expect(q.get('t9', randomUUID())).rejects.toBeInstanceOf(UnknownTenantShard);
    expect(log).toEqual([]);
  });
});

describe('claims across shards (BE-070; BE-050 within a shard)', () => {
  it('claims jobs from every shard, loses none, and then reports none ready', async () => {
    const { q } = build();
    const made: string[] = [];
    for (const t of ['t1', 't1', 't3', 't3']) made.push((await q.enqueue(t, newJob())).id);
    const got: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const job = await q.claim([KIND], 'w1', 60_000);
      expect(job).not.toBeNull();
      got.push(job!.id);
    }
    expect(new Set(got)).toEqual(new Set(made));
    expect(await q.claim([KIND], 'w1', 60_000)).toBeNull();
  });

  it('sums queue depth over the shards', async () => {
    const { q } = build();
    await q.enqueue('t1', newJob());
    await q.enqueue('t2', newJob());
    await q.enqueue('t3', newJob());
    const rows = await q.depth();
    const row = rows.find((r) => r.kind === KIND && r.priority === 0);
    expect(row?.queued).toBe(3);
    expect(row?.running).toBe(0);
  });
});

describe('the shard map (BE-070)', () => {
  it('refuses a map with no shard, a repeated shard, or a tenant on an unknown shard', () => {
    expect(() => new ShardMap([], {})).toThrow(RangeError);
    expect(() => new ShardMap(['a', 'a'], {})).toThrow(RangeError);
    expect(() => new ShardMap(['a'], { t1: 'z' })).toThrow(RangeError);
  });

  it('refuses a sharded queue that lacks a queue for a shard, or has one for no shard', () => {
    const map = new ShardMap(['a', 'b'], ASSIGN);
    expect(() => new ShardedJobQueue(map, { a: new MemoryJobQueue() })).toThrow(RangeError);
    expect(
      () =>
        new ShardedJobQueue(map, {
          a: new MemoryJobQueue(),
          b: new MemoryJobQueue(),
          c: new MemoryJobQueue(),
        }),
    ).toThrow(RangeError);
  });

  it('a transaction over several tenants runs only when they share one shard', () => {
    const map = new ShardMap(['a', 'b'], ASSIGN);
    expect(assertSingleShard(map, ['t1', 't2'])).toBe('a');
    expect(assertSingleShard(map, ['t3'])).toBe('b');
    expect(() => assertSingleShard(map, ['t1', 't3'])).toThrow(CrossShardError);
    expect(() => assertSingleShard(map, [])).toThrow(RangeError);
    expect(() => assertSingleShard(map, ['t1', 't9'])).toThrow(UnknownTenantShard);
  });

  it('agrees with the map on every pair of tenants (property)', () => {
    const map = new ShardMap(['a', 'b'], ASSIGN);
    fc.assert(
      fc.property(fc.constantFrom(...TENANTS), fc.constantFrom(...TENANTS), (x, y) => {
        const same = map.shardOf(x) === map.shardOf(y);
        if (same) expect(assertSingleShard(map, [x, y])).toBe(map.shardOf(x));
        else expect(() => assertSingleShard(map, [x, y])).toThrow(CrossShardError);
      }),
    );
  });
});
