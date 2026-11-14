-- phase: expand
-- rollback: none needed; the previous release claims with docedit_claim_job(), which stays, and
--   ignores the new columns, which have defaults.
--
-- Separate queues for previews and requested exports, and a concurrency cap per tenant (06 §8
-- "export backlog", §12; 09 §9.1, §9.5; BE-050, EXP-007; ADR 0054). Previews are their own job kind
-- with a higher priority, so a worker that serves both takes waiting previews first, and a worker
-- can also serve one kind alone. A tenant with as many running jobs of a kind as its limit has
-- gets no more of that kind until one ends; other tenants' jobs run meanwhile. `cache_key` names
-- what a job produces, so that a second request for the same bundle and profile gets the first
-- result (EXP-006); it is the request's key, computed by the control plane, and never crosses a
-- tenant.

alter table jobs add column priority int not null default 0;
alter table jobs add column cache_key text check (cache_key is null or cache_key ~ '^[0-9a-f]{64}$');

create index jobs_ready_by_priority on jobs (priority desc, run_after, id) where state = 'queued';
create index jobs_running_by_tenant on jobs (tenant_id, kind) where state = 'running';
create index jobs_cache on jobs (tenant_id, cache_key, finished_at)
  where state = 'completed' and cache_key is not null;

-- Concurrency limits per tenant and job kind (EXP-007 criterion 3; phase 1b caps tenants by
-- configuration). A tenant without a row has the deployment's default.
create table tenant_job_limits (
  tenant_id uuid not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  max_running int not null check (max_running >= 0),
  primary key (tenant_id, kind)
);

select docedit_protect('tenant_job_limits');

grant select, insert, update, delete on tenant_job_limits to docedit_app;

-- Claims the next job of one of `kinds` for `worker`, the highest priority first, skipping the
-- tenants that already run as many jobs of the job's kind as their limit allows (their own row in
-- tenant_job_limits, else `p_default_limit`; null means no limit). The count and the claim for one
-- tenant and kind are serialised by a transaction-level advisory lock, so two workers that claim
-- at the same moment cannot both take the last free place. Otherwise as docedit_claim_job()
-- (migration 0006): a running job whose lock has passed is claimed again or fails when its
-- attempts are used, and the claimed row is returned so that the worker sets its tenant.
create function docedit_claim_job_v2(
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
  v_limit int;
  v_running bigint;
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
           locked_until = now() + make_interval(secs => p_lease_ms / 1000.0), updated_at = now()
     where id = j.id
     returning * into j;
    return next j;
    return;
  end loop;
end
$$;

revoke execute on function docedit_claim_job_v2(text[], text, int, int) from public;
grant execute on function docedit_claim_job_v2(text[], text, int, int) to docedit_app;

-- Queue depth by kind and priority, for autoscaling (BE-050 criterion 5; BE-065): counts across
-- tenants, and nothing else.
create function docedit_job_depth()
  returns table (kind text, priority int, queued bigint, running bigint)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
    select j.kind, j.priority,
           count(*) filter (where j.state = 'queued'),
           count(*) filter (where j.state = 'running')
      from public.jobs j
     where j.state in ('queued', 'running')
     group by j.kind, j.priority
     order by j.kind, j.priority
  $$;

revoke execute on function docedit_job_depth() from public;
grant execute on function docedit_job_depth() to docedit_app;
