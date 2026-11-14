-- phase: expand
-- rollback: drop table tenant_capture_settings; the previous release never reads it, and a tenant
--   without a row captures the network identity (the default).
--
-- The tenant's network-capture setting (FRW-042; 12 §7, last sentence; 13 §10). One row per tenant
-- that has changed it; a tenant with no row has the default, on (FRW-042 Notes). `version` is 1
-- after the first change and one more for each later change, so that an administration route can
-- use it as its ETag. Each change is written to `audit_events` (`capture.setting.changed`) in the
-- same transaction as the row (src/workflow/capture-settings-pg.ts). Stored evidence is never
-- rewritten by a change: nothing here touches `workflow_evidence`. Lane V-FRW-019-036.

create table tenant_capture_settings (
  tenant_id uuid primary key,
  capture_network_identity boolean not null,
  version integer not null check (version >= 1),
  changed_at timestamptz not null,
  -- The per-tenant surrogate of the actor who made the last change (08 §13).
  changed_by text not null check (length(changed_by) between 1 and 128)
);

select docedit_protect('tenant_capture_settings');

grant select, insert, update on tenant_capture_settings to docedit_app;
