# ADR 0423: Unconfirmed steps after a snapshot reset, and a read-restricted region that is removed

**Status:** proposed, 2026-11-21. Written by the integrator of batch 1 (the run of 2026-11-20). Not reviewed by the project owner. Item 1 is a defect and is fixed. Items 2 and 3 are findings; what to do about them is the owner's, and nothing was changed for them. Item 4 is a change to a test harness.

## Context

The S12 property (`packages/authority/test/projection.property.test.ts`; SPK-029; ADR 0019) runs 200 random schedules against the room and the projection gateway, with a new seed on every run. One region of its document is confidential and carries a text marker. The property fails when a message to a reader who may not read the region carries the marker.

In the check of batch 1 it failed with the seed 1780757714: "mallory received hidden region content in sync.commit". To see how often that happens the property was then run with 6,000 schedules three times (`S12_RUNS=6000 pnpm exec vitest run --project node packages/authority/test/projection.property.test.ts`, on the integrator's Windows 11 machine, Node.js 22.18, 2026-11-20, with item 1 already fixed in the simulated client). The first and the third run passed. The second stopped at its 171st schedule, with the seed -959420596. That is one failing schedule in 12,171. So the property has failed for some seeds for as long as these paths have existed; a run of 200 schedules seldom meets one.

Neither failure was a leak by the room or the gateway. In both, the room stored a commit that put the marker in text every reader may read, and the gateway then sent that text to every reader, as it must. The two schedules, cut down to eight operations each, are `packages/authority/test/projection.schedules.test.ts`.

## 1. A step made after one that fails was applied in the wrong place (defect, fixed)

04 §8 says of `sync.reset`: replace the confirmed document and try to re-apply the local steps; those that fail go to recovered edits. The client did this one step at a time and kept each step as it was written. A step is written for the document its predecessors left. When a predecessor fails, the steps after it were still applied at their old positions, which are off by as much as the failed step had moved the text behind it.

In the first schedule the owner deletes 47 positions across a region boundary and then types in the confidential paragraph. A restore arrives. The deletion does not apply to the restored content. The typing was applied 47 positions early, in the body paragraph before the region, and was sent to everyone as body text.

Every other path of the client that drops a step already maps the later steps back over it: the drop mode of `rebaseOver` (`packages/authority/src/rebase.ts`), used for a rebased acknowledgement, a remote commit and a dropped commit. The reset now does the same, with nothing to rebase over:

- `reset` in `packages/engine/src/sync/state.ts`, with a test in `packages/engine/test/sync-state.test.ts` ("maps a step made after one that fails back over it, so that it keeps its place"; it fails on the code as it was);
- the simulated client of the authority's tests, `packages/authority/test/harness/client.ts`.

A step that needs what the failed step had inserted fails with it and goes to recovered edits. A reset in which every step applies is unchanged. 04 §8 is not reworded: this is what "re-apply the local steps" has to mean.

## 2. Re-applying by position can still move unconfirmed text (open)

Item 1 does not make the re-application safe. Nothing maps the old document to the new content, so each step lands at the same position, and the new content need not be laid out as the old was. Typing made in one paragraph lands in another whenever the restored or imported content is longer or shorter before that place. A confidential region can be the source and a body paragraph the place it lands, and the reverse.

This is the behaviour 04 §8 describes, for a restore, an import, a migration and a repair. It is rare in use: it needs unconfirmed work at the moment a snapshot commit is stored. The simulation meets it because it restores often.

Options for the owner and the SYN stories (SYN-023):

- **Keep it** as it is (the default; nothing is changed).
- **Re-apply a step only where it lands in the block it was made in**, by the block's identifier (03 §9 keeps identifiers stable), and send every other step to recovered edits. Work then never moves to another paragraph or region; more of it goes to recovered edits after an import, whose content has new identifiers.
- **Re-apply nothing** after a snapshot commit: all unconfirmed work goes to recovered edits.

## 3. A user who may edit a read-restricted region can remove it (open)

In the second schedule a user in a group that is granted the confidential region as editor, and who may edit the body, removes the region and keeps its paragraphs (one `replaceAround` step). The room stores the commit with the scopes `body` and the region, and retires the region (07 §3, "When a region is deleted"). The paragraphs are body text from then on, and every reader of the document receives them.

The room did what 07 says. Whether it is what the owner wants for a region that is read-restricted (ADR 0019) is not stated anywhere: removing the region ends its restriction for everyone, and the user who does it needs no `manage` capability, only the right to edit the region and the structure around it. A user who may read the region could also copy its text into the body; that cannot be prevented. Removing the region is different in that it is one structural step and leaves no restricted copy behind.

Options for the owner: leave it; require `manage` (or the right that sets read restrictions) to remove or unwrap a region that is read-restricted; or write an audit event when a read-restricted region is retired by a commit.

## 4. What the simulation counts as a secret

The simulation's leak check looked for the marker in every message to a reader who may not read the region. That is right only while the marker stands nowhere but in the region. `ProjectionSim` (`packages/authority/test/harness/projection-sim.ts`) now replays the stored log itself, and when a stored version holds the marker outside the region it stops counting the marker as a secret for the rest of that run (`markerIsPublic`; counted as `declassified`). The check of the region's title, which is never anywhere but on the region, and of the sensitive value is unchanged.

Measured after the change, same command and machine, 6,000 schedules: no failure, and `declassified` was 1, so the check is as sharp as before in all but one run of 6,000. The property now also fails if that share rises above one run in 50, so that a later change to the simulation cannot blunt the check unnoticed.

## Consequences

- A snapshot reset no longer applies a local step in the wrong place because an earlier local step failed (engine and simulated client).
- The S12 property no longer fails for the two seeds above. It still checks every message for the marker in every run where the marker has not been stored outside the region.
- Items 2 and 3 are listed for the owner in the Notes of SYN-023 and in the integrator's report. No behaviour was changed for them.
