-- phase: expand
-- rollback: none needed; the previous release never reads the two columns and a node of it
--   writes none, which means a general node in no region.
--
-- What a node announces about itself on its lease row besides its address (BE-073, BE-074; 06 §6,
-- §7): the region it runs in, and the one document it is dedicated to. Routing reads them with the
-- live hosts (room-routing.ts). Both are null for a node that announced neither.
--
-- Like the rest of node_leases the columns hold no tenant data: a dedicated document is named by
-- its identifier only, which a node's own lease row may carry as a routing hint.

alter table node_leases add column region text check (region is null or length(region) between 1 and 100);
alter table node_leases add column dedicated_doc text check (dedicated_doc is null or length(dedicated_doc) between 1 and 100);
