-- phase: expand
-- rollback: none needed; the previous release ignores the new columns and the trigger changes
--   nothing it reads. A service or worker of the previous release does not add an attempt's worker
--   time when the attempt ends, so a tenant's compile minutes are complete only once every process
--   that runs export jobs is of this release.
--
-- The worker time of a job, kept with the job (EXP-009; 09 §9.1 and 06 §12: a monthly budget of
-- compile minutes for each tenant). The queue measures it in the database's clock: from each claim
-- to the end of that attempt, when the job completes, fails, is queued again, or is cancelled
-- while it runs. It is measured here and not in the process that runs the job, so that it is
-- counted whichever process that is (the export worker is a process of its own, ADR 0045) and
-- lasts as long as the job's row. An attempt whose worker stopped is not counted.
-- Proposed in docs/adr/0422-w2-EXP-009-compile-minutes-from-the-queue.md.

-- The time of the latest claim; null while the job has never been claimed.
alter table jobs add column claimed_at timestamptz;
-- The worker time of the attempts that ended, in milliseconds.
alter table jobs add column worker_ms bigint not null default 0 check (worker_ms >= 0);

-- The sum for a tenant and a period reads this index only (`PgJobQueue.workerTime`).
create index jobs_worker_time on jobs (tenant_id, finished_at) include (kind, worker_ms)
  where finished_at is not null and worker_ms > 0;

-- Every claim records its time, whichever claim function made it: a claim is the update that sets
-- the state to running with one more attempt (docedit_claim_job() and its later versions).
create function docedit_job_claimed()
  returns trigger
  language plpgsql
  set search_path = pg_catalog
  as $$
begin
  new.claimed_at := clock_timestamp();
  return new;
end
$$;

create trigger jobs_claimed
  before update of state on jobs
  for each row
  when (new.state = 'running' and new.attempts > old.attempts)
  execute function docedit_job_claimed();
