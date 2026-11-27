-- phase: expand
-- rollback: drop the column structure from region_grants. A release before this one never reads the
--   column, so it ignores the list; the grants keep their roles, and a person who could rename a
--   region or add a style through the list then holds the role alone.

-- Part of `structure` per region (PRM-068; ADR 0424; owner decision 279): a region grant of the
-- role editor may list `region.retitle`, `defs.add` or both. The column is optional; null and an
-- empty array both mean none, and a read gives back what was written. The closed list is checked
-- by the handler and here, so that no other value can be stored.
alter table region_grants
  add column structure text[]
    check (structure is null or (structure <@ array['region.retitle', 'defs.add']::text[]
                                 and role = 'editor'));
