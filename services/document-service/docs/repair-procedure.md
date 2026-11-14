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
- Check that the document has no approved region that the repair would change. An approved region is
  refused until its state is changed (PRM-046, PRM-047). This check is not yet automated: the
  operator reads the document's regions first.

## Steps

1. Dry run. Plan the repair. The plan names the head, the checkpoint the replay starts from, the hash
   the document has now and the hash the repair would write. Nothing is stored.
2. Read the plan. If `changes` is false, the document is not broken at its head and nothing is done.
3. Enqueue the repair. This writes one outbox item of kind `snapshot` with reason `repair`, and one
   audit event `repair.enqueued` that names the operator, the document, the reason, the head, the
   checkpoint and the target hash.
4. Let the room apply the item. The item settles `done` with the sequence number of the repair
   commit, which is the head plus one. An item that fails carries the room's rejection; a failed
   item is not retried by hand without a new plan.
5. Check the result. The chain of the log verifies (`verify` without payloads is enough for the
   links), the content at the new head hash to the target hash of the plan, and the audit trail holds
   the event from step 3.
6. Leave the damaged checkpoint as it is, or set it aside with the recovery tools, as the incident
   record says. Do not delete it.

## What the procedure does not do

- It does not replay across a snapshot commit above the chosen checkpoint. The plan refuses that case,
  and the operator repairs it by hand.
- It does not check approved regions by itself (see before you start).
- It does not change the log, the commit identifiers or any earlier commit.

## Rehearsal

The procedure is rehearsed on a deliberately damaged document in
`services/document-service/test/data-plane/be-090-repair.pg.test.ts`: a checkpoint is written with
the wrong content, the dry run changes nothing, the repair is enqueued, delivered into the running room
and checked against the plan. The rehearsal runs the functions in `src/data-plane/repair.ts`, not an
operator at a terminal.
