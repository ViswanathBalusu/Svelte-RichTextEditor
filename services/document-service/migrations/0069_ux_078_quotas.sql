-- phase: expand
-- rollback: drop table tenant_quotas; no release before this one reads it, and the routes
--   /quotas then answer 500 until the release is rolled back too.
--
-- Tenant quota values (UX-078 criterion 1; 06 section 12; lane V-UX-076-090). One row per tenant and
-- dimension; an unset dimension has no row and reads as null. The CHECK clauses repeat the rules of
-- src/control-plane/quotas.ts: a finite number of zero or more (`NaN` is greater than every number
-- in PostgreSQL, so the `< 'Infinity'` test refuses it too).
--
-- A tenant table in the form of migration 0065: keyed by `tenant_id`, under the row-level security
-- of docedit_protect (BE-011), and read and written by PgQuotaStore only inside inTenant, so one
-- tenant never reads or writes another tenant's quotas. The foreign key refuses a row for a tenant
-- that is not registered. Amended before any release shipped it (releases.json lists 0001 to 0007
-- only), so no database outside a test one has the earlier `tenant text` shape.

create table tenant_quotas (
  tenant_id   uuid not null references tenants (id),
  dimension   text not null check (dimension in (
    'connections', 'openDocuments', 'commitRate', 'roomCpuBudget',
    'storage', 'exportConcurrency', 'exportMinutes'
  )),
  value       double precision not null check (value >= 0 and value < 'Infinity'),
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, dimension)
);

select docedit_protect('tenant_quotas');

grant select, insert, update on tenant_quotas to docedit_app;
