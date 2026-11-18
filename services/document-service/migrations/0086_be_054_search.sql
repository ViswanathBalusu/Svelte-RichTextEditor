-- phase: expand
-- rollback: drop table search_tokens; drop table search_entries. Nothing but the indexer job and
--   GET /search reads them, and both are off unless DOCEDIT_SEARCH_INDEX is set, so the previous
--   release is not affected; the index is rebuilt from the checkpoints when it is switched on again.

-- The search index (06 section 1, indexer; 05 section 6.2, /search; BE-054). One entry per tenant,
-- document and visibility class (ADR 0019), holding the sequence of the checkpoint it was built
-- from, and one row per distinct word of that checkpoint with the number of times it occurs. The
-- rows hold document text in the form of words, so they are in scope of erasure and purge: the
-- purge of a document removes its entries (HIS-039), and the tokens go with them.
--
-- Tenancy follows BE-011: tenant_id on both tables, forced row-level security and the tenant policy.
-- `doc_id` is not a reference to `documents`: a purge removes the document row and, in the same
-- run, calls the index; keeping the two apart means neither order of deletion can fail.

create table search_entries (
  tenant_id uuid not null,
  doc_id uuid not null,
  visibility text not null check (length(visibility) between 1 and 64),
  seq bigint not null check (seq >= 0),
  primary key (tenant_id, doc_id, visibility)
);

create table search_tokens (
  tenant_id uuid not null,
  doc_id uuid not null,
  visibility text not null,
  token text not null,
  occurrences integer not null check (occurrences > 0),
  primary key (tenant_id, doc_id, visibility, token),
  foreign key (tenant_id, doc_id, visibility)
    references search_entries (tenant_id, doc_id, visibility) on delete cascade
);

create index search_tokens_by_token on search_tokens (tenant_id, token);

select docedit_protect('search_entries');
select docedit_protect('search_tokens');

grant select, insert, update, delete on search_entries, search_tokens to docedit_app;
-- The purge role removes a document's entries with the rest of its rows (migration 0073).
grant select, delete on search_entries, search_tokens to docedit_purge;
