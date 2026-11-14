-- Platform objects every later migration uses (06 §4.1, §12; BE-011).
--
-- Migrations run as the role that owns the schema. The service connects as a login role that is a
-- member of docedit_app: it owns nothing, is not a superuser and cannot bypass row-level security.

do $$
begin
  create role docedit_app nologin;
exception
  -- Roles are cluster-wide; two databases migrated at once may race to create it.
  when duplicate_object or unique_violation then null;
end
$$;

grant usage on schema public to docedit_app;

-- The tenant of the current transaction. The service sets it first in every transaction with
--   select set_config('docedit.tenant_id', '<tenant uuid>', true)
-- Unset or empty means no tenant: every policy then matches no row, so reads return nothing and
-- writes fail (BE-011).
create function docedit_current_tenant() returns uuid
  language sql
  stable
  parallel safe
  as $$ select nullif(current_setting('docedit.tenant_id', true), '')::uuid $$;

grant execute on function docedit_current_tenant() to docedit_app;

-- Row-level security for one table, as every tenant table must have it (06 §4.1; BE-011): enabled,
-- forced (so it applies to the table's owner too), and one policy that limits reads and writes to
-- the current tenant. Partitions get it as well, although the service reaches them only through
-- their parent, on which alone it holds privileges.
create function docedit_protect(t regclass) returns void
  language plpgsql
  as $$
begin
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format(
    'create policy tenant_isolation on %s using (tenant_id = docedit_current_tenant()) '
    'with check (tenant_id = docedit_current_tenant())', t);
end
$$;

revoke execute on function docedit_protect(regclass) from public;
