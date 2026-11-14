-- phase: expand
-- rollback: drop table workflow_renewal_state; the previous release has no renewal job and never
--   reads it.
--
-- The time-stamp chain of a sealed document as the renewal job sees it (12 §8.2 step 5; FRW-056
-- criterion 5; lane V-FRW-055-072). One row per sealed document: the expiry of its newest
-- time-stamp, and the claim of the one run that may ask the signing service for the next
-- time-stamp. A run claims the expiry before it asks (src/workflow/renewal-state-pg.ts), so one
-- expiry leads to one request, and the expiry moves only by a compare and set made by the claim's
-- holder. Times are epoch milliseconds, kept exact so that the compare is exact.

create table workflow_renewal_state (
  tenant_id uuid not null,
  doc_id uuid not null,
  expires_at_ms bigint not null check (expires_at_ms > 0),
  -- The run that holds the claim on the current expiry, and when its claim lapses.
  claim_holder text check (claim_holder is null or length(claim_holder) between 1 and 128),
  claim_until_ms bigint,
  renewed_at_ms bigint,
  check ((claim_holder is null) = (claim_until_ms is null)),
  primary key (tenant_id, doc_id)
);

select docedit_protect('workflow_renewal_state');

grant select, insert, update on workflow_renewal_state to docedit_app;
