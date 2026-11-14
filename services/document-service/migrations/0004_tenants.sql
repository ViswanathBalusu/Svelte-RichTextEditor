-- Tenants and what is checked against their registration (BE-012; 05 §3.1, §3.2; 10 §3.2), and
-- the per-tenant user surrogates (BE-013; 06 §4.1 `tenant_users`; 08 §13).
--
-- Every table carries tenant_id under the same policy as the rest of the schema (BE-011). The one
-- read that cannot know its tenant, whether a CORS preflight comes from an origin some tenant
-- allows (decision D66), goes through docedit_origin_registered(), which answers yes or no and
-- nothing else.

create table tenants (
  id uuid primary key,
  -- The policy of BE-011 needs a tenant_id column; for this table it is the row's own identifier.
  tenant_id uuid not null check (tenant_id = id),
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null
);

-- Public keys that verify tokens. `use` keeps the two sets apart (05 §3.2): a key for user tokens
-- never verifies a service credential, and the same key material cannot be registered in both
-- (BE-012 criterion 5), which the thumbprint (RFC 7638) makes checkable.
create table tenant_keys (
  tenant_id uuid not null references tenants (id),
  kid text not null check (kid ~ '^[A-Za-z0-9._:-]{1,128}$'),
  use text not null check (use in ('user', 'service')),
  -- 05 §3.1: only asymmetric algorithms on the allow-list, one per key.
  alg text not null check (alg in ('ES256', 'EdDSA', 'RS256')),
  jwk jsonb not null,
  thumbprint text not null,
  -- The `iss` that tokens verified by this key must carry, when the operator sets one.
  issuer text,
  created_at timestamptz not null,
  primary key (tenant_id, kid),
  unique (tenant_id, thumbprint)
);

-- API keys (05 §3.2). Only a SHA-256 of the secret is stored. Two keys may be active at once; a
-- key with an expiry stops authenticating then, which is how a rotation overlap ends (10 §3.7).
create table tenant_api_keys (
  tenant_id uuid not null references tenants (id),
  id uuid not null,
  secret_hash bytea not null check (length(secret_hash) = 32),
  label text,
  created_at timestamptz not null,
  expires_at timestamptz,
  primary key (tenant_id, id)
);

-- Allowed origins for browsers (05 §4, §6.1; 10 §3.2): scheme, host and optional port only.
create table tenant_origins (
  tenant_id uuid not null references tenants (id),
  origin text not null check (origin ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
  created_at timestamptz not null,
  primary key (tenant_id, origin)
);

-- 06 §4.1: every host `sub` is mapped to a per-tenant surrogate, and every other table stores only
-- the surrogate, so erasing a person is deleting one row (BE-013; 08 §13). `revoked_before` is the
-- revocation watermark of 05 §3.3 for all of the user's documents.
create table tenant_users (
  tenant_id uuid not null references tenants (id),
  sub text not null,
  surrogate text not null check (surrogate ~ '^[A-Za-z0-9_.@:+-]{1,128}$'),
  display_name text,
  revoked_before timestamptz,
  created_at timestamptz not null,
  primary key (tenant_id, sub),
  unique (tenant_id, surrogate)
);

-- A watermark for one document of one user (05 §3.3 "optionally a document"; decision D73).
create table document_revocations (
  tenant_id uuid not null references tenants (id),
  surrogate text not null,
  doc_id uuid not null,
  revoked_before timestamptz not null,
  primary key (tenant_id, surrogate, doc_id)
);

select docedit_protect('tenants');
select docedit_protect('tenant_keys');
select docedit_protect('tenant_api_keys');
select docedit_protect('tenant_origins');
select docedit_protect('tenant_users');
select docedit_protect('document_revocations');

-- The registration is the operator's (BE-012: seeded from configuration or the command line); the
-- service reads it on every request, so a change applies without a restart.
grant select, insert, update, delete on tenants, tenant_keys, tenant_api_keys, tenant_origins
  to docedit_app;
-- Erasing a user deletes the mapping row (BE-013 criterion 5).
grant select, insert, update, delete on tenant_users to docedit_app;
grant select, insert, update on document_revocations to docedit_app;

-- Whether any tenant allows `o`. A preflight carries no token, so its tenant is unknown (G05;
-- decision D66). Defined by the schema owner and run with its rights, so that it can read across
-- tenants; it returns a boolean and nothing else. The owner must be able to bypass row-level
-- security (the reference deployment migrates as a superuser; ADR 0036).
create function docedit_origin_registered(o text) returns boolean
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
  as $$ select exists (select 1 from public.tenant_origins t where t.origin = o) $$;

revoke execute on function docedit_origin_registered(text) from public;
grant execute on function docedit_origin_registered(text) to docedit_app;
