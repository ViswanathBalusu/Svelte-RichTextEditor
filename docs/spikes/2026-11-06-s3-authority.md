# Spike S3: correctness of the authority

**Status:** spike result, 2026-11-06, SPK-016; not reviewed by the project owner.

## Question

Is the authority correct (11 §2, S3)? The questions cover:

- rebase and acknowledgement;
- deduplication, including commits still being stored;
- the durable and tentative states, and fencing;
- the grants-revision condition;
- the outcome check for regions, suggestions and fills.

## Answer

Yes, on the evidence of the in-process simulation. One crash and three rule gaps turned up and were fixed; all four are listed under "Defects found". Running the same suite against the real service with PostgreSQL is SYN-047, which the 1a exit criteria require. This spike does not cover it.

## What was built (kept, not throwaway)

| Part | Where |
|---|---|
| Step allow-list, rebase (04 §6) in reject and drop modes, apply, range mapping | `packages/authority/src/steps.ts`, `rebase.ts`, `ranges.ts` |
| Invariants on the result (validate, I2 and I3 transitions) | `packages/authority/src/invariants.ts` |
| Capabilities, effective access (07 §4), scope partition and diff with identity pruning (07 §5.1), the outcome check: P1, P2, P4, P6, P7 to P9 and 07 §5.3 | `packages/authority/src/permissions/` |
| The room: 04 §5 steps 1 to 10 as a deterministic state machine, with group commit, writes conditional on epoch, primary key and grants revision, recovery from failed, unknown and fenced writes, control commits, and resume | `packages/authority/src/room/` |
| Reference client (04 §7 to §9), fault-injecting storage, network and scheduler, permission oracle | `packages/authority/test/harness/` |

## Evidence

All commands run from the repository root.

| Test | What it shows | Result |
|---|---|---|
| `convergence.property.test.ts` (`S3_RUNS=3000`) | Random schedules over 2 to 7 users of every role, one of them malicious. Faults: failed writes, writes whose outcome is unknown (stored or not), grant changes with the notification to the room lost, dropped connections, room crashes with failover. After quiescing, the suite checks G2, G3, G4 and G6. It replays the log and checks every stored commit against the oracle, using the permissions of the revision the commit was checked against (G7) | 3,000 schedules pass in 33 s. Over all runs: 7,875 step commits stored (17,499 steps); 8,928 rejections (4,953 `permission_denied`, 2,170 `unavailable`, 1,077 `read_only`, 353 `invalid_op`, 191 `conflict`, 184 `rebase_failed`); 3,690 storage faults; 1,048 failovers; 8,621 grant changes, 2,897 with the notification lost |
| The same suite, scope check | For every stored commit, the scopes recorded by the identity-pruned diff equal those found by serialising each scope (PRM-017) | Pass |
| `rebase.differential.test.ts` | Against the real prosemirror-collab plugin (`receiveTransaction`, `sendableSteps`): the drop-mode rebase produces the same steps and document. Reject mode produces the same steps, or `rebase_failed` exactly when collab drops a step | 400 random pairs pass; over 300 per run reach the comparison, and some include dropped steps |
| `room.test.ts` | One scenario per rule: ack after storage, rebased ack, `busy`, deduplication while waiting for storage and after, another user's id, `invalid_op`/`reload` and `stale_base`, disallowed step types, `too_large`, `field_invalid`, `read_only`, failed and unknown writes, fencing, the grants-revision condition with the notification lost, and resume | 14 pass |
| `outcome.test.ts` | P1 through every step type (mark, attribute, node mark, crafted `replaceAround`), P2, P4, P6, P7, P9, 07 §5.3, approved regions and leases; pruning visits fewer than 10 nodes for an edit in one region | 13 pass |
| `invariants.test.ts` | Split with a fresh id, duplicate ids, changing the id of its only holder, retired region ids, wrongly typed fills | 6 pass |
| `fuzz.test.ts` (`FUZZ_MS=20000`) | Arbitrary envelopes and hostile step JSON against the room: it must never throw, always answer, and leave only valid documents | 118,200 submissions in 20 s; no crash, no stall; 312 accepted, every one valid |

## Defects found and fixed

1. **Crash.** A mark step mapped past the end of the document made ProseMirror *throw* inside `AddMarkStep.apply`, where it should have reported a failure. `rebaseOver` now treats any exception in mapping or applying as a failed step. Found by the simulation's malicious client: a stale base plus "bold the whole document".
2. **I2 transition.** ProseMirror's split copies the node's attributes, so two paragraphs briefly share an `id`. The identifier fix-up then changes one copy's `id`, and the first version of the check refused that as an identity change. The rule now reads "a non-null `id` never changes for its only holder". Re-identifying one of two duplicates gives a copy its own identity. Recorded for CDM-012.
3. **Resume reported another user's commit as accepted.** A client resuming with another user's commit id was told "accepted", and then waited for a stream entry that never came. Only the caller's own commits are now reported accepted; any other id is "unknown", so a resubmission meets the duplicate check and is refused (07 §16, "Replay another user's commit identifier").
4. **Spurious control commit.** The room did not know which grants revision was in force when the document was created, and recorded a control commit for it. `RoomInit.initialRevision` now carries it.

## Choices made where the spec is silent or contradicts itself

| Point | Choice | Source |
|---|---|---|
| Field scopes for added or removed fields | A field present in one version only is a differing `field:<id>` scope. Adding or removing it needs `edit` in its container (already required by the container's scope). Only value changes go through P7 to P9 | 07 §5.1 |
| Moved regions | A region on both sides that is not on the longest common subsequence of the body's children has moved. P2 then requires `structure`, `edit` in the body and `edit` in the region | 07 §5.2 P2 |
| Creating a restricted region | Needs `manage`, as flipping a policy does | 07 §16 |
| `trackChanges` | Turning it off needs `manage`. While it is `everyone`, P4 applies to every user | 07 §5.2 |
| Document locked or archived | `read_only` when no fill is possible, before P6. This settles contradiction 3 of the findings note in favour of 04 §5 step 1 | findings §2 item 3 |
| Base older than a snapshot commit | Not exercised: the spike has no snapshot commits | findings §2 item 1 |
| Access map | Computed afresh for every submission from the tentative document, so that policies changed by an earlier commit and expiries always count. A production room caches it and invalidates the cache on change | 07 §4 |
| Batches | One write carries only commits checked against the same grants revision | 04 §5 step 9 |

## Not covered, and why

- **The real service.** These checks run against PostgreSQL in SYN-047; this spike uses the in-memory storage of the harness. The storage contract is `WriteRequest` and `WriteResult` in `packages/authority/src/room/types.ts`.
- **Admission control** (`rate_limited`; 04 §12), **snapshot commits**, **server-authored commits other than control commits**, and the **rules language's visibility checks** (P7 uses a hook that FRW fills). None exists yet.
- **Performance.** Every commit is validated in full, and access is computed afresh each time. 04 §12's target of well under a millisecond needs incremental validation and cached access. FND-007 and SYN-039 measure it.
- **Gaps in the oracle**, which make it more permissive than the spec but never stricter: it does not model 07 §5.3, does not treat region moves as needing `edit` in the region, and does not cover section breaks, which the base document has none of.

## Recommendation

Proceed with the server-authoritative design (ADR 0001, accepted). Before phase 1a's exit:

- run the simulation against the PostgreSQL storage (SYN-047);
- add snapshot commits and admission control;
- make invariant checking incremental.

Keep the harness: its storage, clients and oracle are the regression suite for the room.
