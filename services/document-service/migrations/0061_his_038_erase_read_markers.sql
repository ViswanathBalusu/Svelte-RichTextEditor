-- phase: expand
-- rollback: revoke delete on read_markers from docedit_app; the erasure of a person is then refused
--   for read markers only, and the mapping row is still deleted by PgUserDirectory.erase.

-- HIS-038 criterion 1 (lane V-HIS-033-046): erasing a person deletes their read markers with their
-- mapping row, in one transaction. The service role may delete read markers for that purpose only;
-- the tenant policy of read_markers (docedit_protect) still limits every delete to the tenant.
grant delete on read_markers to docedit_app;
