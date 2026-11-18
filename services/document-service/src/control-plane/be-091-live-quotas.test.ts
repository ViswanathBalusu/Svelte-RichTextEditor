/**
 * The live-use quota decisions (BE-091): the commit-rate and CPU-budget windows against a reference
 * model (property tests), per-tenant isolation of the decisions, values read at each decision, the
 * refusal codes, and the refusal counter in the metrics.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Metrics } from './metrics.ts';
import { LiveQuotas, QUOTA_REFUSAL_METRIC } from './live-quotas.ts';
import { MemoryQuotaStore } from './quotas.ts';

const WINDOW = 1000;

function setup(known: string[] = ['t1', 't2']) {
  const store = new MemoryQuotaStore((t) => known.includes(t));
  const metrics = new Metrics();
  let clock = 0;
  const q = new LiveQuotas({
    quotas: store,
    metrics,
    now: () => clock,
    windowMs: WINDOW,
    countRetryMs: 250,
  });
  return {
    store,
    metrics,
    q,
    at: (t: number) => {
      clock = t;
    },
  };
}

describe('commit rate and CPU budget windows (BE-091)', () => {
  it('admits commits as a sliding-window model says, for any increasing times and limits [neg:code quota_exceeded]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 0, max: WINDOW }), { minLength: 1, maxLength: 40 }),
        (limit, gaps) => {
          const { store, q, at } = setup();
          store.set('t1', 'commitRate', limit);
          let t = 0;
          const accepted: number[] = [];
          for (const gap of gaps) {
            t += gap;
            at(t);
            const inWindow = accepted.filter((x) => x > t - WINDOW).length;
            const expected = inWindow + 1 <= limit;
            const got = q.admitCommit('t1');
            expect(got.ok).toBe(expected);
            if (expected) accepted.push(t);
            else if (!got.ok) {
              expect(got.code).toBe('quota_exceeded');
              expect(got.quota).toBe('commitRate');
              expect(Number.isSafeInteger(got.retryAfterMs)).toBe(true);
              expect(got.retryAfterMs).toBeGreaterThan(0);
              expect(got.retryAfterMs).toBeLessThanOrEqual(WINDOW);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a CPU spend beyond the budget as rate_limited with action retry, never quota_exceeded', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 20 }),
        (budget, spends) => {
          const { store, q, at } = setup();
          store.set('t1', 'roomCpuBudget', budget);
          let spent = 0;
          spends.forEach((ms, i) => {
            at(i);
            const got = q.spendCpu('t1', ms);
            if (spent + ms <= budget) {
              expect(got.ok).toBe(true);
              spent += ms;
            } else {
              expect(got).toMatchObject({
                ok: false,
                code: 'rate_limited',
                quota: 'roomCpuBudget',
                action: 'retry',
              });
            }
          });
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('live-use quota decisions', () => {
  it('keeps each tenant apart: a tenant at its quota does not change another tenant decisions', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('t1', 't2'), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 3 }),
        (order, limit) => {
          const alone = setup();
          alone.store.set('t1', 'commitRate', limit);
          const mixed = setup();
          mixed.store.set('t1', 'commitRate', limit);
          mixed.store.set('t2', 'commitRate', 1);
          for (const tenant of order) {
            alone.at(0);
            mixed.at(0);
            if (tenant === 't1') {
              // t2 (limit 1) is refused from its second commit on; t1 must decide as if alone.
              expect(mixed.q.admitCommit('t1').ok).toBe(alone.q.admitCommit('t1').ok);
            } else {
              mixed.q.admitCommit('t2');
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reads the quota at each decision, so a changed value applies to the next one', () => {
    const { store, q, at } = setup();
    store.set('t1', 'commitRate', 1);
    at(0);
    expect(q.admitCommit('t1').ok).toBe(true);
    expect(q.admitCommit('t1')).toMatchObject({
      ok: false,
      code: 'quota_exceeded',
      quota: 'commitRate',
    });
    store.set('t1', 'commitRate', 2);
    expect(q.admitCommit('t1').ok).toBe(true);
  });

  it('applies no limit while a quota is unset (null)', () => {
    const { q, at } = setup();
    at(0);
    for (let i = 0; i < 500; i++) expect(q.admitCommit('t1').ok).toBe(true);
    for (let i = 0; i < 50; i++) expect(q.admitConnection('t1').ok).toBe(true);
  });

  it('counts connections and releases them, and refuses past the limit with a retry delay', () => {
    const { store, q } = setup();
    store.set('t1', 'connections', 2);
    expect(q.admitConnection('t1').ok).toBe(true);
    expect(q.admitConnection('t1').ok).toBe(true);
    expect(q.admitConnection('t1')).toEqual({
      ok: false,
      code: 'quota_exceeded',
      quota: 'connections',
      retryAfterMs: 250,
    });
    q.releaseConnection('t1');
    expect(q.admitConnection('t1').ok).toBe(true);
  });

  it('admits an already open document without counting it twice, and refuses a new one past the limit', () => {
    const { store, q } = setup();
    store.set('t1', 'openDocuments', 1);
    expect(q.admitDocument('t1', 'doc-a').ok).toBe(true);
    expect(q.admitDocument('t1', 'doc-a').ok).toBe(true);
    expect(q.admitDocument('t1', 'doc-b')).toMatchObject({
      ok: false,
      code: 'quota_exceeded',
      quota: 'openDocuments',
    });
    // Two channels hold doc-a: it stops counting when the last one is released.
    q.closeDocument('t1', 'doc-a');
    expect(q.admitDocument('t1', 'doc-b').ok).toBe(false);
    q.closeDocument('t1', 'doc-a');
    expect(q.admitDocument('t1', 'doc-b').ok).toBe(true);
  });

  it('keeps the open documents of one tenant apart from another tenant', () => {
    const { store, q } = setup();
    store.set('t1', 'openDocuments', 1);
    expect(q.admitDocument('t1', 'doc-a').ok).toBe(true);
    expect(q.admitDocument('t1', 'doc-b').ok).toBe(false);
    for (const d of ['doc-a', 'doc-b', 'doc-c']) expect(q.admitDocument('t2', d).ok).toBe(true);
  });

  it('refuses room work as rate_limited once the CPU spent in the window reaches the budget, and admits it again when the window passes', () => {
    const { store, q, at } = setup();
    store.set('t1', 'roomCpuBudget', 10);
    at(0);
    expect(q.admitCpu('t1').ok).toBe(true);
    q.chargeCpu('t1', 6);
    expect(q.admitCpu('t1').ok).toBe(true);
    q.chargeCpu('t1', 6);
    at(100);
    expect(q.admitCpu('t1')).toMatchObject({
      ok: false,
      code: 'rate_limited',
      action: 'retry',
      quota: 'roomCpuBudget',
      retryAfterMs: WINDOW - 100,
    });
    // Another tenant is not charged for it.
    expect(q.admitCpu('t2').ok).toBe(true);
    at(WINDOW + 1);
    expect(q.admitCpu('t1').ok).toBe(true);
  });

  it('treats a CPU budget of 0 as spent and no budget as unlimited', () => {
    const { store, q } = setup();
    expect(q.admitCpu('t1').ok).toBe(true);
    store.set('t1', 'roomCpuBudget', 0);
    expect(q.admitCpu('t1').ok).toBe(false);
  });

  it('counts each refusal per tenant and quota in the metrics, with no document content in the labels', () => {
    const { store, q, metrics, at } = setup();
    store.set('t1', 'commitRate', 1);
    store.set('t1', 'roomCpuBudget', 5);
    at(0);
    q.admitCommit('t1');
    q.admitCommit('t1');
    q.admitCommit('t1');
    q.spendCpu('t1', 4);
    q.spendCpu('t1', 4);
    expect(
      metrics.value(QUOTA_REFUSAL_METRIC, {
        tenant: 't1',
        quota: 'commitRate',
        code: 'quota_exceeded',
      }),
    ).toBe(2);
    expect(
      metrics.value(QUOTA_REFUSAL_METRIC, {
        tenant: 't1',
        quota: 'roomCpuBudget',
        code: 'rate_limited',
      }),
    ).toBe(1);
    const text = [...metrics.samples(QUOTA_REFUSAL_METRIC)]
      .map((s) => JSON.stringify(s))
      .join('\n');
    expect(text).toContain('"tenant":"t1"');
    expect(text).not.toContain('doc-');
  });

  it('rejects a window or retry delay that is not a whole number above 0', () => {
    const store = new MemoryQuotaStore(() => true);
    expect(() => new LiveQuotas({ quotas: store, windowMs: 0, countRetryMs: 1 })).toThrow(
      RangeError,
    );
    expect(() => new LiveQuotas({ quotas: store, windowMs: 1, countRetryMs: 1.5 })).toThrow(
      RangeError,
    );
  });
});
