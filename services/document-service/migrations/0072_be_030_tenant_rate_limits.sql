-- phase: expand
-- rollback: alter table tenants drop column rate_limits; the previous release does not read it and
--   applies the node's default limits to every tenant.
--
-- The message limits of one tenant (BE-030 criterion 3; 06 §8). A null column means the node's
-- defaults. Otherwise an object with `tenant` and `user`, each `{ capacity, refillPerSecond }`;
-- a scope left out keeps the default. The application checks the shape before it writes.

alter table tenants add column rate_limits jsonb;
