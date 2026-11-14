-- phase: expand
-- rollback: none needed; the previous release never reads outbox. Items left pending are
--   delivered when this release runs again.
--
-- The outbox (06 §3 second bullet, §4.1 `outbox`; 04 §10; BE-039, BE-023, BE-037). Packet A,
-- phase 1b.
--
-- The control plane writes an item in the transaction of the state it relied on; the room that
-- owns the document, or a transient authority when none is open, applies it as a server-authored
-- commit with the deterministic `commit_id`, re-checks the preconditions in `request`, and settles
-- the item with the outcome. Delivery is at least once; the commit identifier makes the effect
-- exactly once. A node that dies while it holds an item stops renewing `locked_until`, and the
-- item is claimed again.

create table outbox (
  id uuid primary key,
  tenant_id uuid not null,
  doc_id uuid not null references doc_heads (doc_id),
  commit_id uuid not null,
  kind text not null check (kind in ('snapshot', 'author')),
  -- What to apply: origin or reason, the actor (a surrogate or `system`), the base and steps of
  -- an authored commit, and the preconditions (04 §5, closing paragraph).
  request jsonb not null check (jsonb_typeof(request) = 'object'),
  -- The content of a snapshot: canonical JSON compressed with Zstandard.
  payload bytea,
  state text not null check (state in ('pending', 'done', 'failed')),
  -- `{ seq }` when done; `{ code, action, message }` when the room refused it.
  result jsonb,
  attempts int not null default 0 check (attempts >= 0),
  locked_by text,
  locked_until timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (doc_id, commit_id)
);

create index outbox_pending on outbox (created_at, id) where state = 'pending';

select docedit_protect('outbox');

grant select, insert, update on outbox to docedit_app;

-- Claims up to `p_limit` pending items for `p_node` across tenants: the one read of the outbox
-- that cannot know its tenant, as for the job queue (docedit_claim_job, migration 0006). The node
-- then works on each item under its tenant.
create function docedit_claim_outbox(p_node text, p_lease_ms int, p_limit int)
  returns setof outbox
  language plpgsql
  volatile
  security definer
  set search_path = pg_catalog, public
  as $$
begin
  if p_lease_ms is null or p_lease_ms < 1 then
    raise exception 'the lease must be at least 1 ms';
  end if;
  return query
    update public.outbox o
       set locked_by = p_node,
           locked_until = now() + make_interval(secs => p_lease_ms / 1000.0),
           attempts = o.attempts + 1,
           updated_at = now()
     where o.id in (
       select x.id from public.outbox x
        where x.state = 'pending' and (x.locked_until is null or x.locked_until < now())
        order by x.created_at, x.id
        limit greatest(1, least(p_limit, 100))
        for update skip locked)
    returning o.*;
end
$$;

revoke execute on function docedit_claim_outbox(text, int, int) from public;
grant execute on function docedit_claim_outbox(text, int, int) to docedit_app;
