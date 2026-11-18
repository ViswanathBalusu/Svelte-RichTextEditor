# ADR 0404: Comments while a workflow runs (FRW-085)

**Status:** accepted, 2026-11-18. Written by lane w4 as a proposal. The owner settled it as decision 131 of `docs/owner-decisions-2026-11-15.md` ("Comments while a document is out for signing: Always on"). Option (a) applies. The only spec change is the answer to question 9 in 12 §15; no code changes, because always on is the current behaviour.

## Context

12 §15 (question 9) asks whether comments stay on while a workflow is `sent` or `in_progress`. A comment never changes the document (08 §8), so the lock of FRW-029 does not touch it: a commenter or participant may create a thread, reply and resolve it (`packages/authority/test/frw-029.lock-comments.test.ts`). Some signing processes want a quiet document.

## Options

- **(a) Always on** (the current behaviour). Comments follow the roles of 07 §4 whatever the workflow state.
- **(b) A setting can switch them off** while the workflow is `sent` or `in_progress`.

## Decision: (a)

Comments are always on. The reasons are that they never change the document or what a participant signs, that a participant who has a question about a field has no other channel inside the document, and that a switch adds a state the room, the editor and the conformance profile must all agree on.

If the owner ever reverses this and chooses (b), the following is the design to start from. It is not in force:

- **Place of the setting:** the workflow resource (`comments: "on" | "off"` on the workflow created by `send`), with a tenant default. A per-document place would let a participant's document differ from the tenant's policy without the tenant's knowledge. It is read when the workflow is sent and fixed until the workflow ends, so a participant is never surprised mid-way.
- **Default:** `on`, the tenant default being `on` unless the tenant sets otherwise.
- **Existing threads:** they stay readable by everyone who could read them, are not deleted, and keep their state. While comments are off nobody may create a thread, reply, resolve or reopen one. The comments pane says that comments are switched off for this workflow and why (the workflow, not a permission).
- **Authority:** the room refuses a comment write with `read_only` while the setting is off, as it does for a locked document, and the answer carries the workflow's reason so the editor can explain it (FRW-029 criterion 6).
- **After the workflow:** when it ends as `completed`, `declined`, `voided` or `expired`, comments follow the document's own state: on for a document that is not locked, and as the lock allows for a locked one.

## What changes if the owner decides

- (a): FRW-085 criteria 1 and 2 are recorded by this text and ticked; criterion 3 needs no change to FRW-029 beyond a sentence in its Notes, and the `workflow` conformance profile gains one case (a commenter writes a thread while the workflow is `in_progress`; it is accepted).
- (b): FRW-029 criterion 3 is reworded to "unless the workflow switches comments off", the room and the editor gain the refusal above, and the `workflow` profile gains a case for each setting.

## Consequences

FRW-029 criterion 3 stands as written and tested. No setting exists, so there is no place, default or treatment of existing threads to implement: existing threads follow the roles of 07 §4 as at any other time. The `workflow` profile is not written yet (FRW-068); its one case is recorded in FRW-068's Notes.
