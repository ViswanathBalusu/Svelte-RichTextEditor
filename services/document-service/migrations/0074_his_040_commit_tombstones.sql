-- phase: expand
-- rollback: drop table commit_tombstones. A payload removed by a tombstone is not restored by this;
--   restore the payload from a backup first. The previous release never reads the table, and reads a
--   commit without its payload as it reads a thinned one.

-- Replacing one commit's payload with a tombstone (HIS-040; 08 section 13). The commit's metadata
-- row, its payload hash and the hash chain stay. The payload row of `doc_commit_payloads` is
-- deleted, and this row records that it was removed on purpose: who asked, why and when. It holds no
-- content.
--
-- The tombstone runs under the purge role (migration 0073), which may delete payload rows; the
-- service role may only read the table, so a request cannot forge or remove a record of a removal.

create table commit_tombstones (
  tenant_id uuid not null,
  doc_id uuid not null,
  seq bigint not null check (seq >= 1),
  -- The surrogate of the actor, or `system` for a service credential (08 section 13).
  actor text not null,
  reason text not null check (length(reason) between 1 and 500),
  removed_at timestamptz not null,
  primary key (doc_id, seq),
  foreign key (doc_id, seq) references doc_commits (doc_id, seq)
);

select docedit_protect('commit_tombstones');

grant select on commit_tombstones to docedit_app;
grant select, insert, delete on commit_tombstones to docedit_purge;
