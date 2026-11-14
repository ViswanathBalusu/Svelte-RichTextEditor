-- Documents, their head rows and the commit log (06 §4.1; 08 §2; BE-009). The log is the history
-- (08 §2, ADR 0010): nothing about a commit is kept anywhere else.

create table documents (
  id uuid primary key,
  tenant_id uuid not null,
  external_id text,
  title text,
  properties jsonb not null default '{}',
  label text,
  state text not null default 'active' check (state in ('active', 'locked', 'archived')),
  cdm_version int not null,
  requires text[] not null default '{}',
  history_visibility text not null default 'editors',
  forked_from uuid,
  forked_at_seq bigint,
  created_by text not null,
  created_at timestamptz not null,
  deleted_at timestamptz,
  unique (tenant_id, external_id)
);

-- The narrow, hot row (06 §4.1 notes): every log write locks it, checks the ownership epoch and
-- the head, and advances it. The wide documents row is never touched on that path (BE-009).
create table doc_heads (
  doc_id uuid primary key references documents (id),
  tenant_id uuid not null,
  head_seq bigint not null default 0 check (head_seq >= 0),
  incarnation uuid not null,
  owner text,
  epoch bigint not null default 0 check (epoch >= 0),
  chain_head bytea,
  check ((head_seq = 0) = (chain_head is null))
);

-- Commit metadata, kept for the life of the document (08 §2). Departures from the 06 §4.1 sketch:
-- session_id is text because the room's sessions are strings (StoredCommit.session); payload_hash
-- is added so that the chain still verifies after a payload is thinned or erased (HIS-002 notes).
-- The hash chain is provisional; its layout is in docs/adr/0020-commit-log-storage.md.
create table doc_commits (
  doc_id uuid not null references doc_heads (doc_id),
  seq bigint not null check (seq >= 1),
  tenant_id uuid not null,
  kind text not null check (kind in ('steps', 'control', 'snapshot')),
  commit_id uuid not null,
  user_id text not null,
  session_id text,
  agent text,
  server_ts timestamptz not null,
  origin text not null,
  base bigint,
  rebased boolean,
  access_rev bigint,
  token_jti text,
  cdm_version int not null,
  engine text not null,
  size int not null check (size >= 0),
  payload_hash bytea not null check (length(payload_hash) = 32),
  prev_hash bytea,
  hash bytea not null check (length(hash) = 32),
  primary key (doc_id, seq),
  unique (doc_id, commit_id),
  check ((seq = 1) = (prev_hash is null))
) partition by hash (doc_id);

-- Steps or control data, Zstandard-compressed canonical JSON (FND-005); moves to cold segments
-- later (08 §11), which is why it is a table of its own.
create table doc_commit_payloads (
  doc_id uuid not null,
  seq bigint not null,
  tenant_id uuid not null,
  payload bytea not null,
  primary key (doc_id, seq),
  foreign key (doc_id, seq) references doc_commits (doc_id, seq)
) partition by hash (doc_id);

-- Per-region and per-field history (06 §4.1 notes): the primary key serves "history of one scope";
-- the second index serves reading a commit's scopes back with the commit.
create table commit_scopes (
  doc_id uuid not null,
  scope text not null,
  seq bigint not null,
  tenant_id uuid not null,
  primary key (doc_id, scope, seq),
  foreign key (doc_id, seq) references doc_commits (doc_id, seq)
);
create index commit_scopes_by_seq on commit_scopes (doc_id, seq);

do $$
declare
  -- BE-008: the hash-partition count of doc_commits and doc_commit_payloads. It is fixed when the
  -- tables are created (06 §13) and chosen for stage 3; the reasoning, and what changing it later
  -- would take, are in docs/adr/0020-commit-log-storage.md. This is the only place it is set.
  partitions constant int := 64;
  t text;
begin
  for r in 0 .. partitions - 1 loop
    foreach t in array array['doc_commits', 'doc_commit_payloads'] loop
      execute format(
        'create table %I partition of %I for values with (modulus %s, remainder %s)',
        t || '_p' || lpad(r::text, 2, '0'), t, partitions, r);
      perform docedit_protect(format('%I', t || '_p' || lpad(r::text, 2, '0'))::regclass);
    end loop;
  end loop;
end
$$;

select docedit_protect('documents');
select docedit_protect('doc_heads');
select docedit_protect('doc_commits');
select docedit_protect('doc_commit_payloads');
select docedit_protect('commit_scopes');

-- The service may read and append to the log but never change or delete what is stored: history
-- is append-only for it. Thinning and erasure (08 §11, §13) will run under their own role.
grant select, insert, update on documents to docedit_app;
grant select, insert, update on doc_heads to docedit_app;
grant select, insert on doc_commits, doc_commit_payloads, commit_scopes to docedit_app;
