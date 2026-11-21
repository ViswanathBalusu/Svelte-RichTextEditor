-- phase: expand
-- rollback: roll the service back first, then drop tables anchored_heads and head_anchors. A release
--   before this one never reads them. The records that were written to write-once storage stay
--   there until their retention ends; a later release that anchors again starts a new chain of
--   records for each tenant unless the rows are restored from a backup first.

-- Anchoring chain heads in write-once storage (HIS-036; 08 section 12; ADR 0409, owner decision 56).
--
-- Once an hour, for each tenant with a change, the service builds a Merkle tree over the heads of
-- the tenant's documents that changed since the previous record, has its root signed and
-- time-stamped by the signing service, and writes the record to write-once storage.
--
-- head_anchors holds one row per record: what was signed, the signature, and where the record is
-- stored. A row is written, with the heads it covers, before the record goes to write-once storage:
--   signed  the signature exists and the heads count as anchored; the object is still to be written.
--   stored  the record is in write-once storage.
-- A run finishes a `signed` row before it signs anything new, so the records of a tenant form one
-- line: each names the hash of the one before it (`previous`).
--
-- anchored_heads holds, for each document, the head the newest record covers. A document whose
-- head differs from it has changed since and goes into the next tree. A run that fails changes
-- nothing here, so the next run that works covers what the failed ones missed.
--
-- Neither table holds content: identifiers, sequence numbers, times, hashes and a signature.

create table head_anchors (
  tenant_id uuid not null,
  -- The time the heads were read: the record's `to`. One record per tenant and time.
  to_ts timestamptz not null,
  -- The `to` of the tenant's previous record; null for its first.
  from_ts timestamptz,
  root bytea not null check (octet_length(root) = 32),
  leaves int not null check (leaves >= 1),
  -- The signed text, as the signing service returned it.
  record text not null check (char_length(record) between 1 and 2000),
  record_sha256 bytea not null check (octet_length(record_sha256) = 32),
  -- The SHA-256 of the previous record's text; null for the first.
  previous bytea check (previous is null or octet_length(previous) = 32),
  -- A detached CAdES-B-T over record_sha256: the signature, with the RFC 3161 token inside.
  cms bytea not null,
  -- genTime of the token.
  timestamp_time timestamptz not null,
  key_id text not null check (char_length(key_id) between 1 and 200),
  object_key text not null check (char_length(object_key) between 1 and 512),
  leaves_key text not null check (char_length(leaves_key) between 1 and 512),
  state text not null check (state in ('signed', 'stored')),
  created_at timestamptz not null,
  stored_at timestamptz,
  primary key (tenant_id, to_ts),
  check ((from_ts is null) = (previous is null)),
  check (from_ts is null or from_ts < to_ts),
  check (state <> 'stored' or stored_at is not null)
);

create table anchored_heads (
  doc_id uuid primary key,
  tenant_id uuid not null,
  incarnation uuid not null,
  seq bigint not null check (seq >= 1),
  chain_head bytea not null check (octet_length(chain_head) = 32),
  -- The record that covers this head: head_anchors (tenant_id, to_ts).
  anchor_to timestamptz not null,
  foreign key (tenant_id, anchor_to) references head_anchors (tenant_id, to_ts)
);

create index anchored_heads_tenant on anchored_heads (tenant_id);

select docedit_protect('head_anchors');
select docedit_protect('anchored_heads');

-- The service role writes a record and marks it stored. It cannot change what a record says, and
-- it never deletes one.
grant select, insert on head_anchors to docedit_app;
grant update (state, stored_at) on head_anchors to docedit_app;
grant select, insert, update on anchored_heads to docedit_app;

-- The purge of a deleted document removes the row that names it (0073). The records stay: they
-- name no document.
grant select, delete on anchored_heads to docedit_purge;
