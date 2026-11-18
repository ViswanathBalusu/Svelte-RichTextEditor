-- phase: expand
-- rollback: drop table document_keys and tenant_document_keys. A document whose payloads were sealed
--   with its own key cannot be read after that, so roll back only a release in which no tenant used
--   the option; the previous release does not read either table and does not open sealed payloads.

-- Per-document encryption keys (HIS-041; 08 section 13; owner decision 43).
--
-- A document that has a key of its own has its commit payloads, snapshot contents and objects
-- sealed with a data key (AES-256-GCM). The data key is stored here only wrapped with the document's
-- key in the key service, so destroying that key makes every copy unreadable, backups included. The
-- commit rows, the payload hashes and the hash chain are not sealed and stay verifiable.
--
-- `tenant_document_keys` is the option of a tenant. With no row, or `enabled` false, the service
-- gives the tenant's documents no key and nothing else about them changes.

create table tenant_document_keys (
  tenant_id uuid primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now()
);

select docedit_protect('tenant_document_keys');
grant select, insert, update on tenant_document_keys to docedit_app;

create table document_keys (
  tenant_id uuid not null,
  doc_id uuid primary key references documents (id),
  -- The key in the key service (`document-<doc>`).
  key_id text not null check (key_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  -- The data key wrapped with that key. Null once the key is destroyed.
  wrapped_dek bytea,
  state text not null check (state in ('active', 'destroyed')),
  created_at timestamptz not null,
  destroyed_at timestamptz,
  check (
    (state = 'active' and wrapped_dek is not null and destroyed_at is null)
    or (state = 'destroyed' and wrapped_dek is null and destroyed_at is not null)
  )
);

select docedit_protect('document_keys');
grant select, insert, update on document_keys to docedit_app;

-- The purge of a deleted document removes its key row with the rest.
grant select, delete on document_keys, tenant_document_keys to docedit_purge;
