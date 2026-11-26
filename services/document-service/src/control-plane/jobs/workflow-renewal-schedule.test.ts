// The scheduled scan of the time-stamp renewal (BE-052 criterion 2, FRW-056 criterion 2): chains
// whose newest time-stamp expires within the lead time get one `workflow.renewal` job for that
// expiry, however often the scan runs; later chains, expired chains and other tenants get none.
import { describe, expect, it } from 'vitest';
import { MemoryRenewalStore } from '../../workflow/renewal-state-memory.ts';
import { MemoryJobQueue } from './queue.ts';
import { RENEWAL_KIND, renewalJobId, renewalScheduleTask } from './workflow-renewal.ts';

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;

describe('renewalScheduleTask', () => {
  it('enqueues one job for each expiry inside the lead time, once however often it runs', async () => {
    const store = new MemoryRenewalStore();
    const queue = new MemoryJobQueue();
    await store.start('t1', 'soon', NOW + 3 * DAY);
    await store.start('t1', 'later', NOW + 30 * DAY);
    await store.start('t1', 'expired', NOW - DAY);
    await store.start('t2', 'other-tenant', NOW + DAY);
    const task = renewalScheduleTask({ source: store, queue, leadMs: 7 * DAY });
    expect(task.name).toBe('workflow.renewal.schedule');
    const scope = { held: new Set<string>() };

    expect(await task.forTenant!('t1', NOW, scope)).toBe(1);
    expect(await task.forTenant!('t1', NOW + 60_000, scope)).toBe(1);

    const job = await queue.get('t1', renewalJobId('soon', NOW + 3 * DAY));
    expect(job).toMatchObject({
      kind: RENEWAL_KIND,
      doc: 'soon',
      payload: { expiry: NOW + 3 * DAY },
      state: 'queued',
    });
    expect(await queue.get('t1', renewalJobId('later', NOW + 30 * DAY))).toBeNull();
    expect(await queue.get('t1', renewalJobId('expired', NOW - DAY))).toBeNull();
    expect(await queue.get('t1', renewalJobId('other-tenant', NOW + DAY))).toBeNull();
  });

  it('takes the window from the clock of the run: a chain enters it as time passes', async () => {
    const store = new MemoryRenewalStore();
    const queue = new MemoryJobQueue();
    await store.start('t1', 'doc', NOW + 10 * DAY);
    const task = renewalScheduleTask({ source: store, queue, leadMs: 7 * DAY });
    const scope = { held: new Set<string>() };
    expect(await task.forTenant!('t1', NOW, scope)).toBe(0);
    expect(await task.forTenant!('t1', NOW + 4 * DAY, scope)).toBe(1);
  });

  it('refuses a lead time that is not a positive number of milliseconds', () => {
    const store = new MemoryRenewalStore();
    const queue = new MemoryJobQueue();
    expect(() => renewalScheduleTask({ source: store, queue, leadMs: 0 })).toThrow(RangeError);
  });
});
