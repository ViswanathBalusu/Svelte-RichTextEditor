-- phase: expand
-- rollback: drop table workflow_resource; the previous release has no workflow routes and never
--   reads it.
--
-- The workflow resource of a document (FRW-025 criteria 2, 3 and 5; FRW-026 criteria 1 and 4; 12 §6.1,
-- §10). One row per document: the primary key (tenant_id, doc_id) is the one-workflow-per-document
-- rule of version 1 (criterion 2). `rev` is the ETag of the resource (criterion 3: a PUT carries the
-- revision it read, and is refused as `precondition_failed` when it is stale). The participant list
-- is stored as the checked drafts of `checkParticipants` (src/workflow/resource.ts), so no contact
-- detail is ever a member (FRW-026 criterion 4). Lane V-FRW-019-036.

create table workflow_resource (
  tenant_id uuid not null,
  doc_id uuid not null references documents (id),
  id uuid not null,
  state text not null check (state in (
    'draft', 'sent', 'in_progress', 'correcting', 'completed', 'finalised', 'voided', 'declined', 'expired'
  )),
  rev integer not null check (rev >= 1),
  time_zone text not null check (length(time_zone) between 1 and 64),
  participants jsonb not null check (
    jsonb_typeof(participants) = 'array' and octet_length(participants::text) <= 65536
  ),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, doc_id),
  unique (tenant_id, id)
);

select docedit_protect('workflow_resource');

grant select, insert, update on workflow_resource to docedit_app;
