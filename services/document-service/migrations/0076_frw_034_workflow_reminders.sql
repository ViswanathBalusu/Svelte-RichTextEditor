-- phase: expand
-- rollback: drop table workflow_reminders; the previous release raises no reminder and never reads
--   it.
--
-- How many scheduled reminders have been raised for a participant (12 §6.1 `reminders`; FRW-034
-- criteria 2 and 5). One row per participant of a running workflow: the instant they became active
-- (`anchor_ms`, the moment the reminders count from) and the number of the last reminder raised for
-- that activation. A sweep raises reminder number N only after moving `raised` to N by a compare and
-- set (src/workflow/reminder-store-pg.ts), so of any number of instances, or of runs after a
-- restart, one raises it. A participant who is activated again (after a correction) has a later
-- anchor, and the count starts again from zero. Times are epoch milliseconds, kept exact.

create table workflow_reminders (
  tenant_id uuid not null,
  doc_id uuid not null,
  participant text not null check (length(participant) between 1 and 255),
  anchor_ms bigint not null check (anchor_ms > 0),
  raised integer not null check (raised >= 0),
  primary key (tenant_id, doc_id, participant)
);

select docedit_protect('workflow_reminders');

grant select, insert, update on workflow_reminders to docedit_app;
-- The purge of a deleted document removes its rows (migration 0073).
grant select, delete on workflow_reminders to docedit_purge;
