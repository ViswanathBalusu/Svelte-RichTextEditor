-- Permission data of 07 §3 (BE-010; PRM-002): region grants, the grants revision, region states,
-- leases, retired regions, and the permission state at every revision.
--
-- Every change to grants, region states, leases or the document's state is one transaction that
-- raises grant_revisions.rev (07 §9; 06 §3). Every log write holds the revision row with FOR SHARE
-- while it checks the revision its batch was checked against, so a change and a write are
-- serialised: no commit is stored under a revision older than the one in force when it is stored
-- (04 G7).

create table grant_revisions (
  doc_id uuid primary key references documents (id),
  tenant_id uuid not null,
  rev bigint not null check (rev >= 0),
  -- Whether an active workflow lets participants fill while the document is locked (07 §4 limit 1).
  -- Provisional: it moves to the workflow tables when FRW defines them.
  workflow_active boolean not null default false
);

create table region_grants (
  doc_id uuid not null references documents (id),
  region_id text not null check (region_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- 07 §1: user:<sub>, group:<id>, everyone, role:<id>.
  principal text not null
    check (principal = 'everyone' or principal ~ '^(user|group|role):[A-Za-z0-9_.@:+-]{1,255}$'),
  tenant_id uuid not null,
  -- 07 §2: a region grant never conveys structure, manage or fill.
  role text not null check (role in ('viewer', 'commenter', 'suggester', 'editor')),
  expires_at timestamptz,
  created_by text not null,
  created_at timestamptz not null,
  primary key (doc_id, region_id, principal)
);

create table region_states (
  doc_id uuid not null references documents (id),
  region_id text not null check (region_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  tenant_id uuid not null,
  state text not null check (state in ('draft', 'in_review', 'approved')),
  approved_seq bigint,
  content_hash bytea,
  changed_by text not null,
  changed_at timestamptz not null,
  primary key (doc_id, region_id)
);

create table region_leases (
  doc_id uuid not null references documents (id),
  region_id text not null check (region_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  tenant_id uuid not null,
  lease_id uuid not null,
  holder text not null,
  acquired_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (doc_id, region_id)
);

-- Written by the log write that removes the region (07 §3; invariant I3). It references the head
-- row, which that transaction already holds, so the write path never touches documents.
create table retired_regions (
  doc_id uuid not null references doc_heads (doc_id),
  region_id text not null,
  tenant_id uuid not null,
  retired_seq bigint not null,
  primary key (doc_id, region_id)
);

-- The whole permission state in force at each revision, written in the same transaction as the
-- change that created the revision. Audits and the permission oracle of the property tests
-- (PRM-017) read the permissions a commit was checked against from here (04 G7).
create table grant_history (
  doc_id uuid not null references documents (id),
  rev bigint not null,
  tenant_id uuid not null,
  state jsonb not null,
  changed_by text not null,
  changed_at timestamptz not null,
  primary key (doc_id, rev)
);

-- A retired region's identifier never returns (07 §3; I3): no grant, state or lease may attach to
-- it again (BE-010). A change and the write that retires a region are serialised on the revision
-- row, so the check below always sees a retirement that committed first.
create function docedit_refuse_retired_region() returns trigger
  language plpgsql
  as $$
begin
  if exists (
    select 1 from retired_regions r where r.doc_id = new.doc_id and r.region_id = new.region_id
  ) then
    raise exception 'region % of document % is retired', new.region_id, new.doc_id
      using errcode = 'check_violation', constraint = 'region_not_retired';
  end if;
  return new;
end
$$;

create trigger region_grants_not_retired before insert or update on region_grants
  for each row execute function docedit_refuse_retired_region();
create trigger region_states_not_retired before insert or update on region_states
  for each row execute function docedit_refuse_retired_region();
create trigger region_leases_not_retired before insert or update on region_leases
  for each row execute function docedit_refuse_retired_region();

select docedit_protect('grant_revisions');
select docedit_protect('region_grants');
select docedit_protect('region_states');
select docedit_protect('region_leases');
select docedit_protect('retired_regions');
select docedit_protect('grant_history');

grant select, insert, update on grant_revisions to docedit_app;
grant select, insert, update, delete on region_grants, region_states, region_leases to docedit_app;
-- Retirements and the history of revisions are append-only for the service.
grant select, insert on retired_regions, grant_history to docedit_app;
