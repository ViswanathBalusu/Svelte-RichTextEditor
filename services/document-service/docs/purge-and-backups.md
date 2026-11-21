# Purging deleted documents, and backups

For the operator. Spec: 08 §13; story HIS-039; owner decision 30 (30 days by default).

## What happens when a document is deleted

1. `DELETE /documents/{id}` is a soft delete. The data stays, the document answers `not_found`, and the webhook `dep.document.deleted` is raised at that moment.
2. After the retention period the purge job removes the document for good. The period is 30 days by default. Set `DOCEDIT_PURGE_AFTER_DAYS` to change it for the whole deployment. A period for each tenant is not built.
3. The job `documents.purge` runs every hour for every tenant. It does not run for a document under a legal hold, and it leaves a document whose sealed PDF is still retained (`retain_until`) until that retention has ended.

## What the purge removes

- the commits and their metadata, the checkpoints and their index, grants, versions, threads and comments, read markers, session records (the user agent family and client version of each session, HIS-003), workflow state and evidence, jobs, and the document row;
- every object under the document's prefix (checkpoints, cold segments, set-aside checkpoints), the files of its export jobs, and the sealed PDF once its retention has ended;
- the assets uploaded for the document that no other document references, and their objects unless another asset has the same bytes;
- the document's search entries.

It keeps the audit trail. The trail holds identifiers, never content, and records the purge as `document.purged`.

The job needs a database login that is a member of `docedit_purge` (migration 0073). That role may read and delete the document tables and nothing else. Give the job its own pool and pass it as `purgeStore` (`PgPurgeStore`); without it the job does not run.

## Removing the payload of one commit

`POST /documents/{id}/commits/{seq}/tombstone` (service credential only; HIS-040) deletes the payload of one commit and keeps its metadata, its payload hash and the hash chain. It is refused under a legal hold, and while no checkpoint covers the commit. It is audited (`commit.tombstoned`: the actor and the reason). The answer lists the checkpoints and cold segments that may still hold the text; the service does not rewrite them, so the operator rebuilds or removes them (and the backups, below). The route needs the same purge role and is offered only when `tombstoneStore` is given.

## Backups

The service does not make backups and ships no backup schedule. A purge removes data from the live database and the object store. Copies in backups stay until the backup that holds them expires. So:

> content is gone from every backup at the latest at *purge time + the retention of your oldest backup that holds the document*.

The operator fills in these values for the deployment, and keeps them where the privacy notice can cite them:

| Value | Where it comes from |
|---|---|
| Backup frequency | the operator's schedule |
| Retention of backups | the operator's schedule |
| Time to age out after a purge | purge time plus the backup retention |

A request to erase content before that time needs the operator to expire or rewrite the backups. A restored backup brings purged documents back: after any restore the purge job must run again, and the operator must re-apply the deletions made since the backup was taken.

## Thinning old payloads (HIS-032)

A tenant (or one document) that sets the retention policy `thin_payloads` with `afterDays` has the payloads of commits older than that period deleted once a day (`payloads.thin`, `src/control-plane/payload-thinning.ts`). The rows are the same: only the rows of `doc_commit_payloads` go. The commit rows, the payload hashes and the chain stay, so the log still verifies.

What stays: the checkpoints, the payload of a snapshot commit, the payloads that a named, export, sent or completed version needs to be rebuilt, every payload above the newest checkpoint (a room replays from it), and everything for a document under a legal hold. A read that needs a removed payload answers `not_found` with the reason.

The job uses the same login as the purge (a member of `docedit_purge`) and is given as `thinningStore` (`PgThinningStore`); without it the task does not run. Each document that loses payloads gets one `history.thinned` audit event with counts.
