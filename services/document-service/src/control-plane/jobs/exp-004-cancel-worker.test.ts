// EXP-004 criterion 4, the part the job runner can show: cancelling a running export stops its
// worker. The sandbox discard is not built (the compile worker is packet D), so the criterion as a
// whole stays unticked; see the Notes of EXP-004 in docs/stories/EXP-export.md.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXPORT_KIND } from '../exports.ts';
import { MemoryJobQueue, type JobRecord } from './queue.ts';
import { JobRunner, type JobContext, type JobOutcome } from './runner.ts';

describe('EXP-004 criterion 4: cancelling a running job stops its worker', () => {
  it('aborts the handler signal, refuses the handler result and reports the job as lost to the runner', async () => {
    const queue = new MemoryJobQueue(() => Date.now());
    const tenant = randomUUID();
    const job = await queue.enqueue(tenant, {
      kind: EXPORT_KIND,
      payload: {},
      createdBy: 'system',
    });

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    let releaseHandler!: () => void;
    const released = new Promise<void>((resolve) => (releaseHandler = resolve));
    const seen: { report?: string; aborted?: boolean; ranTo?: string } = {};
    const outcomes: JobOutcome[] = [];

    const runner = new JobRunner({
      queue,
      worker: 'worker-a',
      leaseMs: 60_000,
      idleMs: 1,
      retryAfterMs: 1,
      handlers: {
        [EXPORT_KIND]: async (_job: JobRecord, ctx: JobContext) => {
          markStarted();
          await released;
          // The heartbeat after the cancellation says `cancelled` and aborts the signal.
          seen.report = await ctx.report('compiling', 0.5);
          seen.aborted = ctx.signal.aborted;
          seen.ranTo = 'end';
          return { pages: 1 };
        },
      },
      hooks: {
        settled: (_job, outcome) => {
          outcomes.push(outcome);
        },
      },
    });

    const run = runner.runOnce();
    await started;
    const cancelled = await queue.cancel(tenant, job.id);
    expect(cancelled?.state).toBe('cancelled');
    releaseHandler();

    expect(await run).toBe(true);
    expect(seen).toEqual({ report: 'cancelled', aborted: true, ranTo: 'end' });
    expect(outcomes).toEqual([{ state: 'lost' }]);
    expect((await queue.get(tenant, job.id))?.state).toBe('cancelled');
    expect((await queue.get(tenant, job.id))?.result).toBeNull();
  });
});
