// BE-030 criterion 3: limits are held per tenant in the registry of BE-012, and one tenant at its
// limit does not raise another tenant's acknowledgement latency. Real WebSocket clients, one
// process, memory stores. Tenant A has a small message limit in the registry; tenant B has none and
// so has the node's defaults. A floods; B submits commits one after another and times each
// acknowledgement, first alone and then while A floods.
//
// The comparison is between two runs on the same machine in one process, so it is a check that the
// limit of A is not paid for by B, not a latency target. B's latency does rise a little with the
// volume of A's refused messages, because one event loop reads them all (measured 2026-11-17, see the
// Evidence of BE-030); the limit refuses them cheaply but cannot stop the node reading them. The
// tolerance is the test's own and provisional: B's median during the flood is at most three times
// its median alone, plus 25 ms.
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryTenantRegistry } from '../../src/control-plane/tenants.ts';
import { RateLimits } from '../../src/data-plane/limits.ts';
import { DEFAULT_RATES } from '../../src/data-plane/settings.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

describe('one tenant at its limit does not slow another (BE-030 criterion 3)', () => {
  it('keeps the acknowledgements of tenant B as fast while tenant A is refused at its registered limit', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const registry = new MemoryTenantRegistry();
    await registry.putTenant(tenantA, 'a');
    await registry.putTenant(tenantB, 'b');
    await registry.setRateLimits(tenantA, { tenant: { capacity: 3, refillPerSecond: 0.001 } });
    const limits = new RateLimits(
      {
        ...DEFAULT_RATES,
        closeAfterRefusals: 1_000_000,
        // A's own connection bucket must not be what refuses it: the tenant limit is under test.
        connection: { capacity: 1_000_000, refillPerSecond: 1_000_000 },
      },
      { tenantLimits: (t) => registry.rateLimits(t) },
    );
    const p = await startPlane({
      tenant: tenantB,
      deps: { limits },
      settings: { rates: { closeAfterRefusals: 1_000_000 } },
    });
    planes.push(p);
    const doc = await p.createDocument();
    const b = await p.client('carol', { [doc]: 'owner' });
    const a = await p.client('alice', { [uuid7()]: 'editor' }, { tenant: tenantA });
    await b.open(1, doc);

    let head = 0;
    async function round(n: number): Promise<number[]> {
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        const r = await b.submit(1, { base: head, steps: [insertText(intro(), 'x')] });
        ms.push(performance.now() - t0);
        expect(r.t).toBe('sync.ack');
        head = r.d!['seq'];
      }
      return ms;
    }

    await round(10); // warm up
    const alone = await round(60);

    // A floods with messages that count against its limit, until it has been refused many times.
    let flooding = true;
    let sent = 0;
    const flood = (async () => {
      while (flooding) {
        for (let i = 0; i < 20; i++)
          a.send({
            t: 'ch.open',
            id: `f${sent++}`,
            ch: 100 + (sent % 50),
            d: { kind: 'doc', doc: uuid7(), engine: 'pm-steps/1', cdm: 1, features: [] },
          });
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const during = await round(60);
    flooding = false;
    await flood;

    const refused = a.all('error').filter((m) => m.d!['code'] === 'rate_limited').length;
    expect(refused).toBeGreaterThan(20);
    expect(b.all('error').filter((m) => m.d!['code'] === 'rate_limited')).toHaveLength(0);
    // The tenants are counted apart.
    // (Some refusals are still on their way to A when the flood stops, so the count is at least.)
    expect(
      p.plane.metricsRegistry.rateLimited.get({ tenant: tenantA, scope: 'tenant' }),
    ).toBeGreaterThanOrEqual(refused);
    expect(p.plane.metricsRegistry.rateLimited.get({ tenant: tenantB, scope: 'tenant' })).toBe(0);

    const medAlone = median(alone);
    const medDuring = median(during);
    console.log(
      `BE-030 isolation: A refused ${refused} of ${sent} messages; B acknowledgement median ` +
        `${medAlone.toFixed(2)} ms alone, ${medDuring.toFixed(2)} ms during the flood ` +
        `(60 submits each; Node ${process.version}, ${process.platform})`,
    );
    expect(medDuring).toBeLessThanOrEqual(medAlone * 3 + 25);
  }, 60_000);
});
