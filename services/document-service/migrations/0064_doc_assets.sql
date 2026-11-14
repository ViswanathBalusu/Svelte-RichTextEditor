-- phase: expand
-- rollback: drop table doc_assets; no release before this one reads it.
--
-- Document attachments of assets (BE-044; 06 §4.1 `doc_assets`, §4.4; BE-046 criteria 1 and 2).
-- A row says that asset `asset_id` is attached to document `doc_id` from commit `first_seq`
-- onward. Rows are never deleted while the asset exists: an asset that was attached in an earlier
-- version stays attached, so earlier versions still render (BE-044 criterion 5). The persist
-- transaction that writes these rows is BE-024's and is not in this migration.

create table doc_assets (
  tenant_id uuid not null,
  doc_id uuid not null,
  asset_id uuid not null references assets (id),
  first_seq bigint not null check (first_seq >= 0),
  attached_at timestamptz not null default now(),
  primary key (tenant_id, doc_id, asset_id)
);

create index doc_assets_by_asset on doc_assets (tenant_id, asset_id);

select docedit_protect('doc_assets');

grant select, insert on doc_assets to docedit_app;
