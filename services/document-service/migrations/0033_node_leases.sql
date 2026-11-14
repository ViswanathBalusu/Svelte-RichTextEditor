-- phase: expand
-- rollback: none needed; the previous release claims documents without leases and never reads
--   node_leases.
--
-- Node-level liveness leases (06 §2.1, §8; BE-018). Packet A, phase 1b.
--
-- A node may own rooms only while it holds a lease, which it renews every few seconds. Expiry is
-- judged by the database clock alone (`now()` here, never a node's clock). A node claims a
-- document only when the document has no owner, the node owns it already, or the owner's lease
-- has expired (PgLogStore.claimIfFree); the ownership epoch still fences every write (BE-017).
--
-- The table holds no tenant data: a lease names a node, not a document, like the migrations'
-- bookkeeping table. It therefore has no tenant column and no row-level security.

create table node_leases (
  node text primary key check (length(node) between 1 and 200),
  expires_at timestamptz not null,
  renewed_at timestamptz not null,
  started_at timestamptz not null
);

grant select, insert, update, delete on node_leases to docedit_app;
