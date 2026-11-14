-- phase: expand
-- rollback: drop table workflow_evidence; the previous release has no workflow routes and never reads it.
--
-- Workflow evidence rows (12 §7; FRW-041, FRW-043). Evidence is kept outside the commit log, in
-- this table. The purge job (FRW-043) deletes whole rows once their retention has passed. The
-- service role may insert, read and delete; it holds no UPDATE, so a stored row is not rewritten.
-- Lane U-FRW-037-054.

create table workflow_evidence (
  id uuid not null,
  tenant_id uuid not null,
  doc_id uuid not null references documents (id),
  -- The participant's surrogate, as the workflow tables name it (never a host identifier).
  participant text not null check (length(participant) between 1 and 128),
  item text not null check (item ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- The instant the evidence was collected, server time.
  collected_at timestamptz not null,
  -- Small data only: the evidence value and its hash, never document text.
  data jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4096),
  primary key (tenant_id, id)
);

create index workflow_evidence_by_doc on workflow_evidence (tenant_id, doc_id, collected_at);

select docedit_protect('workflow_evidence');

grant select, insert, delete on workflow_evidence to docedit_app;
