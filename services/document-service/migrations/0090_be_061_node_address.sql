-- phase: expand
-- rollback: none needed; the previous release never reads or writes node_leases.address, and a
--   row without an address is a node that announces none.
--
-- The WebSocket address of a node, on its lease row (BE-061; owner decision 200 of 2026-11-15;
-- ADR 0243). A node writes its own public address at each renewal, so the connect hint follows the
-- lease: a node that moves updates its own row and no other node or file changes. A lease that has
-- expired is not live, so its address is never offered (06 §2.1).

alter table node_leases
  add column address text check (address is null or length(address) between 1 and 2000);
