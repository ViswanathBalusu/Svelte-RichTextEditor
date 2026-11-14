-- The job queue of stage 1 (BE-049; 06 §4.1 `jobs`, notes; 06 §6): exports now, asset processing,
-- imports and deliveries later. Workers claim with FOR UPDATE SKIP LOCKED, so two workers never
-- hold the same job. A worker that dies stops renewing `locked_until`; when it passes, the job can
-- be claimed again and `attempts` rises, until `max_attempts`, after which it fails.
--
-- States (BE-049 notes: not named by the spec; decision D75 and ADR 0036): queued, running,
-- completed, failed, cancelled. `stage` and `progress` report a running job's step (for an export:
-- converting or compiling; 05 §6.2).

create table jobs (
  id uuid primary key,
  tenant_id uuid not null,
  doc_id uuid,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  state text not null check (state in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage text,
  progress int check (progress between 0 and 100),
  payload jsonb not null,
  result jsonb,
  error jsonb,
  attempts int not null default 0 check (attempts >= 0),
  max_attempts int not null check (max_attempts >= 1),
  run_after timestamptz not null,
  locked_by text,
  locked_until timestamptz,
  -- Surrogate of the requester (BE-013); an export job is readable by its requester only (SR-C4).
  created_by text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  finished_at timestamptz
);

create index jobs_ready on jobs (run_after, id) where state = 'queued';
create index jobs_running on jobs (locked_until) where state = 'running';
create index jobs_by_doc on jobs (doc_id, created_at);

select docedit_protect('jobs');

grant select, insert, update on jobs to docedit_app;

-- Claims the next job of one of `kinds` for `worker` across tenants: the one read of the queue
-- that cannot know its tenant (BE-049; BE-011 open question; ADR 0036). It returns the claimed row,
-- whose tenant_id the worker then sets for everything it does with the job (BE-049 criterion 5).
-- A running job whose lock has passed belongs to a worker that died: it is claimed again, or it
-- fails when it has used its attempts. Run with the schema owner's rights, like
-- docedit_origin_registered().
create function docedit_claim_job(p_kinds text[], p_worker text, p_lease_ms int)
  returns setof jobs
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public
  as $$
declare
  j public.jobs;
begin
  if p_lease_ms is null or p_lease_ms < 1 then
    raise exception 'the lease must be at least 1 ms';
  end if;
  loop
    select * into j from public.jobs
     where kind = any (p_kinds)
       and ((state = 'queued' and run_after <= now())
            or (state = 'running' and locked_until < now()))
     order by run_after, id
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
    update public.jobs
       set state = 'running', attempts = attempts + 1, locked_by = p_worker,
           locked_until = now() + make_interval(secs => p_lease_ms / 1000.0), updated_at = now()
     where id = j.id
     returning * into j;
    return next j;
    return;
  end loop;
end
$$;

revoke execute on function docedit_claim_job(text[], text, int) from public;
grant execute on function docedit_claim_job(text[], text, int) to docedit_app;
