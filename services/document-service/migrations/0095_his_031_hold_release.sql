-- phase: expand
-- rollback: alter table document_holds drop column released_at, drop column released_by; a hold
--   released under this release is then in force again, and the routes of the older release read
--   it as placed. Drop the columns only after the older release is running.
--
-- The release of a legal hold (HIS-031; owner decision 85; 08 section 11; 13 section 10). A release
-- keeps the row: it records who released the hold and when, and takes the hold out of force. The
-- list, the `legalHold` of the document resource and the held set of the scheduler's sweeps read
-- only the rows whose `released_at` is null. Each release is audited (`hold.released` in
-- `audit_events`), as the placement is.

alter table document_holds
  add column released_at timestamptz,
  add column released_by text check (released_by is null or char_length(released_by) between 1 and 255),
  add constraint document_holds_released_together
    check ((released_at is null) = (released_by is null));

-- The held set reads the holds in force of a tenant.
create index document_holds_in_force on document_holds (tenant_id, doc_id) where released_at is null;

grant update (released_at, released_by) on document_holds to docedit_app;
