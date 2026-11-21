/**
 * The job queue in PostgreSQL (migrations 0006, 0041 and 0096; BE-049; 06 §4.1 notes). Claims go
 * through `docedit_claim_job_v3`, which picks across tenants with FOR UPDATE SKIP LOCKED, the
 * highest priority first, skipping tenants at their limit for the job's kind and jobs still inside
 * their start gap (EXP-008), records the start, and returns the row;
 * everything after the claim runs under the row's tenant (BE-049 criterion 5; BE-011). Times are
 * the database's, as for ownership (06 §2.1): no comparison of clocks of different machines. The
 * start of a job with a start stage moves to the time its heartbeat reports that stage.
 */
import { uuid7 } from '@docedit/model';
import { inTenant, int, isUuid, millis, type Pool, type Queryable } from '../../storage/db.ts';
import {
  checkLimit,
  checkNewJob,
  QUEUE_DEFAULTS,
  type ClaimOptions,
  type Heartbeat,
  type JobError,
  type JobQueue,
  type JobRecord,
  type JobRef,
  type JobState,
  type NewJob,
  type QueueDepth,
} from './queue.ts';

interface JobRow {
  id: string;
  tenant_id: string;
  doc_id: string | null;
  kind: string;
  state: JobState;
  stage: string | null;
  progress: number | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: JobError | null;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_by: string | null;
  locked_until: Date | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  priority: number;
  cache_key: string | null;
  started_at: Date | null;
  start_gap_ms: number | null;
  start_gap_stage: string | null;
  claimed_at: Date | null;
  worker_ms: string | number | null;
}

/**
 * The worker time of the attempt that ends with this statement, added to what the job has used
 * (EXP-009; `JobRecord.workerMs`): from the claim to now, in the database's clock. A job claimed
 * by a worker of a release that did not record the claim adds nothing.
 */
const WORKER_MS_NOW = `worker_ms + greatest(0, floor(extract(epoch FROM (clock_timestamp() - coalesce(claimed_at, clock_timestamp()))) * 1000))::bigint`;

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id,
    tenant: r.tenant_id,
    doc: r.doc_id,
    kind: r.kind,
    state: r.state,
    stage: r.stage,
    progress: r.progress,
    payload: r.payload,
    result: r.result,
    error: r.error,
    attempts: int(r.attempts),
    maxAttempts: int(r.max_attempts),
    runAfter: millis(r.run_after)!,
    lockedBy: r.locked_by,
    lockedUntil: millis(r.locked_until),
    createdBy: r.created_by,
    createdAt: millis(r.created_at)!,
    updatedAt: millis(r.updated_at)!,
    finishedAt: millis(r.finished_at),
    priority: int(r.priority ?? 0),
    cacheKey: r.cache_key ?? null,
    startedAt: millis(r.started_at ?? null),
    startGapMs:
      r.start_gap_ms === null || r.start_gap_ms === undefined ? null : int(r.start_gap_ms),
    startGapStage: r.start_gap_stage ?? null,
    claimedAt: millis(r.claimed_at ?? null),
    workerMs: int(r.worker_ms ?? 0),
  };
}

async function one(c: Queryable, id: string): Promise<JobRecord | null> {
  const r = await c.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
  return r.rows[0] ? toRecord(r.rows[0]) : null;
}

const interval = (ms: number) => `${Math.max(0, Math.round(ms))} milliseconds`;

export class PgJobQueue implements JobQueue {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  enqueue(tenant: string, job: NewJob): Promise<JobRecord> {
    checkNewJob(job);
    const id = job.id ?? uuid7();
    const done = job.completedWith !== undefined;
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query<JobRow>(
        `INSERT INTO jobs (id, tenant_id, doc_id, kind, state, payload, result, progress, attempts,
                           max_attempts, run_after, created_by, created_at, updated_at,
                           finished_at, priority, cache_key, start_gap_ms, start_gap_stage)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, 0, $9,
                 greatest(now() + $10::interval, $15::timestamptz), $11,
                 now(), now(), CASE WHEN $12::boolean THEN now() END, $13, $14, $16, $17)
         ${job.ifAbsent ? 'ON CONFLICT (id) DO NOTHING' : ''}
         RETURNING *`,
        [
          id,
          tenant,
          job.doc ?? null,
          job.kind,
          done ? 'completed' : 'queued',
          JSON.stringify(job.payload),
          done ? JSON.stringify(job.completedWith) : null,
          done ? 100 : null,
          job.maxAttempts ?? QUEUE_DEFAULTS.maxAttempts,
          interval(job.delayMs ?? 0),
          job.createdBy,
          done,
          job.priority ?? 0,
          job.cacheKey ?? null,
          // A time from a record of this queue, so in the database's clock (06 §2.1).
          job.notBefore !== undefined ? new Date(job.notBefore).toISOString() : null,
          job.startGapMs ?? null,
          job.startGapStage ?? null,
        ],
      );
      if (r.rows[0]) return toRecord(r.rows[0]);
      // ifAbsent and the job exists: return it, under this tenant only.
      const existing = await one(c, id);
      if (!existing) throw new Error(`job ${id} exists for another tenant`);
      return existing;
    });
  }

  get(tenant: string, id: string): Promise<JobRecord | null> {
    // The id column is uuid: a bare identifier that is not one names no job (a 404, not a 500).
    if (!isUuid(id)) return Promise.resolve(null);
    return inTenant(this.#pool, tenant, (c) => one(c, id), { readOnly: true });
  }

  async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts: ClaimOptions = {},
  ): Promise<JobRecord | null> {
    // v3 keeps the start gap of a job and records each start (migration 0096; EXP-008).
    const r = await this.#pool.query<JobRow>('SELECT * FROM docedit_claim_job_v3($1, $2, $3, $4)', [
      [...kinds],
      worker,
      Math.max(1, Math.round(leaseMs)),
      opts.defaultLimit ?? null,
    ]);
    return r.rows[0] ? toRecord(r.rows[0]) : null;
  }

  heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report: { stage?: string; progress?: number } = {},
  ): Promise<Heartbeat> {
    return inTenant(this.#pool, job.tenant, async (c) => {
      // A job that reports its start stage for the first time in this attempt starts then (EXP-008;
      // `NewJob.startGapStage`). Every expression reads the row as it was before this update.
      const r = await c.query(
        `UPDATE jobs SET locked_until = now() + $3::interval,
                         started_at = CASE WHEN $4::text IS NOT NULL AND $4::text = start_gap_stage
                                                AND stage IS DISTINCT FROM start_gap_stage
                                           THEN clock_timestamp() ELSE started_at END,
                         stage = coalesce($4, stage), progress = coalesce($5, progress),
                         updated_at = now()
          WHERE id = $1 AND state = 'running' AND locked_by = $2`,
        [job.id, worker, interval(leaseMs), report.stage ?? null, report.progress ?? null],
      );
      if (r.rowCount === 1) return 'ok';
      const cur = await one(c, job.id);
      return cur?.state === 'cancelled' ? 'cancelled' : 'lost';
    });
  }

  complete(job: JobRef, worker: string, result: Record<string, unknown>): Promise<boolean> {
    return inTenant(this.#pool, job.tenant, async (c) => {
      const r = await c.query(
        `UPDATE jobs SET state = 'completed', result = $3::jsonb, progress = 100,
                         locked_by = NULL, locked_until = NULL, finished_at = now(), updated_at = now(),
                         worker_ms = ${WORKER_MS_NOW}
          WHERE id = $1 AND state = 'running' AND locked_by = $2`,
        [job.id, worker, JSON.stringify(result)],
      );
      return r.rowCount === 1;
    });
  }

  fail(
    job: JobRef,
    worker: string,
    error: JobError,
    retryAfterMs?: number,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    return inTenant(this.#pool, job.tenant, async (c) => {
      const r = await c.query(
        `UPDATE jobs
            SET state = CASE WHEN $4::boolean AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
                run_after = CASE WHEN $4::boolean AND attempts < max_attempts
                                 THEN now() + $5::interval ELSE run_after END,
                finished_at = CASE WHEN $4::boolean AND attempts < max_attempts THEN NULL ELSE now() END,
                result = CASE WHEN $4::boolean AND attempts < max_attempts
                              THEN result ELSE coalesce($6::jsonb, result) END,
                error = $3::jsonb, locked_by = NULL, locked_until = NULL, updated_at = now(),
                worker_ms = ${WORKER_MS_NOW}
          WHERE id = $1 AND state = 'running' AND locked_by = $2`,
        [
          job.id,
          worker,
          JSON.stringify(error),
          retryAfterMs !== undefined,
          interval(retryAfterMs ?? 0),
          result ? JSON.stringify(result) : null,
        ],
      );
      return r.rowCount === 1;
    });
  }

  cancel(tenant: string, id: string): Promise<JobRecord | null> {
    // As in `get`: an identifier that is not a UUID names no job, so there is none to cancel.
    if (!isUuid(id)) return Promise.resolve(null);
    return inTenant(this.#pool, tenant, async (c) => {
      // A job cancelled while it runs has used its worker until now (EXP-009). Every expression
      // reads the row as it was before this update.
      await c.query(
        `UPDATE jobs SET state = 'cancelled', locked_by = NULL, locked_until = NULL,
                         finished_at = now(), updated_at = now(),
                         worker_ms = CASE WHEN state = 'running' THEN ${WORKER_MS_NOW}
                                          ELSE worker_ms END
          WHERE id = $1 AND state IN ('queued', 'running')`,
        [id],
      );
      return one(c, id);
    });
  }

  findCompleted(tenant: string, cacheKey: string, since: number): Promise<JobRecord | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<JobRow>(
          `SELECT * FROM jobs
            WHERE tenant_id = $1 AND state = 'completed' AND cache_key = $2 AND finished_at >= $3
            ORDER BY finished_at DESC LIMIT 1`,
          [tenant, cacheKey, new Date(since).toISOString()],
        );
        return r.rows[0] ? toRecord(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  latestFor(tenant: string, doc: string, kind: string): Promise<JobRecord | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<JobRow>(
          `SELECT * FROM jobs WHERE tenant_id = $1 AND doc_id = $2 AND kind = $3
            ORDER BY created_at DESC, id DESC LIMIT 1`,
          [tenant, doc, kind],
        );
        return r.rows[0] ? toRecord(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  findCompletedWith(
    tenant: string,
    doc: string,
    kind: string,
    member: string,
    value: string,
    since: number,
  ): Promise<JobRecord | null> {
    // The doc column is uuid: an identifier that is not one names no job.
    if (!isUuid(doc)) return Promise.resolve(null);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<JobRow>(
          `SELECT * FROM jobs
            WHERE tenant_id = $1 AND doc_id = $2 AND kind = $3 AND state = 'completed'
              AND jsonb_typeof(result -> $4) = 'string' AND result ->> $4 = $5
              AND finished_at >= $6
            ORDER BY finished_at DESC, id DESC LIMIT 1`,
          [tenant, doc, kind, member, value, new Date(since).toISOString()],
        );
        return r.rows[0] ? toRecord(r.rows[0]) : null;
      },
      { readOnly: true },
    );
  }

  async depth(): Promise<QueueDepth[]> {
    const r = await this.#pool.query<{
      kind: string;
      priority: number;
      queued: string;
      running: string;
    }>('SELECT * FROM docedit_job_depth()');
    return r.rows.map((x) => ({
      kind: x.kind,
      priority: int(x.priority),
      queued: int(x.queued),
      running: int(x.running),
    }));
  }

  activeCount(tenant: string, kind: string): Promise<number> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM jobs
            WHERE tenant_id = $1 AND kind = $2 AND state IN ('queued', 'running')`,
          [tenant, kind],
        );
        return Number(r.rows[0]?.n ?? '0');
      },
      { readOnly: true },
    );
  }

  workerTime(tenant: string, kinds: readonly string[], from: number, to: number): Promise<number> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ ms: string }>(
          `SELECT coalesce(sum(worker_ms), 0)::text AS ms FROM jobs
            WHERE tenant_id = $1 AND kind = ANY($2::text[])
              AND finished_at >= $3 AND finished_at < $4 AND worker_ms > 0`,
          [tenant, [...kinds], new Date(from).toISOString(), new Date(to).toISOString()],
        );
        return Number(r.rows[0]?.ms ?? '0');
      },
      { readOnly: true },
    );
  }

  setLimit(tenant: string, kind: string, maxRunning: number | null): Promise<void> {
    checkLimit(kind, maxRunning);
    return inTenant(this.#pool, tenant, async (c) => {
      if (maxRunning === null)
        await c.query('DELETE FROM tenant_job_limits WHERE tenant_id = $1 AND kind = $2', [
          tenant,
          kind,
        ]);
      else
        await c.query(
          `INSERT INTO tenant_job_limits (tenant_id, kind, max_running) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, kind) DO UPDATE SET max_running = excluded.max_running`,
          [tenant, kind, maxRunning],
        );
    });
  }
}
