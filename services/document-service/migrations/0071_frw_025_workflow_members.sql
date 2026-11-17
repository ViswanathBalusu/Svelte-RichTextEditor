-- phase: expand
-- rollback: alter table workflow_resource drop column members, drop column sent_seq, drop column
--   sent_hash; the previous release reads only the columns of 0070 and ignores these.
--
-- The rest of the workflow resource (FRW-025 criterion 1; 12 §6.1). `members` holds what a writer
-- sets besides the participants: `routing`, `deadline`, `reminders`, `consent` and `finalisation`,
-- already checked by `checkWorkflowBody` (packages/authority/src/workflow/workflow-body.ts). One
-- object, so a new member of the resource needs no migration. `sent_seq` and `sent_hash` are set by
-- the `send` action when it is built (FRW-027); until then they are null and the resource leaves
-- them out.

alter table workflow_resource
  add column members jsonb not null default '{}'::jsonb check (
    jsonb_typeof(members) = 'object' and octet_length(members::text) <= 65536
  ),
  add column sent_seq bigint check (sent_seq is null or sent_seq >= 0),
  add column sent_hash text check (sent_hash is null or length(sent_hash) <= 128);
