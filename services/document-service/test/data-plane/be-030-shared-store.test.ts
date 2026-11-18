// BE-030 criterion 5, stage 2: the tenant and user counters live in Redis or Valkey and the limits
// behave as they do in process memory. Runs against a real Valkey when `DOCEDIT_VALKEY_URL` names
// one (for example `redis://127.0.0.1:56395`); skipped otherwise. Each case uses a key prefix of its
// own and tenants of its own.
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { RateLimits } from '../../src/data-plane/limits.ts';
import { DEFAULT_RATES } from '../../src/data-plane/settings.ts';
import { ValkeyTokenBuckets } from '../../src/data-plane/valkey-buckets.ts';
import type { RateSettings } from '../../src/seams.ts';
import { startPlane, type Plane } from './support.ts';

const liveUrl = process.env['DOCEDIT_VALKEY_URL'];

const rates = (over: Partial<RateSettings> = {}): RateSettings => ({
  ...DEFAULT_RATES,
  tenant: { capacity: 3, refillPerSecond: 2 },
  user: { capacity: 2, refillPerSecond: 1 },
  ...over,
});

const stores: ValkeyTokenBuckets[] = [];
const planes: Plane[] = [];
function shared(prefix: string): ValkeyTokenBuckets {
  const s = new ValkeyTokenBuckets({ url: liveUrl!, prefix, timeoutMs: 2000 });
  stores.push(s);
  return s;
}
afterEach(async () => {
  for (const p of planes.splice(0)) await p.close();
  // The keys expire on their own (the take script sets an expiry), so only the connections close.
  for (const s of stores.splice(0)) {
    // A pass through the local fallback would look the same, so show that Valkey answered.
    expect(s.stats.degraded).toBe(0);
    s.close();
  }
});

describe.skipIf(liveUrl === undefined)(
  'rate limits over a shared store (BE-030 criterion 5)',
  () => {
    it('answers the same as process memory for the same messages [stage 1 and stage 2]', async () => {
      const run = uuid7();
      const memory = new RateLimits(rates());
      const store = shared(`docedit:rl:w5-be030:${run}:`);
      const valkey = new RateLimits(rates(), { store });
      const ta = `ta-${run}`;
      const tb = `tb-${run}`;
      const script: Array<[string, string, number]> = [
        [ta, 'a', 0],
        [ta, 'a', 0],
        [ta, 'a', 0],
        [ta, 'b', 0],
        [ta, 'b', 400],
        [tb, 'a', 400],
        [ta, 'a', 1000],
        [ta, 'b', 2000],
        [ta, 'b', 2000],
        [ta, 'a', 9000],
      ];
      const refused: unknown[] = [];
      for (const [t, u, at] of script) {
        const m = await memory.message(t, u, at);
        expect(await valkey.message(t, u, at)).toEqual(m);
        refused.push(m);
      }
      // The script does refuse some messages, in both scopes, so the equality means something.
      expect(refused.some((r) => (r as { scope?: string } | null)?.scope === 'tenant')).toBe(true);
      expect(refused.some((r) => (r as { scope?: string } | null)?.scope === 'user')).toBe(true);
      expect(store.stats.shared).toBeGreaterThan(0);
    });

    it('shares one user limit between two nodes', async () => {
      const run = uuid7();
      const prefix = `docedit:rl:w5-be030:${run}:`;
      const nodeA = new RateLimits(rates({ tenant: { capacity: 100, refillPerSecond: 100 } }), {
        store: shared(prefix),
      });
      const nodeB = new RateLimits(rates({ tenant: { capacity: 100, refillPerSecond: 100 } }), {
        store: shared(prefix),
      });
      const t = `t-${run}`;
      // The user's capacity is 2: one message on each node, then both nodes refuse.
      expect(await nodeA.message(t, 'alice', 0)).toBeNull();
      expect(await nodeB.message(t, 'alice', 0)).toBeNull();
      expect(await nodeA.message(t, 'alice', 0)).toMatchObject({ scope: 'user' });
      expect(await nodeB.message(t, 'alice', 0)).toMatchObject({ scope: 'user' });
      // Another user is not affected, on either node.
      expect(await nodeB.message(t, 'bob', 0)).toBeNull();
    });

    it('limits the sockets of a node through the shared store as it does in memory', async () => {
      const run = uuid7();
      const tight = { capacity: 4, refillPerSecond: 0.001 };
      const limits = new RateLimits(
        {
          ...DEFAULT_RATES,
          tenant: tight,
          connection: { capacity: 1_000, refillPerSecond: 1_000 },
          closeAfterRefusals: 1_000,
        },
        { store: shared(`docedit:rl:w5-be030:${run}:`) },
      );
      const p = await startPlane({ deps: { limits } });
      planes.push(p);
      const doc = await p.createDocument();
      const a = await p.client('alice', { [doc]: 'owner' });
      const b = await p.client('carol', { [uuid7()]: 'editor' }, { tenant: crypto.randomUUID() });
      const open = (c: typeof a, id: string, ch: number) =>
        c.send({
          t: 'ch.open',
          id,
          ch,
          d: { kind: 'doc', doc: uuid7(), engine: 'pm-steps/1', cdm: 1, features: [] },
        });
      for (let i = 0; i < 6; i++) open(a, `a${i}`, 50 + i);
      await a.take((m) => m.re === 'a5');
      expect(a.all('error').some((m) => m.d!['code'] === 'rate_limited')).toBe(true);
      for (let i = 0; i < 4; i++) open(b, `b${i}`, 50 + i);
      await b.take((m) => m.re === 'b3');
      expect(b.all('error').some((m) => m.d!['code'] === 'rate_limited')).toBe(false);
    });
  },
);
