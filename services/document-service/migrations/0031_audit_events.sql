-- phase: expand
-- rollback: none needed; the previous release never reads audit_events.
--
-- The audit trail (06 §4.1 `audit_events`; 07 §14; BE-014, PRM-051). Packet A, phase 1b.
--
-- Partitioned by range on `at`, one partition per calendar month (UTC). The service inserts and
-- reads; it can neither update nor delete (it holds no such privilege, and a trigger refuses the
-- statements for every other role too), so a row cannot be altered once written. Partitions for
-- the coming months are created ahead of time by docedit_audit_partitions(), which the migration
-- runs and the service runs again at start and daily (the scheduler of BE-052 may take it over).
-- Retention drops whole partitions, which no row trigger sees.

create table audit_events (
  id uuid not null,
  tenant_id uuid not null,
  doc_id uuid,
  -- The per-tenant surrogate of the actor, or `system` (08 §13): never a host identifier.
  actor text not null,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  -- Small data only: identifiers, codes, scopes. Never document text (BE-014 criterion 4).
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4096),
  at timestamptz not null,
  primary key (tenant_id, at, id)
) partition by range (at);

create index audit_events_by_doc on audit_events (tenant_id, doc_id, at);
create index audit_events_by_actor on audit_events (tenant_id, actor, at);

select docedit_protect('audit_events');

grant select, insert on audit_events to docedit_app;

create function docedit_audit_refuse_change() returns trigger
  language plpgsql
  as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'insufficient_privilege';
end
$$;

create trigger audit_events_append_only
  before update or delete on audit_events
  for each row execute function docedit_audit_refuse_change();

-- Creates the monthly partitions from the month of `p_from` for `p_months` months, those that do
-- not exist yet, each protected like every tenant table (BE-011). Run with the schema owner's
-- rights so that the service role, which owns nothing, can call it.
create function docedit_audit_partitions(p_from timestamptz, p_months int) returns int
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public
  as $$
declare
  first_day date := date_trunc('month', p_from at time zone 'UTC')::date;
  made int := 0;
  lo date;
  hi date;
  name text;
begin
  if p_months is null or p_months < 1 or p_months > 36 then
    raise exception 'between 1 and 36 months';
  end if;
  for i in 0 .. p_months - 1 loop
    lo := (first_day + make_interval(months => i))::date;
    hi := (first_day + make_interval(months => i + 1))::date;
    name := 'audit_events_' || to_char(lo, 'YYYY_MM');
    if to_regclass('public.' || name) is null then
      execute format(
        'create table public.%I partition of public.audit_events for values from (%L) to (%L)',
        name, lo::timestamp at time zone 'UTC', hi::timestamp at time zone 'UTC');
      perform public.docedit_protect(format('public.%I', name)::regclass);
      made := made + 1;
    end if;
  end loop;
  return made;
end
$$;

revoke execute on function docedit_audit_partitions(timestamptz, int) from public;
grant execute on function docedit_audit_partitions(timestamptz, int) to docedit_app;

-- The month before (clock differences around midnight on the first) and the coming three.
select docedit_audit_partitions(now() - interval '1 month', 5);
