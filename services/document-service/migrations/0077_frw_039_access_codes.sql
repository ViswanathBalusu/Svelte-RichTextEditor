-- phase: expand
-- rollback: drop table workflow_access_codes; the previous release has no access codes and never
--   reads it.
--
-- The access code of a workflow participant (12 §6.1 `auth`, §7; FRW-039). One row for each
-- participant whose `auth.require` lists `access_code`: the salt and the SHA-256 hash of the code
-- the host registered, never the code. The wrong-attempt counter of the participant is kept beside
-- it: `failures` in the window that began at `window_start_ms`, moved by one UPDATE for each
-- attempt before the code is compared (src/workflow/access-code-pg.ts), so concurrent attempts
-- cannot exceed the limit. A correct code or a new registration clears the counter. Times are
-- epoch milliseconds from the service clock.

create table workflow_access_codes (
  tenant_id uuid not null,
  doc_id uuid not null,
  participant text not null check (length(participant) between 1 and 255),
  salt text not null check (salt ~ '^[0-9a-f]{32}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  failures integer not null default 0 check (failures >= 0),
  window_start_ms bigint,
  registered_at_ms bigint not null,
  primary key (tenant_id, doc_id, participant)
);

select docedit_protect('workflow_access_codes');

grant select, insert, update on workflow_access_codes to docedit_app;
-- The purge of a deleted document removes its rows (migration 0073).
grant select, delete on workflow_access_codes to docedit_purge;
