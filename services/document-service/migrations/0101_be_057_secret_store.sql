-- phase: expand
-- rollback: drop table secret_store; no release before this one reads it. Secrets written to it
--   would be lost, so a rollback is for a deployment that has not yet stored any (the webhook
--   subscription store that uses it is in memory in this release).

-- The default adapter of the secret store (BE-057 criterion 6; owner decision 70). A value is
-- sealed by the service with AES-256-GCM under a key that is not in the database; the table holds
-- the nonce, the ciphertext and the identifier of the key, never the value. The tenant and the
-- reference are bound into the sealed value, so a row moved to another tenant or reference does
-- not open. An operator who keeps secrets in a secret manager does not use this table.

create table secret_store (
  tenant_id uuid not null,
  ref text not null check (char_length(ref) between 1 and 255),
  key_id text not null check (char_length(key_id) between 1 and 64),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) >= 16),
  created_at timestamptz not null default now(),
  primary key (tenant_id, ref)
);

select docedit_protect('secret_store');

grant select, insert, update, delete on secret_store to docedit_app;
