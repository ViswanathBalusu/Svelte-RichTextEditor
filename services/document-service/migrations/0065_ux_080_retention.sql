-- phase: expand
-- rollback: drop table tenant_retention; no release before this one reads it, and the routes
--   /retention and /documents/{id}/retention then answer 500 until the release is rolled back too.
--
-- Retention policies (UX-080 criterion 1; 08 §11; 13 §10; lane U-UX-076-090). One row per scope:
-- the tenant's own policy (`doc_id` null) or one document's policy. `version` is the ETag of the
-- scope: 1 when the first policy is set, one more for each change; a scope with no row is at 0.
-- The policy shape (`mode`, `after_days`) is the proposal of docs/adr/0330-lane-U-UX-076-090.md,
-- section 6. The CHECK clauses repeat the rules of src/control-plane/retention.ts: `keep_all` has
-- no period, `thin_payloads` has one of at least a day.
--
-- `doc_id` has no foreign key to `documents`, so that the purge chain (HIS-029) is not held up by
-- a policy row; a row of a purged document is never read, because the routes first look the
-- document up. Each change is audited (`retention.changed` in `audit_events`).

create table tenant_retention (
  tenant_id uuid not null,
  doc_id uuid,
  mode text not null check (mode in ('keep_all', 'thin_payloads')),
  after_days integer check (after_days is null or after_days >= 1),
  version integer not null check (version >= 1),
  updated_at timestamptz not null default now(),
  check (
    (mode = 'keep_all' and after_days is null)
    or (mode = 'thin_payloads' and after_days is not null)
  )
);

-- One tenant policy per tenant, and one policy per document.
create unique index tenant_retention_tenant on tenant_retention (tenant_id) where doc_id is null;
create unique index tenant_retention_doc on tenant_retention (tenant_id, doc_id)
  where doc_id is not null;

select docedit_protect('tenant_retention');

grant select, insert, update on tenant_retention to docedit_app;
