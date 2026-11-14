-- phase: expand
-- rollback: none needed; the previous release never reads idempotency_keys or docedit_tenant_ids().
--
-- Idempotency keys (05 §6.1; 06 §4.1 `idempotency_keys`; PRO-043, BE-034; decision D140). A
-- creating request that carries `Idempotency-Key` is remembered under the tenant, the caller, the
-- route and the key, with a hash of the request; a second request with the same key and the same
-- hash gets the stored response, one with another hash gets `idempotency_mismatch`. The row is
-- written before the handler runs (`pending`), so that of two identical requests at the same
-- moment only one creates anything, and it is completed with the response (`done`) or removed when
-- the request failed. Keys are kept for 24 hours (a setting); the scheduler deletes expired ones
-- (BE-052), tenant by tenant.

create table idempotency_keys (
  tenant_id uuid not null,
  -- `user:<surrogate>` for a user token, `service` for any service credential of the tenant
  -- (ADR 0054: a key rotation must not turn a retry into a second request).
  principal text not null check (principal = 'service' or principal ~ '^user:.+$'),
  -- The method and the concrete path, for example `POST /documents/<id>/exports`.
  route text not null check (length(route) between 1 and 2048),
  key text not null check (key ~ '^[!-~]{1,255}$'),
  -- SHA-256 of the method, the path, the query, the canonical body and the DEP-Actor.
  body_hash bytea not null check (length(body_hash) = 32),
  state text not null check (state in ('pending', 'done')),
  -- The stored response: status, the headers that are replayed, the body.
  status int check (status between 200 and 299),
  response jsonb,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (tenant_id, principal, route, key),
  check ((state = 'pending') = (status is null))
);

create index idempotency_keys_expiry on idempotency_keys (tenant_id, expires_at);

select docedit_protect('idempotency_keys');

grant select, insert, update, delete on idempotency_keys to docedit_app;

-- The tenants of the deployment, for the scheduler (BE-052), which must act on each tenant's data
-- under that tenant's context (criterion 4) and cannot name a tenant before it knows them. Like
-- docedit_origin_registered() and docedit_claim_job(), defined by the schema owner and run with its
-- rights; it returns identifiers and nothing else (ADR 0054).
create function docedit_tenant_ids() returns setof uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select t.id from public.tenants t order by t.id $$;

revoke execute on function docedit_tenant_ids() from public;
grant execute on function docedit_tenant_ids() to docedit_app;
