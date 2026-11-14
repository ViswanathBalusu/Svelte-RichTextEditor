-- phase: expand
-- rollback: none needed; the previous release has no asset routes and never reads the table.
--
-- Assets (05 §6.2; 06 §4.1 `assets`, §4.4; PRO-061, PRO-062; BE-042 to BE-045 are the asset
-- worker's). `POST /documents/{id}/assets` creates a row in `quarantined` with what the client
-- declared and returns a size-bound upload into `tenants/{tenant}/quarantine/{asset}`;
-- `POST /assets/{aid}/complete` queues the asset worker's job and moves the row to `processing`;
-- the worker's outcome moves it to `ready`, with the hash, size and object key it computed itself,
-- or to `failed`. A hash the client declares has no column. `doc_id` is the document the asset was
-- uploaded for (06 §4.4: the authority attaches an asset its uploader uploaded for the document);
-- which documents reference it is read from their content (ADR 0054).

create table assets (
  id uuid primary key,
  tenant_id uuid not null,
  doc_id uuid not null,
  -- What the client declared. The file name is metadata and is never logged (BE-088).
  filename text check (filename is null or length(filename) between 1 and 1024),
  mime text not null check (length(mime) between 1 and 255),
  declared_bytes bigint not null check (declared_bytes >= 1),
  state text not null check (state in ('quarantined', 'processing', 'ready', 'failed')),
  -- What the asset worker computed (06 §4.4: "computes the hash itself").
  sha256 bytea check (sha256 is null or length(sha256) = 32),
  bytes bigint check (bytes is null or bytes >= 0),
  content_type text,
  object_key text,
  width int,
  height int,
  frames int,
  renditions jsonb not null default '[]'::jsonb,
  -- Why validation failed: a registry code and the worker's reason, never content.
  failure jsonb,
  job_id uuid,
  created_by text not null,
  created_at timestamptz not null,
  upload_expires_at timestamptz not null,
  completed_at timestamptz,
  settled_at timestamptz,
  check ((state = 'ready') = (sha256 is not null and object_key is not null))
);

create index assets_by_doc on assets (tenant_id, doc_id, created_at);
create index assets_quarantined on assets (tenant_id, upload_expires_at) where state = 'quarantined';

select docedit_protect('assets');

grant select, insert, update, delete on assets to docedit_app;
