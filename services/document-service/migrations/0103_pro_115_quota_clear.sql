-- phase: expand
-- rollback: revoke delete on tenant_quotas from docedit_app. A release before this one never
--   deletes a row of the table, so nothing else needs undoing; a quota that was cleared stays
--   cleared (it reads as no limit).

-- An operator may clear a quota limit, as the schema of PUT /quotas allows (null means no limit;
-- PRO-115, owner decision 267). A cleared dimension is a deleted row, which reads as null.
-- (Migrations after 0007 are not in a release yet; BE-016.)
grant delete on tenant_quotas to docedit_app;
