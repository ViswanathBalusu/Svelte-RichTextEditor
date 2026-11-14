-- phase: expand
-- rollback: none needed; the previous release has no history, comment or read-marker routes and
--   never reads these tables.
--
-- Tables for the phase 2 features (BE-015; 06 §4.1; 08 §4; 05 §5 threads and comments). Lane
-- U-BE-015-028. `region_states` and `region_leases` already exist from 0003_grants.sql; this
-- migration adds `versions`, `threads`, `comments` and `read_markers`.
--
-- Every table carries tenant_id and row-level security under docedit_protect (BE-011). The 06 §4.1
-- sketch omits tenant_id on these tables; the repository's rule adds it.

-- A version is a pointer to a seq with a kind (08 §4). Automatic versions are not stored.
create table versions (
  doc_id uuid not null references documents (id),
  tenant_id uuid not null,
  seq bigint not null check (seq >= 0),
  kind text not null check (kind in ('named', 'export', 'pre-restore', 'restore', 'import', 'sent', 'completed')),
  name text,
  note text,
  created_by text not null,
  created_at timestamptz not null,
  primary key (doc_id, seq, kind)
);

-- A thread anchors comments to a target. The current mapped range is written with its seq, or not
-- at all (06 §4.1: `range_from`, `range_to` and `range_seq` are written together).
create table threads (
  id uuid primary key,
  tenant_id uuid not null,
  doc_id uuid not null references documents (id),
  scope text not null,
  state text not null check (state in ('open', 'resolved')),
  target jsonb not null,
  range_from int check (range_from is null or range_from >= 0),
  range_to int check (range_to is null or range_to >= 0),
  range_seq bigint check (range_seq is null or range_seq >= 0),
  detached boolean not null default false,
  assignee text,
  created_by text not null,
  created_at timestamptz not null,
  resolved_by text,
  resolved_at timestamptz,
  check ((range_from is null) = (range_to is null) and (range_to is null) = (range_seq is null)),
  check (range_from is null or range_from <= range_to)
);

create index threads_by_doc on threads (tenant_id, doc_id, created_at);

-- Comments are soft-deleted: a deleted comment keeps its row and loses its body from reads.
create table comments (
  id uuid primary key,
  tenant_id uuid not null,
  thread_id uuid not null references threads (id),
  author text not null,
  body jsonb not null,
  created_at timestamptz not null,
  edited_at timestamptz,
  deleted_at timestamptz
);

create index comments_by_thread on comments (tenant_id, thread_id, created_at);

-- A read marker records how far a user has read. A marker only moves forward (06 §4.1; the trigger
-- below refuses a lower seq).
create table read_markers (
  doc_id uuid not null references documents (id),
  tenant_id uuid not null,
  user_id text not null,
  seq bigint not null check (seq >= 0),
  updated_at timestamptz not null,
  primary key (doc_id, user_id)
);

create function docedit_read_marker_forward_only() returns trigger
  language plpgsql
  as $$
begin
  if new.seq < old.seq then
    raise exception 'read marker of % for user % cannot move back from % to %',
      new.doc_id, new.user_id, old.seq, new.seq
      using errcode = 'check_violation', constraint = 'read_marker_forward_only';
  end if;
  return new;
end
$$;

create trigger read_markers_forward_only before update on read_markers
  for each row execute function docedit_read_marker_forward_only();

select docedit_protect('versions');
select docedit_protect('threads');
select docedit_protect('comments');
select docedit_protect('read_markers');

grant select, insert on versions to docedit_app;
grant select, insert, update on threads, comments, read_markers to docedit_app;
