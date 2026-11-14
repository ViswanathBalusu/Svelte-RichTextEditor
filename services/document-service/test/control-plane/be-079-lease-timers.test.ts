/**
 * BE-079 criterion 2, the lease part: in test mode the node lease and the job lease are shortened
 * by `TEST_TIMERS` (`nodeLeaseMs` 3 s, `jobLeaseMs` 2 s), and with test mode off they keep their
 * defaults (15 s node lease in `src/data-plane/settings.ts`, 30 s job lease in `src/config.ts`).
 *
 * The lease store judges expiry by the duration it is given, so these tests record the durations
 * that the data plane's node lease hands to its store on each renewal, and the durations that the
 * job runner hands to the queue on each claim. The memory stores stand in for PostgreSQL here; the
 * expiry on the database clock is not run. The tests run the real data plane over a real service.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryJobQueue } from '../../src/control-plane/jobs/queue.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';
import { MemoryNodeLeases } from '../../src/data-plane/memory-ports.ts';
import { startHarness, type Harness } from './support.ts';

const JOB_KIND = 'test.lease';

/** Records the lease duration the node lease gives its store on every renewal. */
class RecordingLeases extends MemoryNodeLeases {
  readonly renewals: number[] = [];
  override async renew(node: string, leaseMs: number): Promise<void> {
    this.renewals.push(leaseMs);
    return super.renew(node, leaseMs);
  }
}

/** Records the lease duration the job runner gives the queue on every claim. */
class RecordingJobQueue extends MemoryJobQueue {
  readonly claimLeases: number[] = [];
  override async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: Parameters<MemoryJobQueue['claim']>[3],
  ) {
    this.claimLeases.push(leaseMs);
    return super.claim(kinds, worker, leaseMs, opts);
  }
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

async function start(testMode: boolean) {
  const leases = new RecordingLeases();
  const queue = new RecordingJobQueue();
  const h = await startHarness('memory', {
    config: testMode ? { testMode: true, environment: 'test', jobIdleMs: 20 } : { jobIdleMs: 20 },
    parts: { leases, queue },
    realDataPlane: true,
    jobHandlers: { [JOB_KIND]: async () => ({}) },
  });
  harnesses.push(h);
  return { h, leases, queue };
}

/** Runs one job through the real runner and waits until it completes. */
async function runOneJob(h: Harness, queue: RecordingJobQueue): Promise<void> {
  const job = await queue.enqueue(h.tenant, { kind: JOB_KIND, payload: {}, createdBy: 'test' });
  for (let i = 0; i < 300; i++) {
    const got = await queue.get(h.tenant, job.id);
    if (got?.state === 'completed') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job ${job.id} did not complete`);
}

/** Waits until the node lease has renewed at least once (the first renewal starts at boot). */
async function untilRenewed(leases: RecordingLeases): Promise<void> {
  for (let i = 0; i < 300 && leases.renewals.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('test mode shortens the lease timers (BE-079 criterion 2, leases)', () => {
  it('hands the shortened node lease, about 3 s, to the store on every renewal', async () => {
    const { leases } = await start(true);
    expect(TEST_TIMERS.nodeLeaseMs).toBe(3_000);
    await untilRenewed(leases);
    expect(leases.renewals.length).toBeGreaterThan(0);
    expect(new Set(leases.renewals)).toEqual(new Set([TEST_TIMERS.nodeLeaseMs]));
  });

  it('claims jobs with the shortened job lease, about 2 s', async () => {
    const { h, queue } = await start(true);
    expect(TEST_TIMERS.jobLeaseMs).toBe(2_000);
    await runOneJob(h, queue);
    expect(queue.claimLeases.length).toBeGreaterThan(0);
    expect(new Set(queue.claimLeases)).toEqual(new Set([TEST_TIMERS.jobLeaseMs]));
  });

  it('keeps the default node lease and job lease when test mode is off', async () => {
    const { h, leases, queue } = await start(false);
    const hook = await h.call('GET', '/_test/timers', { token: h.serviceJwt() });
    expect(hook.status).toBe(404);
    await untilRenewed(leases);
    expect(leases.renewals.length).toBeGreaterThan(0);
    expect(new Set(leases.renewals)).toEqual(new Set([15_000]));
    await runOneJob(h, queue);
    expect(new Set(queue.claimLeases)).toEqual(new Set([30_000]));
  });
});
