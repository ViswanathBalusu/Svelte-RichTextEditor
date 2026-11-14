/**
 * BE-091 criterion 4: when a live-use quota is exceeded, the tenant and the quota appear in the
 * metrics. This test reads the text the node serves at `/metrics` (the control-plane registry's
 * `render()`, joined into the scrape by `server.ts`), not the in-memory samples.
 */
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.ts';
import { LiveQuotas, QUOTA_REFUSAL_METRIC } from './live-quotas.ts';
import { MemoryQuotaStore } from './quotas.ts';

function lines(text: string): string[] {
  return text.split('\n').filter((l) => l.startsWith(`${QUOTA_REFUSAL_METRIC}{`));
}

describe('quota refusals in the scrape (BE-091 criterion 4)', () => {
  it('renders each refused tenant and quota as a sample of the scrape, with its count', async () => {
    const store = new MemoryQuotaStore((t) => t === 't1' || t === 't2');
    store.set('t1', 'commitRate', 1);
    store.set('t1', 'connections', 1);
    const metrics = new Metrics();
    const clock = 0;
    const q = new LiveQuotas({
      quotas: store,
      metrics,
      now: () => clock,
      windowMs: 1000,
      countRetryMs: 250,
    });

    expect(q.admitCommit('t1').ok).toBe(true);
    expect(q.admitCommit('t1').ok).toBe(false);
    expect(q.admitCommit('t1').ok).toBe(false);
    expect(q.admitConnection('t1').ok).toBe(true);
    expect(q.admitConnection('t1').ok).toBe(false);
    // Another tenant is not refused, so it has no refusal sample.
    expect(q.admitCommit('t2').ok).toBe(true);

    const text = await metrics.render();
    const found = lines(text);
    expect(found.length).toBe(2);

    const commit = found.find((l) => l.includes('quota="commitRate"'));
    expect(commit).toBeDefined();
    expect(commit).toContain('tenant="t1"');
    expect(commit).toContain('code="quota_exceeded"');
    expect(commit!.trim().endsWith(' 2')).toBe(true);

    const conn = found.find((l) => l.includes('quota="connections"'));
    expect(conn).toBeDefined();
    expect(conn).toContain('tenant="t1"');
    expect(conn).toContain('code="quota_exceeded"');
    expect(conn!.trim().endsWith(' 1')).toBe(true);

    expect(text).not.toContain('tenant="t2"');
  });
});
