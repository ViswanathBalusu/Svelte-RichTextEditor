-- phase: expand
-- rollback: none needed; the previous release never reads doc_snapshots or doc_checkpoints, and
--   stores no snapshot commit.
--
-- Snapshot contents and the checkpoint index (06 §4.1 `doc_checkpoints`; 04 §3.2; 08 §3; BE-020,
-- BE-037, BE-078, BE-081). Packet A, phase 1b.

-- The content a snapshot commit brings (04 §3.2; BE-037): canonical JSON compressed with Zstandard,
-- stored in the transaction that stores the commit, so that the log alone rebuilds every state
-- (06 §8: the log alone is sufficient for durability). The commit's payload names the content's
-- SHA-256 (`sha256:<hex>`), so the hash chain covers the content as well.
create table doc_snapshots (
  doc_id uuid not null,
  seq bigint not null,
  tenant_id uuid not null,
  content bytea not null,
  content_hash bytea not null check (length(content_hash) = 32),
  primary key (doc_id, seq),
  foreign key (doc_id, seq) references doc_commits (doc_id, seq)
);

-- Checkpoints written from the durable state (06 §2.2 step 3, §4.1, §4.2): the object key, the
-- `seq`, the size and the SHA-256 of the canonical text. A room opens only from a checkpoint that
-- has a row here (or from the content at sequence number 0, D67), so an object written for a
-- snapshot whose commit was never stored is never used. `set_aside_at` marks the checkpoints a
-- database recovery left beyond the restored head (BE-078).
create table doc_checkpoints (
  doc_id uuid not null references doc_heads (doc_id),
  seq bigint not null check (seq >= 0),
  tenant_id uuid not null,
  object_key text not null,
  bytes int not null check (bytes >= 0),
  content_hash bytea not null check (length(content_hash) = 32),
  created_at timestamptz not null,
  set_aside_at timestamptz,
  primary key (doc_id, seq)
);

select docedit_protect('doc_snapshots');
select docedit_protect('doc_checkpoints');

-- Documents whose checkpoints reach past their head: what a database restored to an earlier point
-- leaves behind (BE-078, the dry run of the new-incarnation command). The operator's one read
-- across tenants, run with the schema owner's rights like docedit_claim_job().
create function docedit_checkpoints_beyond_head()
  returns table (tenant_id uuid, doc_id uuid, head_seq bigint, checkpoint_seq bigint)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$
    select h.tenant_id, h.doc_id, h.head_seq, max(c.seq)
      from public.doc_checkpoints c
      join public.doc_heads h on h.doc_id = c.doc_id
     where c.set_aside_at is null and c.seq > h.head_seq
     group by h.tenant_id, h.doc_id, h.head_seq
     order by h.tenant_id, h.doc_id
  $$;

revoke execute on function docedit_checkpoints_beyond_head() from public;
grant execute on function docedit_checkpoints_beyond_head() to docedit_app;

-- Snapshot contents are part of history: the service inserts them and never changes them.
grant select, insert on doc_snapshots to docedit_app;
-- A checkpoint written again at the same `seq` replaces its row (a checkpoint is a cache of the
-- log); rows are deleted only by thinning, which runs under its own role (08 §11).
grant select, insert, update on doc_checkpoints to docedit_app;
