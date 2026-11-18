-- phase: expand
-- rollback: drop table history_visibility_settings; no release before this one reads it. The routes
--   /history-visibility and /documents/{id}/history-visibility then answer 500 until the release is
--   rolled back too, and every document is at its own column value (`editors` unless changed).
--
-- Who sees full history, per tenant and per document (HIS-025 criteria 5 and 6; 08 §9; 13 §10;
-- ADR 0034 §2). One row per scope: the tenant's own setting (`doc_id` null) or one document's.
-- `version` is the ETag of the scope: 1 when the first setting is made, one more for each change;
-- a scope with no row is at 0. The effective setting is the document's row, else the tenant's row,
-- else `documents.history_visibility` (default `editors`), which this table never writes.
--
-- `doc_id` has no foreign key to `documents`, so that the purge chain (HIS-029) is not held up by a
-- row; a row of a purged document is never read, because the routes first look the document up.
-- Each change is audited (`history_visibility.changed` in `audit_events`).

create table history_visibility_settings (
  tenant_id uuid not null,
  doc_id uuid,
  setting text not null check (setting in ('editors', 'all', 'since_access')),
  version integer not null check (version >= 1),
  updated_at timestamptz not null default now()
);

create unique index history_visibility_tenant on history_visibility_settings (tenant_id)
  where doc_id is null;
create unique index history_visibility_doc on history_visibility_settings (tenant_id, doc_id)
  where doc_id is not null;

select docedit_protect('history_visibility_settings');

grant select, insert, update on history_visibility_settings to docedit_app;
