# ADR 0408: A region restore is applied as steps, split into linked commits (HIS-018)

Status: accepted as to the split (owner decision 36, `docs/owner-decisions-2026-11-15.md`); the member names below are proposed. Lane w7, 2026-11-18.

## Context

ADR 0374 applied a region restore as a snapshot commit, because the control plane had no way to hand a steps commit to a room. That left HIS-018 criterion 1 open (it asks for steps applied as one commit with origin `restore`), and SR-M29 of the second review pointed out that a snapshot commit replaces the whole document and could overwrite commits in other regions. Owner decision 36 answers the second point: a region restore over the commit size limit is split into several linked commits. The server-authored operation `author` (BE-039; the prefill, template and workflow routes use it) already reaches the room through the outbox with preconditions, so no new path was needed.

## Decisions

1. A region restore is applied as the steps `planRestore` computes, as commits of origin `restore` by the restoring person, handed to the room through the outbox (`restore-route.ts`, `writeSteps`). The `pre-restore` version is recorded at the old head first and the `restore` version at the last new commit, as before.
2. Steps that do not fit one commit are cut into the fewest runs that do (`splitSteps` in `@docedit/history`): at most the room's step count, and the encoded size plus the room's allowance of 4,096 bytes within the commit size limit. The plan carries them as `parts` (one run when the whole fits). `planRestore` makes a run of changed blocks one step; when that step alone is too large it makes the first block replace the run and each later block an insertion after it, so that the run can be cut and every state between two commits is valid (a region is never empty, no identifier is in use twice). A single block that cannot fit a commit is refused with `too_large`; the old snapshot fallback for a region is gone. A whole-document restore is still a snapshot commit (08 §8).
3. "Linked" means: consecutive commits of origin `restore` by the same person, one per part, between the two versions; their identifiers derive from the request (tenant, document, person, head, `toSeq`, region, part), so a retry is the same commits. The commit record has no member for a link and none was added.
4. Each part is checked against the head the one before made (`restorePartPreconditions`). A permission change records a control commit that moves the head without touching content; the route then tries the part again from the new head, up to three times, only when every commit that came in is a control commit. Any other commit in between stops the restore: the parts before it stay applied (history only moves forward, and the person can restore again from the `pre-restore` version), and the answer is `conflict` naming the part it stopped at. The `restore` version is not recorded for a restore that stopped.
5. The answer of an applied restore, the `version.restored` notice and the dry run carry `commits` (the number of commits) when it is more than one; the dry run carries it for every steps plan. Proposed member, with the others in ADR 0358.

## Not decided here

- The attribution of restored text in the room's map. The map follows each stored commit (HIS-014) without the hint that keeps the original authors, so text a restore brings back is attributed to the restoring person. `AttributionSource.restoreHint` exists for a replay that crosses a restore, but no store keeps the hint, and a hint kept only in memory would make the map after a reopening differ from the map before it.
- Splitting a single oversize block (one block that alone is larger than a commit may be).
- The size limits the control plane plans with are the defaults of `@docedit/authority` (500 steps, 1 MiB). An operator who tunes the room's limits (`DataPlaneSettings.limits`) makes the plan and the room disagree, and a part the room refuses as `too_large` stops the restore as under decision 4. Passing the room's limits to the control plane is a seam change that is not made here.
