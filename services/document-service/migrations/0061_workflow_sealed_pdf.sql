-- phase: expand
-- rollback: drop table workflow_sealed_pdf; the previous release has no workflow routes and never reads it.
--
-- The record of a sealed final PDF (12 §8.2 step 4; FRW-054 criterion 1; lane V-FRW-037-054).
-- The sealed bytes live in write-once object storage; this row records their hash, the object key
-- and the retention end, so the hash of the stored bytes is kept in the database too. One row per
-- workflow: a second record for the same workflow is refused by the primary key. The service role
-- may insert and read; it holds no UPDATE and no DELETE, so a recorded hash is not rewritten.

create table workflow_sealed_pdf (
  tenant_id uuid not null,
  doc_id uuid not null references documents (id),
  workflow_id text not null check (length(workflow_id) between 1 and 128),
  -- Lower-case hexadecimal SHA-256 of the sealed bytes, and of the bytes read back from the store.
  sealed_hash text not null check (sealed_hash ~ '^[0-9a-f]{64}$'),
  stored_hash text not null check (stored_hash = sealed_hash),
  object_key text not null check (length(object_key) between 1 and 1024),
  retain_until timestamptz not null,
  recorded_at timestamptz not null default now(),
  primary key (tenant_id, doc_id, workflow_id)
);

select docedit_protect('workflow_sealed_pdf');

grant select, insert on workflow_sealed_pdf to docedit_app;
