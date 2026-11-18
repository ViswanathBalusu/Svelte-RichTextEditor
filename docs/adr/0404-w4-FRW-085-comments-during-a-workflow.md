# ADR 0404: Comments while a workflow runs (FRW-085)

**Status:** proposed, 2026-11-18. Written by lane w4. The owner has not settled it: Part B of `docs/owner-blockers-2026-11-17.md` lists "FRW-085 comments while out for signing: always on" as a proposed default for the owner to review, and `docs/owner-decisions-2026-11-15.md` does not list it. Nothing in the code or in the spec text changes because of this record.

## Context

12 §15 (question 9) asks whether comments stay on while a workflow is `sent` or `in_progress`. A comment never changes the document (08 §8), so the lock of FRW-029 does not touch it: a commenter or participant may create a thread, reply and resolve it (`packages/authority/test/frw-029.lock-comments.test.ts`). Some signing processes want a quiet document.

## Options

- **(a) Always on** (the current behaviour). Comments follow the roles of 07 §4 whatever the workflow state.
- **(b) A setting can switch them off** while the workflow is `sent` or `in_progress`.

## Proposed default: (a)

Comments are always on. The reasons are that they never change the document or what a participant signs, that a participant who has a question about a field has no other channel inside the document, and that a switch adds a state the room, the editor and the conformance profile must all agree on.

If the owner chooses (b), this record proposes the following, so that the choice is cheap to apply:

- **Place of the setting:** the workflow resource (`comments: "on" | "off"` on the workflow created by `send`), with a tenant default. A per-document place would let a participant's document differ from the tenant's policy without the tenant's knowledge. It is read when the workflow is sent and fixed until the workflow ends, so a participant is never surprised mid-way.
- **Default:** `on`, the tenant default being `on` unless the tenant sets otherwise.
- **Existing threads:** they stay readable by everyone who could read them, are not deleted, and keep their state. While comments are off nobody may create a thread, reply, resolve or reopen one. The comments pane says that comments are switched off for this workflow and why (the workflow, not a permission).
- **Authority:** the room refuses a comment write with `read_only` while the setting is off, as it does for a locked document, and the answer carries the workflow's reason so the editor can explain it (FRW-029 criterion 6).
- **After the workflow:** when it ends as `completed`, `declined`, `voided` or `expired`, comments follow the document's own state: on for a document that is not locked, and as the lock allows for a locked one.

## What changes if the owner decides

- (a): FRW-085 criteria 1 and 2 are recorded by this text and ticked; criterion 3 needs no change to FRW-029 beyond a sentence in its Notes, and the `workflow` conformance profile gains one case (a commenter writes a thread while the workflow is `in_progress`; it is accepted).
- (b): FRW-029 criterion 3 is reworded to "unless the workflow switches comments off", the room and the editor gain the refusal above, and the `workflow` profile gains a case for each setting.

## Consequences

Until the owner decides, FRW-085 stays open and FRW-029 criterion 3 stands as written and tested.
