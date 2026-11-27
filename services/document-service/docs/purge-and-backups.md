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

`POST /documents/{id}/commits/{seq}/tombstone` (service credential only; HIS-040) deletes the payload of one commit and keeps its metadata, its payload hash and the hash chain. It is refused under a legal hold, and while no checkpoint covers the commit. It is audited (`commit.tombstoned`: the actor and the reason). A payload that has moved to a cold segment is taken out of its segment object, which is written again without it. The answer lists the copies that may still hold the text: the checkpoints at or after the commit, the attribution map, and any object under the document's `segments/` prefix that covers the commit and that the call did not write again. The service does not rewrite those, so the operator rebuilds or removes them (and the backups, below). The route needs the same purge role and is offered only when `tombstoneStore` is given.

## Backups

The service does not make backups and ships no backup schedule. A purge removes data from the live database and the object store. Copies in backups stay until the backup that holds them expires. So:

> content is gone from every backup at the latest at *purge time + the retention of your oldest backup that holds the document*.

The operator sets the backup schedule and the backup retention (owner decision 277). The product fixes the rule above, not the figures: each deployment fills in its own, and keeps them where the privacy notice can cite them.

| Value | Where it comes from | This deployment |
|---|---|---|
| Backup frequency | the operator's schedule | (operator fills in) |
| Retention of backups | the operator's schedule | (operator fills in) |
| Retention of non-current object versions | the bucket's lifecycle rule | (operator fills in) |
| Time to age out after a purge | purge time plus the longest of the two retentions above | (operator fills in) |

To work the last row out: take the purge time of a document (its delete time plus the purge period, 30 days by default), and add the longest time any copy is kept, whether in a database backup or in an older object version. The result is the time by which no copy of the content is left.

A request to erase content before that time needs the operator to expire or rewrite the backups. A restored backup brings purged documents back: after any restore the purge job must run again, and the operator must re-apply the deletions made since the backup was taken.

## Thinning old payloads (HIS-032)

A tenant (or one document) that sets the retention policy `thin_payloads` with `afterDays` has the payloads of commits older than that period deleted once a day (`payloads.thin`, `src/control-plane/payload-thinning.ts`). The rows are the same: only the rows of `doc_commit_payloads` go. The commit rows, the payload hashes and the chain stay, so the log still verifies.

What stays: the checkpoints, the payload of a snapshot commit, the payloads that a named, export, sent or completed version needs to be rebuilt, every payload above the newest checkpoint (a room replays from it), and everything for a document under a legal hold. A read that needs a removed payload answers `not_found` with the reason.

The job uses the same login as the purge (a member of `docedit_purge`) and is given as `thinningStore` (`PgThinningStore`); without it the task does not run. Each document that loses payloads gets one `history.thinned` audit event with counts.

Payloads that have moved to cold segments are thinned too: the segment object is written again without them, and a segment left with nothing is deleted. The audit event counts them as `fromSegments`.

## Moving old payloads to cold segments (HIS-029)

Once a day (`payloads.cold`, `src/control-plane/cold-segments.ts`) the payloads of commits older than 30 days leave `doc_commit_payloads` for compressed objects, `tenants/{tenant}/docs/{doc}/segments/{fromSeq}-{toSeq}.payloads.zst`. Set `DOCEDIT_COLD_AFTER_DAYS` to change the age for the whole deployment. The commit rows, their payload hashes and the hash chain stay in PostgreSQL, and the table `commit_cold_segments` (migration 0097) says which object holds which run of sequence numbers.

- The job needs the same login as the purge (a member of `docedit_purge`). It runs when `DOCEDIT_PURGE_DATABASE_URL` is set; without it no payload moves. Reading moved payloads needs no such login: the service reads them from the object store.
- A payload row is deleted only after its object was written and read back with every payload hash equal to the hash in its commit. A run that stops half way leaves the payload rows and a row in state `pending`; the next run removes what it left and moves the payloads again.
- Payloads above the newest checkpoint stay in PostgreSQL, so opening and editing a document never need a segment. A document with no checkpoint yet moves nothing.
- A document under a legal hold is moved like any other. Moving removes nothing; the audit event `history.moved` says that the hold was seen.
- If a segment object cannot be read, requests for that old range answer `unavailable` (503 with `Retry-After`) and everything else goes on. `recovery-cli.ts verify` reads every moved payload and compares it with the hash the chain covers.
- After the move the segment object is the only copy of those payloads outside backups. Keep the bucket's versioning and replication as for checkpoints (06 §4.2).
- In a bucket with versioning, an object that thinning, a tombstone or the purge wrote again or deleted keeps its earlier versions until the bucket's lifecycle rule expires them. The service does not delete versions. Set the lifecycle of non-current versions with the same care as the backup retention below: until they expire, removed content is still in the bucket.
- A release before this one reads a moved payload as a removed one. Do not roll back past this release after payloads have moved, unless the detail of that history may be hidden until the release runs again.
