-- phase: expand
-- rollback: revoke the grants of docedit_purge and drop the role; the purge job then cannot delete, and
--   no release before this one runs it, so nothing else depends on the role.

-- Purging a deleted document (HIS-039; 08 section 13): the role that may delete what the service
-- role may not.
--
-- The service role (docedit_app) can read and append to the log but never change or delete it
-- (0002). The purge of a soft-deleted document, once its retention has passed, must remove the
-- document's rows from every store. It runs under a role of its own, docedit_purge, which holds
-- delete on the tables that are keyed by a document and nothing else: no insert and no update, and
-- no delete on the audit trail, the tenants or the users. Row-level security still applies, so a
-- purge sees only the rows of the tenant it sets for its transaction.
--
-- Nothing logs in as this role here. An operator makes a login role a member of it for the purge
-- job (06 section 12), as the service login is a member of docedit_app.

do $$
begin
  create role docedit_purge nologin;
exception
  when duplicate_object or unique_violation then null;
end
$$;

grant usage on schema public to docedit_purge;
grant execute on function docedit_current_tenant() to docedit_purge;

grant select, delete on
  documents, doc_heads, doc_commits, doc_commit_payloads, commit_scopes,
  doc_snapshots, doc_checkpoints,
  grant_revisions, region_grants, region_states, region_leases, retired_regions, grant_history,
  versions, threads, comments, read_markers, suggestion_introductions,
  workflow_evidence, workflow_sealed_pdf, workflow_renewal_state, workflow_resource,
  doc_assets, assets, jobs, outbox, document_revocations, tenant_retention
  to docedit_purge;

-- A document under a legal hold is not purged; the purge reads the holds to say so.
grant select on document_holds to docedit_purge;
