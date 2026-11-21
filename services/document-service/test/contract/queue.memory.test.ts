// The Queue contract (BE-002; 06 §14 `Queue`) against the in-memory queue, and against three queues
// that each break one rule of the port, which the suite must refuse. No database needed.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MemoryJobQueue,
  type ClaimOptions,
  type Heartbeat,
  type JobError,
  type JobQueue,
  type JobRecord,
  type JobRef,
  type NewJob,
  type QueueDepth,
} from '../../src/control-plane/jobs/queue.ts';
import { QUEUE_CHECKS, failingQueueChecks, type QueueHarness } from './queue-checks.ts';

/** A queue on a clock that the harness moves, optionally behind a wrapper that breaks a rule. */
function memoryHarness(wrap: (q: JobQueue) => JobQueue = (q) => q): QueueHarness {
  let t = 1_760_000_000_000;
  return {
    queue: wrap(new MemoryJobQueue(() => t)),
    tenant: randomUUID(),
    otherTenant: randomUUID(),
    pass: async (ms) => {
      t += ms;
    },
  };
}

describe('queue contract: in-memory queue', () => {
  for (const c of QUEUE_CHECKS) it(c.name, () => c.run(memoryHarness()));
});

/** Passes every call on; a wrong queue overrides the one rule it breaks. */
class Delegating implements JobQueue {
  protected readonly inner: JobQueue;

  constructor(inner: JobQueue) {
    this.inner = inner;
  }

  enqueue(tenant: string, job: NewJob): Promise<JobRecord> {
    return this.inner.enqueue(tenant, job);
  }
  get(tenant: string, id: string): Promise<JobRecord | null> {
    return this.inner.get(tenant, id);
  }
  claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: ClaimOptions,
  ): Promise<JobRecord | null> {
    return this.inner.claim(kinds, worker, leaseMs, opts);
  }
  heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report?: { stage?: string; progress?: number },
  ): Promise<Heartbeat> {
    return this.inner.heartbeat(job, worker, leaseMs, report);
  }
  complete(job: JobRef, worker: string, result: Record<string, unknown>): Promise<boolean> {
    return this.inner.complete(job, worker, result);
  }
  fail(
    job: JobRef,
    worker: string,
    error: JobError,
    retryAfterMs?: number,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    return this.inner.fail(job, worker, error, retryAfterMs, result);
  }
  cancel(tenant: string, id: string): Promise<JobRecord | null> {
    return this.inner.cancel(tenant, id);
  }
  findCompleted(tenant: string, cacheKey: string, since: number): Promise<JobRecord | null> {
    return this.inner.findCompleted(tenant, cacheKey, since);
  }
  latestFor(tenant: string, doc: string, kind: string): Promise<JobRecord | null> {
    return this.inner.latestFor(tenant, doc, kind);
  }
  depth(): Promise<QueueDepth[]> {
    return this.inner.depth();
  }
  setLimit(tenant: string, kind: string, maxRunning: number | null): Promise<void> {
    return this.inner.setLimit(tenant, kind, maxRunning);
  }
  activeCount(tenant: string, kind: string): Promise<number> {
    return this.inner.activeCount(tenant, kind);
  }
}

/** No exclusive claim: a job that a worker holds is given to the next worker that asks. */
class SharedClaims extends Delegating {
  readonly #held: JobRecord[] = [];

  override async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: ClaimOptions,
  ): Promise<JobRecord | null> {
    const fresh = await this.inner.claim(kinds, worker, leaseMs, opts);
    if (fresh) {
      this.#held.push(fresh);
      return fresh;
    }
    const held = this.#held.find((j) => kinds.includes(j.kind));
    return held ? { ...held, lockedBy: worker } : null;
  }
}

/** No tenant boundary: a job is found by its identifier alone, whichever tenant asks. */
class ForgetsTenants extends Delegating {
  readonly #owner = new Map<string, string>();

  #ref(job: JobRef): JobRef {
    return { tenant: this.#owner.get(job.id) ?? job.tenant, id: job.id };
  }

  override async enqueue(tenant: string, job: NewJob): Promise<JobRecord> {
    const record = await this.inner.enqueue(tenant, job);
    this.#owner.set(record.id, record.tenant);
    return record;
  }
  override get(tenant: string, id: string): Promise<JobRecord | null> {
    return this.inner.get(this.#ref({ tenant, id }).tenant, id);
  }
  override cancel(tenant: string, id: string): Promise<JobRecord | null> {
    return this.inner.cancel(this.#ref({ tenant, id }).tenant, id);
  }
  override heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report?: { stage?: string; progress?: number },
  ): Promise<Heartbeat> {
    return this.inner.heartbeat(this.#ref(job), worker, leaseMs, report);
  }
  override complete(
    job: JobRef,
    worker: string,
    result: Record<string, unknown>,
  ): Promise<boolean> {
    return this.inner.complete(this.#ref(job), worker, result);
  }
}

/** No lock expiry: a job whose worker stopped is never offered to another worker. */
class LocksNeverPass extends Delegating {
  readonly #running = new Map<string, { ref: JobRef; worker: string }>();

  override async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: ClaimOptions,
  ): Promise<JobRecord | null> {
    for (const held of this.#running.values())
      await this.inner.heartbeat(held.ref, held.worker, 365 * 86_400_000);
    const job = await this.inner.claim(kinds, worker, leaseMs, opts);
    if (job) this.#running.set(job.id, { ref: { tenant: job.tenant, id: job.id }, worker });
    return job;
  }
}

describe('queue contract: queues that break a rule fail the suite', () => {
  const failedNames = async (wrap: (q: JobQueue) => JobQueue): Promise<string[]> =>
    (await failingQueueChecks(QUEUE_CHECKS, () => memoryHarness(wrap))).map(
      (f) => f.split(':')[0]!,
    );

  it('passes the in-memory queue through the same runner', async () => {
    expect(await failingQueueChecks(QUEUE_CHECKS, () => memoryHarness())).toEqual([]);
  });

  it('refuses a queue that gives one job to two workers', async () => {
    const failed = await failedNames((q) => new SharedClaims(q));
    expect(failed).toContain(
      'one worker holds a job at a time, and a claim carries the tenant of the job',
    );
    expect(failed).toContain('a result is stored once, by the worker that holds the job');
  });

  it('refuses a queue that lets another tenant reach a job', async () => {
    const failed = await failedNames((q) => new ForgetsTenants(q));
    expect(failed).toContain(
      'a new job is queued with the defaults and is read back by its tenant only',
    );
    expect(failed).toContain('another tenant cannot read, change, find or count a job');
    expect(failed).toContain(
      'cancel stops a queued or a running job and leaves a finished one as it is',
    );
  });

  it('refuses a queue whose locks never pass', async () => {
    const failed = await failedNames((q) => new LocksNeverPass(q));
    expect(failed).toEqual([
      'a lock that has passed gives the job to another worker with one more attempt, until none is left',
    ]);
  });
});
