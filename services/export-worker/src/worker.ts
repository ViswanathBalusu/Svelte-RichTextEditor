/**
 * The export worker as a queue consumer (09 §9.5; BE-049; EXP-001; EXP-007): a JobRunner over the
 * control plane's job queue that runs the handler of job.ts for the job kinds `export` (requested
 * exports) and `preview` (previews, claimed first by the queue's priorities). It holds no HTTP port.
 * In production the queue is PostgreSQL (`docedit_claim_job`, any tenant) and storage is the
 * service's database and bucket; in tests the parts of an in-process document service are passed.
 *
 * Workers are stateless: a claimed job is everything the worker knows, and each job compiles in
 * its own sandbox (EXP-007 criterion 4; EXP-070). A deployment can give previews and exports
 * workers of their own with `kinds` (EXP-007).
 *
 * The same handlers can instead run inside the document service, registered with
 * `startService({ jobHandlers: exportJobHandlers(deps) })`; the service's runner then also turns
 * progress and outcomes into `export.*` notifications and webhooks through its hooks, which a
 * separate worker process does not have.
 */
import {
  JobRunner,
  type JobHandler,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { createExportHandler, type ExportHandlerDeps, type ExportMetrics } from './job.ts';

/** The job kinds of the control plane's exports (exports.ts of the document service). */
export const EXPORT_JOB_KINDS = ['export', 'preview'] as const;

/** The handlers to register for both kinds, in a JobRunner or in `startService`. */
export function exportJobHandlers(deps: ExportHandlerDeps): Record<string, JobHandler> {
  const handler = createExportHandler(deps);
  return Object.fromEntries(EXPORT_JOB_KINDS.map((k) => [k, handler]));
}

/** The runner's hooks (progress and outcomes), as the document service's runner takes them. */
type JobHooks = NonNullable<ConstructorParameters<typeof JobRunner>[0]['hooks']>;

export interface ExportWorkerOptions {
  queue: JobQueue;
  /** Everything the handler needs; see ExportHandlerDeps. */
  deps: ExportHandlerDeps;
  /** This worker's identifier, recorded in the job's `locked_by`. */
  worker: string;
  /** Lease of a claim without a heartbeat, ms (the service's DOCEDIT_JOB_LEASE_MS). */
  leaseMs: number;
  idleMs: number;
  retryAfterMs: number;
  /** The kinds this worker claims; default both. */
  kinds?: readonly string[];
  /** Jobs run at once (default 1: one sandbox of one core and 1.5 GiB at a time). */
  concurrency?: number;
  hooks?: JobHooks;
  onError?: (error: unknown, job: JobRecord) => void;
}

export interface ExportWorker {
  runner: JobRunner;
  /** Claims and runs one job now; false when none was ready. */
  runOnce(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export function createExportWorker(o: ExportWorkerOptions): ExportWorker {
  const runner = new JobRunner({
    queue: o.queue,
    handlers: exportJobHandlers(o.deps),
    ...(o.kinds ? { kinds: o.kinds } : {}),
    worker: o.worker,
    leaseMs: o.leaseMs,
    idleMs: o.idleMs,
    retryAfterMs: o.retryAfterMs,
    ...(o.concurrency ? { concurrency: o.concurrency } : {}),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.onError ? { onError: o.onError } : {}),
  });
  return {
    runner,
    runOnce: () => runner.runOnce(),
    start: () => runner.start(),
    stop: () => runner.stop(),
  };
}

export type { ExportMetrics };
