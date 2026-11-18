# Repair a broken document with an audited commit

This procedure is for a document that recovery shows to be broken (BE-081): a checkpoint whose
content its log does not produce, or a replay that fails. It never edits the log. It writes the
content the log replays to as one server-authored commit with origin `repair`, through the outbox,
so the room applies it under the same checks as any commit (BE-039). History stays where it is.

## Before you start

- Confirm the damage with the recovery procedure: `verifyCheckpoint` names the checkpoint that
  differs from its replay (BE-081 criterion 3).
- Note the operator's identity, the document identifier, the tenant and a short reason, such as a
  ticket number. The reason is kept in the audit trail. It is never written into the commit.
- Know which regions of the document are approved. The room applies the repair under the same checks
  as any commit, so a repair that would change an approved region is refused until the region's state
  is changed (PRM-046, PRM-047; BE-090 criterion 2). The operator does not change the state: the
  region's owners do, and then the repair is planned again.

## Steps

1. Dry run. Plan the repair. The plan names the head, the checkpoint the replay starts from, the hash
   the document has now and the hash the repair would write. Nothing is stored.
2. Read the plan. If `changes` is false, the document is not broken at its head and nothing is done.
3. Enqueue the repair. This writes one outbox item of kind `snapshot` with reason `repair`, and one
   audit event `repair.enqueued` that names the operator, the document, the reason, the head, the
   checkpoint and the target hash.
4. Let the room apply the item. The item settles `done` with the sequence number of the repair
   commit, which is the head plus one. An item that fails carries the room's rejection (`forbidden`
   with the region named, for an approved region); a failed item is not retried by hand without a
   new plan.
5. Check the result. The chain of the log verifies (`verify` without payloads is enough for the
   links), the content at the new head hash to the target hash of the plan, and the audit trail holds
   the event from step 3.
6. Leave the damaged checkpoint as it is, or set it aside with the recovery tools, as the incident
   record says. Do not delete it.

## What the procedure does not do

- It does not replay across a snapshot commit above the chosen checkpoint. The plan refuses that case,
  and the operator repairs it by hand.
- It does not change an approved region: the room refuses such a repair (see before you start).
- It does not change the log, the commit identifiers or any earlier commit.

## Rehearsal

The procedure is rehearsed on a deliberately damaged document in
`services/document-service/test/data-plane/be-090-w5-rehearsal.pg.test.ts`, on PostgreSQL and the
S3-compatible store in Podman. A checkpoint is written with the wrong content, a region is approved,
and the test does what each numbered step above says: the dry run changes nothing, the repair is
enqueued and delivered into the running room, the room refuses it while the region is approved, the
region's state is changed, and the repair then succeeds and is checked against the plan. The record is
`services/document-service/test/postgres/rehearsals/be-090-repair.json`. The steps are run by the test
through the functions in `src/data-plane/repair.ts`, not by an operator at a terminal. The first runs
of the functions are in `test/data-plane/be-090-repair.pg.test.ts` (without the approved region) and
`test/data-plane/be-090-w5-approved-region.test.ts` (in memory).
