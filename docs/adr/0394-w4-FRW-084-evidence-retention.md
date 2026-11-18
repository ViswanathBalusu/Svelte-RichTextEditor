# 0394. Retention of signing evidence

**Status:** the default is the owner's (decision 31 in `docs/owner-decisions-2026-11-15.md`, 2026-11-17). The rest is proposed, 2026-11-18, and written while closing FRW-084 and building FRW-043 (lane w4).

## Decided by the owner

Signing evidence (IP address, user agent, times, consent record) is kept as long as the signed document exists and is deleted with it.

## What follows from it (read from the decision, not decided here)

1. **Default.** The default retention has no period. The constant `EVIDENCE_RETENTION_DEFAULT` in `packages/authority/src/workflow/retention.ts` is `null`, and `planPurge` removes nothing by age when it is `null`.
2. **Clock.** There is none. The retention does not count from `completedSeq`, from finalisation or from the last reminder of a stopped workflow. It ends when the document is deleted, so a declined, voided or expired workflow keeps its evidence for as long as its document does.
3. **Where the rows go.** The purge of a deleted document (HIS-039, `document-purge.ts`) already deletes the `workflow_evidence` rows with the document, after the 30 days of decision 30. A sealed PDF whose write-once retention has not ended keeps the document from being purged (decision 84).
4. **Legal hold.** A hold keeps the evidence, as it keeps the document. The evidence purge job keeps every row under a hold (FRW-043 criterion 2), and the document purge never runs under a hold. A hold never extends evidence beyond the life of the document.

## Proposed, not decided

5. **Tenant range.** The owner named one rule and no tenant choice. Proposal: no tenant-chosen period in version 1. A tenant that needs evidence gone earlier erases one person (FRW-043 criterion 3) or deletes the document. If the owner wants a tenant setting, it is a period in days counted from the collection time of each row, never longer than the life of the document, and the bounds are the owner's: no figure is proposed here. `planPurge` already accepts such a period, so the setting needs no change to the decision logic. FRW-043 criterion 5 ("the retention period is a tenant setting") waits for this answer and for the administration API of FRW-042 criterion 4.
6. **Legal basis and wording.** Counsel agrees both (FRW-087). Nothing here is legal advice.

## Consequences

- 12 §7 and §15 (question 7) and 08 §2 state the default.
- FRW-084 criterion 2 is met by this record. Criteria 1 (the range) and 3 (counsel) stay open.
