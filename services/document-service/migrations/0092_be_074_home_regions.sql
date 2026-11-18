-- phase: expand
-- rollback: drop table home_regions; the previous release routes without regions and never reads it.
--
-- The home region of a tenant, and optionally of one of its documents (06 §7; BE-074 criterion 1).
-- A row without a document is the tenant's region; a row with one overrides it for that document.
-- Routing considers only the nodes that announced the region on their lease row (migration 0091),
-- so a tenant's rooms live in its home region. A tenant with no row has no home region, and
-- routing is as before.

create table home_regions (
  tenant_id uuid not null,
  doc_id uuid,
  region text not null check (length(region) between 1 and 100),
  assigned_by text not null check (length(assigned_by) between 1 and 255),
  assigned_at timestamptz not null default now()
);

create unique index home_regions_tenant on home_regions (tenant_id) where doc_id is null;
create unique index home_regions_document on home_regions (tenant_id, doc_id) where doc_id is not null;

select docedit_protect('home_regions');

grant select, insert, update, delete on home_regions to docedit_app;
-- The purge of a deleted document removes its rows (migration 0073).
grant select, delete on home_regions to docedit_purge;
