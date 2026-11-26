# Deletion, retention and backups

For the operator of the document service. Spec: 08 section 13, 10 section 4, 12 section 7. Owner
decisions 30, 31 and 84 (docs/owner-decisions-2026-11-15.md). SEC-057.

## What deleting a document does

1. `DELETE /documents/{id}` is a soft delete. The data stays, the document answers as deleted, and
   `dep.document.deleted` is raised at that moment.
2. The purge job runs when the retention period has passed. The default is 30 days after the soft
   delete (decision 30; `purgeAfterDays`). It does not run while a legal hold is in force on the
   document, and the thinning of checkpoints does not touch a held document either.
3. The purge removes, for the document: its commits and their metadata, checkpoints, cold segments,
   set-aside checkpoints, the files of its exports, the assets that no other document uses, its
   grants, versions, threads, comments, read markers, workflow state and evidence, and its search
   entries. An asset that another document uses stays. The audit row `document.purged` is written;
   audit rows hold identifiers and counts, never content, and stay.

## Signing evidence

Evidence has no retention period of its own (owner decision 31; 12 section 7). It is kept as long as
the signed document exists and is deleted with it, by the purge above. A legal hold keeps it until
the hold is released. A sealed final PDF is write-once: while its own `retain_until` is in the
future, the document is not purged and the run reports `sealed-retained`; once it has passed, the
sealed PDF goes with the document. A tenant cannot choose a shorter period in version 1. A tenant
that needs the evidence of one person gone earlier erases that person (FRW-043).

## Backups

The purge acts on the live stores only. A backup taken before the purge still holds the document.
Content ages out of backups on the operator's backup schedule, and not earlier:

- Content is gone from every backup at the latest when the last backup taken before the purge
  expires. That is the time of the purge plus the longest period for which the operator keeps a
  backup.
- The service does not set the backup schedule or the backup retention period. The operator sets
  them and states them to tenants. This guide gives no figure for them.
- A document with its own key (SEC-062, HIS-041) is unreadable at once, in the live stores and in
  every backup, when its key is destroyed, because the backups hold only the sealed bytes. The
  rows and the hash chain remain. The key service must not keep backups of a destroyed key.
- If a backup is restored, the purge is run again: a restored document that was purged before the
  restore is deleted a second time by the next run of the job, because the soft-delete row is
  restored with it.
