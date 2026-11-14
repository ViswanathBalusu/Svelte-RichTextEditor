-- phase: expand
-- rollback: drop table suggestion_introductions; the previous release never reads it and the
--   history list keeps working from the log, as it did before.

-- HIS-042 criterion 4 (lane V-HIS-033-046): the commit that introduced each suggestion, by the
-- suggestion's identifier, kept in an index so that the history service does not scan the log. The
-- lowest seq wins (packages/history/src/suggestions.ts). The table is tenant-scoped under RLS.
create table suggestion_introductions (
  tenant_id uuid not null,
  doc_id uuid not null references documents (id),
  suggestion_id text not null check (suggestion_id <> ''),
  seq bigint not null check (seq >= 1),
  primary key (tenant_id, doc_id, suggestion_id)
);

select docedit_protect('suggestion_introductions');

grant select, insert, update on suggestion_introductions to docedit_app;
