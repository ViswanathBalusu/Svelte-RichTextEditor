/**
 * The job queue port (06 §4.1 `jobs`, §14 `Queue`; BE-049) and its in-memory implementation.
 *
 * A job is claimed by one worker at a time and held under a lock that the worker renews with
 * heartbeats. A worker that dies stops renewing; once the lock has passed the job can be claimed
 * again, with one more attempt, until `maxAttempts`, after which it fails. States (decision of
 * ADR 0036; the spec names none): queued, running, completed, failed, cancelled. A running job
 * reports its `stage` (for an export: converting, compiling) and `progress`.
 *
 * Phase 1b (ADR 0054): jobs have a priority, and a claim takes the highest first, so that previews
 * (their own kind) start before a backlog of requested exports drains (BE-050, EXP-007); a tenant
 * that runs as many jobs of a kind as its limit gets no more of that kind until one ends; a job
 * may carry a cache key, so that the result of an earlier job for the same request is found
 * (EXP-006); and a job can be enqueued only if absent, which the scheduler's deterministic
 * identifiers use (BE-052).
 *
 * EXP-008: a job may carry a start gap. A claim then leaves it alone until that long after the
 * latest start of a job of the same tenant, document and kind, so that at most one of them starts
 * in any window of that length. A job's start is its claim, recorded as `startedAt`. A job may also
 * name the stage its real work begins with (for a preview: `compiling`, the start of its sandbox).
 * Its start then moves to the time it reports that stage, and until it has, no other job of the
 * document and kind is claimed, so the starts of that stage are a gap apart too, however long each
 * job takes to reach it.
 *
 * EXP-009: the queue measures the worker time of every job, from each claim to the end of that
 * attempt, in its own clock (`JobRecord.workerMs`), and sums it for a tenant and a period
 * (`workerTime`). It is measured here, and not by the runner, so that it is counted whichever
 * process runs the job and is kept with the job.
 */
import { uuid7 } from '@docedit/model';

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobError {
  /** A code of the registry (05 §5.8), for example `internal` or `validation_failed`. */
  code: string;
  /** Identifiers and rules only, never content (BE-088). */
  message: string;
}

export interface JobRecord {
  id: string;
  tenant: string;
  doc: string | null;
  kind: string;
  state: JobState;
  stage: string | null;
  progress: number | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: JobError | null;
  attempts: number;
  maxAttempts: number;
  /** Unix ms; a queued job is not claimed before it. */
  runAfter: number;
  lockedBy: string | null;
  lockedUntil: number | null;
  /** The requester's surrogate (BE-013), or `system`. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** Higher first (ADR 0054); 0 by default. */
  priority: number;
  /** What the job produces, for finding an earlier result (EXP-006): 64 hexadecimal digits. */
  cacheKey: string | null;
  /**
   * Unix ms of the job's latest start, in the queue's clock: its latest claim, or, for a job with a
   * `startGapStage`, the time it reported that stage in its latest attempt. Null while the job has
   * never started. Both queues always set it; it is optional so that a record written out by hand
   * stays valid.
   */
  startedAt?: number | null;
  /** See `NewJob.startGapMs`; null (or absent) when the job has none. */
  startGapMs?: number | null;
  /** See `NewJob.startGapStage`; null (or absent) when the job names none. */
  startGapStage?: string | null;
  /** Unix ms of the latest claim, in the queue's clock; null (or absent) while never claimed. */
  claimedAt?: number | null;
  /**
   * The worker time the job has used, ms, in the queue's clock (EXP-009): for every attempt that
   * ended, the time from its claim to its end. An attempt ends when it completes, fails, is queued
   * again, or is cancelled while it runs. An attempt whose worker stopped is not counted, because
   * nobody knows how long it worked. The queue measures it, whichever process runs the job.
   */
  workerMs?: number;
}

export interface NewJob {
  id?: string;
  doc?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdBy: string;
  maxAttempts?: number;
  /** Delay before the first claim, ms. */
  delayMs?: number;
  /**
   * No claim before this time, ms since the epoch, in the queue's own clock: a time derived from a
   * record the queue returned, such as another job's `createdAt` (BE-051). The later of this and
   * `delayMs` applies. It lets a caller hold a job behind another without comparing its own clock
   * with the queue's (06 §2.1).
   */
  notBefore?: number;
  priority?: number;
  cacheKey?: string;
  /**
   * The job is not claimed within this many milliseconds after the start of a job of the same
   * tenant, document and kind, itself included when it is tried again (06 §10: at most one
   * preview compile per document in ten seconds; EXP-008 criterion 2). The start is the claim, in
   * the queue's own clock, so the rule holds whenever the earlier job was asked for, however long
   * it waited for a worker, and for any number of waiting jobs. Needs `doc`; without one it has
   * no effect.
   */
  startGapMs?: number;
  /**
   * The stage the job's real work begins with (for a preview: `compiling`, the start of its
   * sandbox); needs `startGapMs`. When the job reports this stage, its start moves from its claim
   * to that time. While the job runs and has not reported it, no other job of the same tenant,
   * document and kind is claimed, because the stage may begin at any moment. So the starts of this
   * stage are a gap apart, and not only the claims, however long a job takes to reach it. A handler
   * that never reports the stage keeps the document's other jobs waiting until it ends.
   */
  startGapStage?: string;
  /** Creates the job already completed with this result: an earlier job's (EXP-006). */
  completedWith?: Record<string, unknown>;
  /** When a job with the same identifier exists, returns it and creates nothing (BE-052). */
  ifAbsent?: boolean;
}

export interface JobRef {
  tenant: string;
  id: string;
}

export type Heartbeat = 'ok' | 'cancelled' | 'lost';

export interface ClaimOptions {
  /**
   * Running jobs per tenant and kind when the tenant has no limit of its own (EXP-007 criterion
   * 3); null or absent: no limit.
   */
  defaultLimit?: number | null;
}

export interface QueueDepth {
  kind: string;
  priority: number;
  queued: number;
  running: number;
}

export interface JobQueue {
  enqueue(tenant: string, job: NewJob): Promise<JobRecord>;
  get(tenant: string, id: string): Promise<JobRecord | null>;
  /**
   * Claims the next ready job of one of `kinds`, across tenants, the highest priority first,
   * skipping tenants at their limit for the job's kind; null when none is ready.
   */
  claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts?: ClaimOptions,
  ): Promise<JobRecord | null>;
  /** Renews the lock and records the stage and progress; says whether the worker should go on. */
  heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report?: { stage?: string; progress?: number },
  ): Promise<Heartbeat>;
  /** Stores the result; false when the job is no longer this worker's (cancelled, or lost). */
  complete(job: JobRef, worker: string, result: Record<string, unknown>): Promise<boolean>;
  /**
   * Fails the attempt; with `retryAfterMs` and attempts left, the job is queued again. When the job
   * ends failed, `result` (if given) is kept as its result, for example an export's diagnostics.
   */
  fail(
    job: JobRef,
    worker: string,
    error: JobError,
    retryAfterMs?: number,
    result?: Record<string, unknown>,
  ): Promise<boolean>;
  /** Cancels a queued or running job; a finished job is returned unchanged; null if none. */
  cancel(tenant: string, id: string): Promise<JobRecord | null>;
  // --- Phase 1b (ADR 0054). --------------------------------------------------------------------
  /** The newest completed job of the tenant with `cacheKey` that finished at or after `since`. */
  findCompleted(tenant: string, cacheKey: string, since: number): Promise<JobRecord | null>;
  /** The newest job of `kind` for a document, whatever its state. */
  latestFor(tenant: string, doc: string, kind: string): Promise<JobRecord | null>;
  /**
   * The newest completed job of `kind` for a document whose result holds the string `value` at
   * its member `member`, finished at or after `since` (EXP-008 criterion 3: an earlier preview of
   * the same bundle). Never a job of another tenant or another document.
   */
  findCompletedWith(
    tenant: string,
    doc: string,
    kind: string,
    member: string,
    value: string,
    since: number,
  ): Promise<JobRecord | null>;
  /** Queued and running jobs by kind and priority, across tenants (BE-050 criterion 5). */
  depth(): Promise<QueueDepth[]>;
  /** Sets a tenant's limit of running jobs for a kind, or clears it with null (EXP-007). */
  setLimit(tenant: string, kind: string, maxRunning: number | null): Promise<void>;
  /** The tenant's jobs of `kind` that are queued or running (BE-092: export concurrency). */
  activeCount(tenant: string, kind: string): Promise<number>;
  /**
   * The worker time, ms, of the tenant's jobs of `kinds` that ended at or after `from` and before
   * `to`, both in Unix ms (EXP-009: the compile minutes of a month). A job counts once, with all
   * its attempts (`JobRecord.workerMs`), at the time it ended; one that has not ended does not
   * count yet. Never a job of another tenant.
   */
  workerTime(tenant: string, kinds: readonly string[], from: number, to: number): Promise<number>;
}

/** Defaults of the queue, settings rather than measurements (ADR 0036). */
export const QUEUE_DEFAULTS = { maxAttempts: 3 } as const;

const KIND = /^[a-z][a-z0-9_.-]{0,63}$/;
const CACHE_KEY = /^[0-9a-f]{64}$/;

/** The longest start gap a job may ask for: a day (a bound for the check, not a spec figure). */
export const MAX_START_GAP_MS = 24 * 60 * 60 * 1000;

export function checkNewJob(job: NewJob): void {
  if (!KIND.test(job.kind)) throw new RangeError('a job kind is a lower-case name');
  const max = job.maxAttempts ?? QUEUE_DEFAULTS.maxAttempts;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('maxAttempts is at least 1');
  if (job.notBefore !== undefined && !Number.isFinite(job.notBefore))
    throw new RangeError('notBefore is a time in milliseconds');
  if (job.priority !== undefined && !Number.isSafeInteger(job.priority))
    throw new RangeError('a priority is an integer');
  if (job.cacheKey !== undefined && !CACHE_KEY.test(job.cacheKey))
    throw new RangeError('a cache key is a SHA-256 in hexadecimal');
  if (
    job.startGapMs !== undefined &&
    (!Number.isSafeInteger(job.startGapMs) ||
      job.startGapMs < 0 ||
      job.startGapMs > MAX_START_GAP_MS)
  )
    throw new RangeError('a start gap is a whole number of milliseconds, at most a day');
  if (job.startGapStage !== undefined) {
    if (!KIND.test(job.startGapStage))
      throw new RangeError('a start gap stage is a lower-case name');
    if (job.startGapMs === undefined) throw new RangeError('a start gap stage needs a start gap');
  }
}

export function checkLimit(kind: string, maxRunning: number | null): void {
  if (!KIND.test(kind)) throw new RangeError('a job kind is a lower-case name');
  if (maxRunning !== null && (!Number.isSafeInteger(maxRunning) || maxRunning < 0))
    throw new RangeError('a limit is a non-negative integer');
}

export class MemoryJobQueue implements JobQueue {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #limits = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #find(job: JobRef): JobRecord | undefined {
    const j = this.#jobs.get(job.id);
    return j && j.tenant === job.tenant ? j : undefined;
  }

  async enqueue(tenant: string, job: NewJob): Promise<JobRecord> {
    checkNewJob(job);
    const now = this.#now();
    const id = job.id ?? uuid7(now);
    const existing = this.#jobs.get(id);
    if (existing) {
      if (job.ifAbsent && existing.tenant === tenant) return structuredClone(existing);
      throw new Error(`job ${id} exists`);
    }
    const done = job.completedWith !== undefined;
    const record: JobRecord = {
      id,
      tenant,
      doc: job.doc ?? null,
      kind: job.kind,
      state: done ? 'completed' : 'queued',
      stage: null,
      progress: done ? 100 : null,
      payload: structuredClone(job.payload),
      result: done ? structuredClone(job.completedWith!) : null,
      error: null,
      attempts: 0,
      maxAttempts: job.maxAttempts ?? QUEUE_DEFAULTS.maxAttempts,
      runAfter: Math.max(now + (job.delayMs ?? 0), job.notBefore ?? -Infinity),
      lockedBy: null,
      lockedUntil: null,
      createdBy: job.createdBy,
      createdAt: now,
      updatedAt: now,
      finishedAt: done ? now : null,
      priority: job.priority ?? 0,
      cacheKey: job.cacheKey ?? null,
      startedAt: null,
      startGapMs: job.startGapMs ?? null,
      startGapStage: job.startGapStage ?? null,
      claimedAt: null,
      workerMs: 0,
    };
    this.#jobs.set(record.id, record);
    return structuredClone(record);
  }

  /** The worker time of `j` with the attempt that ends at `now` added (`JobRecord.workerMs`). */
  #workerMsAt(j: JobRecord, now: number): number {
    return (j.workerMs ?? 0) + Math.max(0, now - (j.claimedAt ?? now));
  }

  /** The latest start of a job of the tenant, document and kind; null when none has started. */
  #lastStart(tenant: string, doc: string, kind: string): number | null {
    let last: number | null = null;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        j.doc === doc &&
        j.kind === kind &&
        typeof j.startedAt === 'number' &&
        (last === null || j.startedAt > last)
      )
        last = j.startedAt;
    return last;
  }

  /**
   * Whether another job of the tenant, document and kind runs under a live lock and has not yet
   * reported its start stage: its real start may come at any moment (`NewJob.startGapStage`).
   */
  #startPending(of: JobRecord, now: number): boolean {
    for (const j of this.#jobs.values())
      if (
        j.id !== of.id &&
        j.tenant === of.tenant &&
        j.doc === of.doc &&
        j.kind === of.kind &&
        j.state === 'running' &&
        (j.lockedUntil ?? 0) >= now &&
        (j.startGapStage ?? null) !== null &&
        j.stage !== j.startGapStage
      )
        return true;
    return false;
  }

  async get(tenant: string, id: string): Promise<JobRecord | null> {
    const j = this.#find({ tenant, id });
    return j ? structuredClone(j) : null;
  }

  #running(tenant: string, kind: string, except: string, now: number): number {
    let n = 0;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        j.kind === kind &&
        j.state === 'running' &&
        (j.lockedUntil ?? 0) >= now &&
        j.id !== except
      )
        n++;
    return n;
  }

  async claim(
    kinds: readonly string[],
    worker: string,
    leaseMs: number,
    opts: ClaimOptions = {},
  ): Promise<JobRecord | null> {
    const now = this.#now();
    const ready = [...this.#jobs.values()]
      .filter(
        (j) =>
          kinds.includes(j.kind) &&
          ((j.state === 'queued' && j.runAfter <= now) ||
            (j.state === 'running' && (j.lockedUntil ?? 0) < now)),
      )
      .sort((a, b) => b.priority - a.priority || a.runAfter - b.runAfter || (a.id < b.id ? -1 : 1));
    for (const j of ready) {
      if (j.state === 'running' && j.attempts >= j.maxAttempts) {
        Object.assign(j, {
          state: 'failed',
          lockedBy: null,
          lockedUntil: null,
          finishedAt: now,
          updatedAt: now,
          error: { code: 'internal', message: 'the worker stopped and no attempts are left' },
        });
        continue;
      }
      // The start gap (EXP-008 criterion 2): no start while another job of the same document and
      // kind is about to start its stage, nor within the gap after the latest start of one. A
      // waiting job is held until the gap has passed.
      const gap = j.startGapMs ?? null;
      if (gap !== null && j.doc !== null) {
        if (this.#startPending(j, now)) continue;
        const last = this.#lastStart(j.tenant, j.doc, j.kind);
        if (last !== null && last + gap > now) {
          if (j.state === 'queued') j.runAfter = Math.max(j.runAfter, last + gap);
          continue;
        }
      }
      const limit = this.#limits.get(`${j.tenant}/${j.kind}`) ?? opts.defaultLimit ?? null;
      if (limit !== null && this.#running(j.tenant, j.kind, j.id, now) >= limit) continue;
      Object.assign(j, {
        state: 'running',
        attempts: j.attempts + 1,
        lockedBy: worker,
        lockedUntil: now + leaseMs,
        startedAt: now,
        claimedAt: now,
        updatedAt: now,
        // A new attempt has reported no stage yet: what an earlier attempt reported is cleared, so
        // that the job counts as not yet started until it reports its start stage again.
        ...((j.startGapStage ?? null) !== null ? { stage: null, progress: null } : {}),
      });
      return structuredClone(j);
    }
    return null;
  }

  #owned(job: JobRef, worker: string): JobRecord | undefined {
    const j = this.#find(job);
    return j && j.state === 'running' && j.lockedBy === worker ? j : undefined;
  }

  async heartbeat(
    job: JobRef,
    worker: string,
    leaseMs: number,
    report: { stage?: string; progress?: number } = {},
  ): Promise<Heartbeat> {
    const found = this.#find(job);
    if (found?.state === 'cancelled') return 'cancelled';
    const j = this.#owned(job, worker);
    if (!j) return 'lost';
    const now = this.#now();
    j.lockedUntil = now + leaseMs;
    if (report.stage !== undefined) {
      // The job reports its start stage for the first time in this attempt: that is its start.
      const startStage = j.startGapStage ?? null;
      if (startStage !== null && report.stage === startStage && j.stage !== startStage)
        j.startedAt = now;
      j.stage = report.stage;
    }
    if (report.progress !== undefined) j.progress = report.progress;
    j.updatedAt = now;
    return 'ok';
  }

  async complete(job: JobRef, worker: string, result: Record<string, unknown>): Promise<boolean> {
    const j = this.#owned(job, worker);
    if (!j) return false;
    const now = this.#now();
    Object.assign(j, {
      state: 'completed',
      result: structuredClone(result),
      progress: 100,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: now,
      updatedAt: now,
      workerMs: this.#workerMsAt(j, now),
    });
    return true;
  }

  async fail(
    job: JobRef,
    worker: string,
    error: JobError,
    retryAfterMs?: number,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    const j = this.#owned(job, worker);
    if (!j) return false;
    const now = this.#now();
    const again = retryAfterMs !== undefined && j.attempts < j.maxAttempts;
    Object.assign(j, {
      state: again ? 'queued' : 'failed',
      result: !again && result ? structuredClone(result) : j.result,
      error: { ...error },
      lockedBy: null,
      lockedUntil: null,
      runAfter: again ? now + retryAfterMs : j.runAfter,
      finishedAt: again ? null : now,
      updatedAt: now,
      // The attempt ends here, whether or not the job is tried again.
      workerMs: this.#workerMsAt(j, now),
    });
    return true;
  }

  async cancel(tenant: string, id: string): Promise<JobRecord | null> {
    const j = this.#find({ tenant, id });
    if (!j) return null;
    if (j.state === 'queued' || j.state === 'running') {
      const now = this.#now();
      Object.assign(j, {
        // A job cancelled while it runs has used its worker until now.
        ...(j.state === 'running' ? { workerMs: this.#workerMsAt(j, now) } : {}),
        state: 'cancelled',
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
        updatedAt: now,
      });
    }
    return structuredClone(j);
  }

  async findCompleted(tenant: string, cacheKey: string, since: number): Promise<JobRecord | null> {
    let best: JobRecord | null = null;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        j.state === 'completed' &&
        j.cacheKey === cacheKey &&
        (j.finishedAt ?? 0) >= since &&
        (!best || (j.finishedAt ?? 0) > (best.finishedAt ?? 0))
      )
        best = j;
    return best ? structuredClone(best) : null;
  }

  async latestFor(tenant: string, doc: string, kind: string): Promise<JobRecord | null> {
    let best: JobRecord | null = null;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        j.doc === doc &&
        j.kind === kind &&
        (!best ||
          j.createdAt > best.createdAt ||
          (j.createdAt === best.createdAt && j.id > best.id))
      )
        best = j;
    return best ? structuredClone(best) : null;
  }

  async findCompletedWith(
    tenant: string,
    doc: string,
    kind: string,
    member: string,
    value: string,
    since: number,
  ): Promise<JobRecord | null> {
    let best: JobRecord | null = null;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        j.doc === doc &&
        j.kind === kind &&
        j.state === 'completed' &&
        j.result !== null &&
        Object.hasOwn(j.result, member) &&
        j.result[member] === value &&
        (j.finishedAt ?? 0) >= since &&
        (!best ||
          (j.finishedAt ?? 0) > (best.finishedAt ?? 0) ||
          ((j.finishedAt ?? 0) === (best.finishedAt ?? 0) && j.id > best.id))
      )
        best = j;
    return best ? structuredClone(best) : null;
  }

  async depth(): Promise<QueueDepth[]> {
    const out = new Map<string, QueueDepth>();
    for (const j of this.#jobs.values()) {
      if (j.state !== 'queued' && j.state !== 'running') continue;
      const k = `${j.kind}\u0000${j.priority}`;
      let d = out.get(k);
      if (!d) out.set(k, (d = { kind: j.kind, priority: j.priority, queued: 0, running: 0 }));
      if (j.state === 'queued') d.queued++;
      else d.running++;
    }
    return [...out.values()].sort((a, b) =>
      a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.priority - b.priority,
    );
  }

  async activeCount(tenant: string, kind: string): Promise<number> {
    let n = 0;
    for (const j of this.#jobs.values())
      if (j.tenant === tenant && j.kind === kind && (j.state === 'queued' || j.state === 'running'))
        n++;
    return n;
  }

  async setLimit(tenant: string, kind: string, maxRunning: number | null): Promise<void> {
    checkLimit(kind, maxRunning);
    if (maxRunning === null) this.#limits.delete(`${tenant}/${kind}`);
    else this.#limits.set(`${tenant}/${kind}`, maxRunning);
  }

  async workerTime(
    tenant: string,
    kinds: readonly string[],
    from: number,
    to: number,
  ): Promise<number> {
    let ms = 0;
    for (const j of this.#jobs.values())
      if (
        j.tenant === tenant &&
        kinds.includes(j.kind) &&
        j.finishedAt !== null &&
        j.finishedAt >= from &&
        j.finishedAt < to
      )
        ms += j.workerMs ?? 0;
    return ms;
  }
}
