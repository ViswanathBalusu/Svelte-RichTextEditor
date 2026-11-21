-- phase: expand
-- rollback: none needed; the previous release claims with docedit_claim_job_v2(), which stays, and
--   ignores the new columns. A worker of the previous release does not keep the start gap and does
--   not record a start, so the rule holds only once every worker claims with docedit_claim_job_v3().
--
-- At most one preview compile per document starts in any ten seconds (06 §10; 09 §9.1; EXP-008
-- criterion 2). The rule is kept where a job starts, at the claim: a job may carry a start gap, and
-- a claim leaves it alone until that long after the latest start of a job of the same tenant,
-- document and kind. The start is the claim, in the database's clock (06 §2.1), so the rule holds
-- whenever the earlier job was asked for, however long it waited for a worker, and for any number
-- of waiting jobs. A job may also name the stage its real work begins with (a preview: `compiling`,
-- the start of its sandbox). Its start then moves to the time it reports that stage, and until it
-- has, no other job of the document and kind is claimed, so the starts of that stage are a gap
-- apart too. Proposed in docs/adr/0421-w2-EXP-008-preview-start-gap-and-reuse.md.

-- The job's latest start: its latest claim, or the time it reported its start stage in its latest
-- attempt (the service's heartbeat moves it); null while it has never started.
alter table jobs add column started_at timestamptz;
-- See above; null for a job without the rule. A day at most (the service checks the same bound).
alter table jobs add column start_gap_ms int
  check (start_gap_ms is null or start_gap_ms between 0 and 86400000);
-- The stage the job's real work begins with; null when the claim is the start.
alter table jobs add column start_gap_stage text
  check (start_gap_stage is null
         or (start_gap_stage ~ '^[a-z][a-z0-9_.-]{0,63}$' and start_gap_ms is not null));

create index jobs_started_by_doc on jobs (tenant_id, doc_id, kind, started_at)
  where started_at is not null;

-- As docedit_claim_job_v2() (migration 0041), and in addition: every claim records its time in
-- started_at, and a job with a start gap is not claimed within the gap after the latest start of a
-- job of its tenant, document and kind, itself included when it is tried again, nor while another
-- such job runs under a live lock and has not yet reported its start stage. A claim of a job with a
-- start stage clears the stage and progress an earlier attempt reported, so that the job counts as
-- not yet started until it reports the stage again.
--
-- The check and the claim for one tenant, document and kind are serialised by a transaction-level
-- advisory lock, so two workers that claim at the same moment cannot both start a job of one
-- document. The lock is only tried, never waited for: when another claim holds it, that claim is
-- deciding a start of this document at this moment, so the job is passed by and a later claim looks
-- at it again. A claim therefore never waits for a document's lock while it holds another one, and
-- these locks cannot be part of a deadlock.
--
-- The gap is measured with clock_timestamp(), the time at the statement, and not with now(), the
-- time the transaction began: the lock is held from the check to the commit, so each recorded start
-- is at least a gap after the one before it, however long a claim waited on the way. A waiting job
-- that is held gets the end of the gap as its run_after, so that later claims pass it by until then.
create function docedit_claim_job_v3(
  p_kinds text[], p_worker text, p_lease_ms int, p_default_limit int)
  returns setof jobs
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public
  as $$
declare
  j public.jobs;
  v_full text[] := '{}';
  v_held uuid[] := '{}';
  v_limit int;
  v_running bigint;
  v_last timestamptz;
  v_free timestamptz;
begin
  if p_lease_ms is null or p_lease_ms < 1 then
    raise exception 'the lease must be at least 1 ms';
  end if;
  loop
    select * into j from public.jobs
     where kind = any (p_kinds)
       and ((state = 'queued' and run_after <= now())
            or (state = 'running' and locked_until < now()))
       and not ((tenant_id::text || '/' || kind) = any (v_full))
       and not (id = any (v_held))
     order by priority desc, run_after, id
     limit 1
     for update skip locked;
    if not found then
      return;
    end if;
    if j.state = 'running' and j.attempts >= j.max_attempts then
      update public.jobs
         set state = 'failed', locked_by = null, locked_until = null, finished_at = now(),
             updated_at = now(),
             error = jsonb_build_object('code', 'internal',
                                        'message', 'the worker stopped and no attempts are left')
       where id = j.id;
      continue;
    end if;
    if j.start_gap_ms is not null and j.doc_id is not null then
      if not pg_try_advisory_xact_lock(hashtextextended(
        'docedit.jobs.start/' || j.tenant_id::text || '/' || j.doc_id::text || '/' || j.kind, 0))
      then
        v_held := v_held || j.id;
        continue;
      end if;
      if exists (
        select 1 from public.jobs o
         where o.tenant_id = j.tenant_id and o.doc_id = j.doc_id and o.kind = j.kind
           and o.id <> j.id and o.state = 'running' and o.locked_until >= now()
           and o.start_gap_stage is not null and o.stage is distinct from o.start_gap_stage)
      then
        v_held := v_held || j.id;
        continue;
      end if;
      select max(o.started_at) into v_last from public.jobs o
       where o.tenant_id = j.tenant_id and o.doc_id = j.doc_id and o.kind = j.kind
         and o.started_at is not null;
      if v_last is not null then
        v_free := v_last + make_interval(secs => j.start_gap_ms / 1000.0);
        if v_free > clock_timestamp() then
          if j.state = 'queued' then
            update public.jobs set run_after = greatest(run_after, v_free) where id = j.id;
          end if;
          v_held := v_held || j.id;
          continue;
        end if;
      end if;
    end if;
    select l.max_running into v_limit
      from public.tenant_job_limits l
     where l.tenant_id = j.tenant_id and l.kind = j.kind;
    if not found then
      v_limit := p_default_limit;
    end if;
    if v_limit is not null then
      perform pg_advisory_xact_lock(hashtextextended('docedit.jobs/' || j.tenant_id::text || '/' || j.kind, 0));
      select count(*) into v_running from public.jobs r
       where r.tenant_id = j.tenant_id and r.kind = j.kind and r.state = 'running'
         and r.locked_until >= now() and r.id <> j.id;
      if v_running >= v_limit then
        v_full := v_full || (j.tenant_id::text || '/' || j.kind);
        continue;
      end if;
    end if;
    update public.jobs
       set state = 'running', attempts = attempts + 1, locked_by = p_worker,
           locked_until = now() + make_interval(secs => p_lease_ms / 1000.0),
           started_at = clock_timestamp(), updated_at = now(),
           stage = case when start_gap_stage is null then stage end,
           progress = case when start_gap_stage is null then progress end
     where id = j.id
     returning * into j;
    return next j;
    return;
  end loop;
end
$$;

revoke execute on function docedit_claim_job_v3(text[], text, int, int) from public;
grant execute on function docedit_claim_job_v3(text[], text, int, int) to docedit_app;
