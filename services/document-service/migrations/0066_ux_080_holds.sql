-- phase: expand
-- rollback: drop table document_holds; no release before this one reads it, and the routes
--   /documents/{id}/holds and /holds then answer 500 until the release is rolled back too.
--
-- Legal holds placed through the administration API (UX-080 criteria 2 and 3; 08 section 11; 13
-- section 10; lane U-UX-076-090). One row per hold: the document it names, the reason the service
-- credential gave, who placed it (the actor) and when. A hold is not released in this migration:
-- what a hold suspends and its release are HIS-031, and this table only records that a hold was
-- placed. The rule of `applyHold` (`@docedit/history`) is not connected here.
--
-- `doc_id` has no foreign key to `documents`, as for `tenant_retention`: the routes first look the
-- document up. Each placement is audited (`hold.placed` in `audit_events`).

create table document_holds (
  tenant_id uuid not null,
  id uuid not null,
  doc_id uuid not null,
  reason text not null check (char_length(reason) between 1 and 500),
  placed_by text not null check (char_length(placed_by) between 1 and 255),
  placed_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- Listing reads a tenant's holds in identifier order, which is time order (UUIDv7).
create index document_holds_doc on document_holds (tenant_id, doc_id);

select docedit_protect('document_holds');

grant select, insert on document_holds to docedit_app;
