-- phase: expand
-- rollback: roll the service back first, then drop table commit_cold_segments. A release before
--   this one never reads the table: it reads a commit whose payload has moved as it reads a thinned
--   one ("no longer available"), although the payload is still in its segment object. So a rollback
--   after payloads have moved hides the detail of that history until this release runs again; no
--   payload is lost by it, and the segment objects stay in object storage.

-- Cold segments of commit payloads (HIS-029; 08 section 11; 06 sections 4.1 and 4.2; ADR 0006).
--
-- A payload older than 30 days leaves doc_commit_payloads for a compressed object in object
-- storage, tenants/{tenant}/docs/{doc}/segments/{fromSeq}-{toSeq}.payloads.zst. The commit's row in
-- doc_commits stays, with its payload hash and the hash chain. This table is the index: which
-- object holds the payloads of which run of sequence numbers. A read that finds a commit without a
-- payload row looks here, reads the object and checks each payload against the hash in the commit.
--
-- state:
--   pending  the object is not to be read. The row is written, in a transaction of its own, before
--            the object is, so that a move that stops half way leaves a record of the object it may
--            have written; the next run removes the object and the row, and the payloads are still
--            in doc_commit_payloads. A segment whose last payload was removed afterwards (thinning,
--            a tombstone) goes back to pending before its object is deleted, for the same reason.
--   moved    the object was written and read back with matching hashes, and in the same transaction
--            that set this state the payload rows were deleted.
--
-- payloads is the number of payloads the object holds. It falls when thinning or a tombstone
-- removes one from the object; the range in the key does not change.
--
-- Rows are written by the cold-segment job, which runs under the purge role (0073), the only role
-- that may delete from doc_commit_payloads. The service role only reads.

create table commit_cold_segments (
  doc_id uuid not null,
  tenant_id uuid not null,
  from_seq bigint not null check (from_seq >= 1),
  to_seq bigint not null check (to_seq >= from_seq),
  object_key text not null check (char_length(object_key) between 1 and 512),
  state text not null check (state in ('pending', 'moved')),
  payloads int not null check (payloads >= 0 and payloads <= to_seq - from_seq + 1),
  created_at timestamptz not null,
  moved_at timestamptz,
  primary key (doc_id, from_seq),
  foreign key (doc_id, from_seq) references doc_commits (doc_id, seq),
  foreign key (doc_id, to_seq) references doc_commits (doc_id, seq),
  -- A segment that is read holds at least one payload and has the time of its move.
  check (state <> 'moved' or (payloads >= 1 and moved_at is not null))
);

-- The job starts each run by clearing what an earlier run left half done.
create index commit_cold_segments_pending on commit_cold_segments (tenant_id, doc_id)
  where state = 'pending';

select docedit_protect('commit_cold_segments');

grant select on commit_cold_segments to docedit_app;
grant select, insert, update, delete on commit_cold_segments to docedit_purge;
