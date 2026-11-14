/**
 * Scheduled maintenance (06 §1 "Scheduler"; BE-052; ADR 0054).
 *
 * A task runs every `everyMs`. Each run is a job of kind `schedule` in the job queue, with an
 * identifier derived from the task and its time slot, so that however many service instances
 * start, a slot has one job, and the queue's claim gives it to one worker (criterion 1). The run
 * first enqueues the next slot's job and only then does its work, so a failed run never loses the
 * next one, and the schedule lives in the database across restarts (criterion 3). A task that works
 * on tenants' data runs once per tenant and is given that tenant; the store it calls sets the
 * tenant's context (`inTenant`). A task that deletes data skips a tenant for which `onHold` says
 * yes. That is the mechanism of criterion 4 only: no hold store exists yet (HIS-031, phase 2), so
 * `src/server.ts` passes no `onHold` and nothing is skipped in the running service. 08 §11 places
 * a hold on a document, not a tenant, so the shape of this hook is open (ADR 0104).
 * Every run and failure is counted in the metrics.
 *
 * Platform jobs belong to the nil tenant, `00000000-0000-0000-0000-000000000000`, which no tenant
 * can have (tenants are random UUIDs): the job row needs a tenant for row-level security.
 */
import { createHash } from 'node:crypto';
import type { JobHandler } from './jobs/runner.ts';
import type { JobQueue } from './jobs/queue.ts';
import type { Metrics } from './metrics.ts';

export const SCHEDULE_KIND = 'schedule';
export const PLATFORM_TENANT = '00000000-0000-0000-0000-000000000000';

export interface ScheduledTask {
  /** A lower-case name, for example `idempotency.purge`. */
  name: string;
  everyMs: number;
  /** What a run does once for the deployment (for example creating audit partitions). */
  run?: (now: number) => Promise<void>;
  /** What a run does for each tenant, under that tenant's context. Returns a count, if any. */
  forTenant?: (tenant: string, now: number) => Promise<unknown>;
  /** Whether the task deletes data: it then skips tenants under a legal hold (criterion 4). */
  deletes?: boolean;
}

export interface SchedulerOptions {
  queue: JobQueue;
  tasks: readonly ScheduledTask[];
  /** The tenants of the deployment (`docedit_tenant_ids()`). */
  tenants: () => Promise<readonly string[]>;
  /**
   * Whether a tenant's data is under a legal hold. Not passed by `src/server.ts` until the hold
   * store of HIS-031 (phase 2) exists; without it no tenant is skipped.
   */
  onHold?: (tenant: string) => Promise<boolean>;
  metrics?: Metrics;
  now: () => number;
  onError?: (error: unknown, task: string) => void;
}

/** A UUID (version 8, RFC 9562) derived from a name: the same name gives the same identifier. */
export function uuidFromName(name: string): string {
  const b = createHash('sha256').update(name, 'utf8').digest().subarray(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Scheduler {
  readonly #o: SchedulerOptions;
  readonly #tasks: ReadonlyMap<string, ScheduledTask>;

  constructor(opts: SchedulerOptions) {
    this.#o = opts;
    this.#tasks = new Map(opts.tasks.map((t) => [t.name, t]));
    for (const t of opts.tasks)
      if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(t.name) || !(t.everyMs >= 1000))
        throw new RangeError(`scheduled task ${t.name}: a lower-case name and at least a second`);
  }

  /** The job identifier of a task's slot. */
  static jobId(task: string, slot: number): string {
    return uuidFromName(`docedit.schedule\n${task}\n${slot}`);
  }

  async #enqueue(task: ScheduledTask, slot: number): Promise<void> {
    const start = slot * task.everyMs;
    await this.#o.queue.enqueue(PLATFORM_TENANT, {
      id: Scheduler.jobId(task.name, slot),
      kind: SCHEDULE_KIND,
      payload: { task: task.name, slot },
      createdBy: 'system',
      delayMs: Math.max(0, start - this.#o.now()),
      maxAttempts: 1,
      ifAbsent: true,
    });
  }

  /** Makes sure every task has the job of its current slot; safe to call from every instance. */
  async ensure(): Promise<void> {
    const now = this.#o.now();
    for (const t of this.#tasks.values()) await this.#enqueue(t, Math.floor(now / t.everyMs));
  }

  #count(task: string, outcome: 'ok' | 'failed', n = 1): void {
    this.#o.metrics?.inc(
      'docedit_scheduled_runs_total',
      'Runs of scheduled maintenance tasks by outcome (BE-052).',
      { task, outcome },
      n,
    );
  }

  /** The handler of kind `schedule`, for the job runner. */
  readonly handler: JobHandler = async (job) => {
    const name = String(job.payload['task']);
    const slot = Number(job.payload['slot']);
    const task = this.#tasks.get(name);
    if (!task) return { skipped: 'unknown task' };
    // The next run is queued before this one works, so a failure here cannot lose it.
    await this.#enqueue(task, Math.max(slot + 1, Math.floor(this.#o.now() / task.everyMs) + 1));
    const now = this.#o.now();
    let failures = 0;
    let count = 0;
    try {
      if (task.run) await task.run(now);
      if (task.forTenant)
        for (const tenant of await this.#o.tenants()) {
          if (task.deletes && (await this.#o.onHold?.(tenant))) continue;
          try {
            const n = await task.forTenant(tenant, now);
            if (typeof n === 'number') count += n;
          } catch (e) {
            failures++;
            this.#o.onError?.(e, name);
          }
        }
    } catch (e) {
      failures++;
      this.#o.onError?.(e, name);
    }
    this.#count(name, failures ? 'failed' : 'ok');
    if (!failures)
      this.#o.metrics?.inc(
        'docedit_scheduled_items_total',
        'Items handled by scheduled maintenance tasks (BE-052).',
        { task: name },
        count,
      );
    return { task: name, slot, failures, count };
  };
}
