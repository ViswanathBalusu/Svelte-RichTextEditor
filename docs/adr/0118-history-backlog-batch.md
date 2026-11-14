# 0118. History backlog batch: open questions from the history packet

**Status:** proposed (2026-11-13). Written by the history developer in the backlog batch, round 1, for the algorithm stories of `packages/history`. Not reviewed by the owner.

## Context

The stories HIS-011, HIS-012, HIS-014, HIS-017 and HIS-033 were checked against the tests in `packages/history`. Criteria whose tests exist are ticked with Evidence. Criteria that the spec leaves open, or that need code outside the package, stay unticked, and each reason is in the story's Notes. This note lists the points that need a decision, with the default the code takes.

## Open questions and the default taken

1. **Shape of spans for field changes (HIS-011 criterion 2; HIS-012 criterion 3).** 08 §6 says a `field` change carries spans with `op`, `at`, `text`, `user` and `seq`, but a field value is a single value, not a text. The code reports a `field` change with `fieldId`, `blockId`, `user` and `seq` and no `spans`. Question: is a field change one whole-value replacement (current code), or should it carry a span over the value?

2. **The kind `moved` (HIS-012 criterion 7).** 08 §6 lists the kinds `modified`, `added`, `removed` and `formatted`. The code also reports `moved` for a block that changed position, and it reports the same block once in both methods. Default in code: keep `moved`, since the spike HIS-043 is open. Question: should a move be a `moved` kind, or a removal plus an addition as HIS-012 allows?

3. **Worker thread and the room (HIS-011 criterion 4; HIS-014 criterion 4).** The package runs on plain data in a worker thread (`test/harness/compare-worker.ts`), and it serialises the attribution map. The room host that calls the functions, and that opens a room from a checkpoint, is in `packages/authority` and the services. Default: these criteria stay unticked for this package. Question: none for the package; the room wiring is tracked under BE-019 and the authority package.

4. **Agent identity on assistant commits (HIS-017 criteria 1 and 4).** The package takes the agent from the commit. Where the agent comes from (token claim or connection) is open in UX-044 (second review SR-M23). Default: unticked. Question: owner decision on the source of the agent identity.

5. **Comparison method boundary (HIS-011 criterion 1).** The default limit is `STEP_LIMIT` = 2000, as the story says, and a test now checks the boundary at 2000 and 2001. Question: none beyond the spec; recorded for traceability.

6. **Bundle or store for verification (HIS-033 criterion 1).** The tool reads an exported bundle. Reading the live stores is an adapter that the document service provides. Default: the bundle path meets the criterion, since it says "or". Question: whether the operator needs a store reader in the tool itself.

## Round 3 (2026-11-13): stories HIS-006, HIS-007, HIS-015, HIS-027, HIS-030

These stories were taken in round 3 for the rules that `packages/history` can state as pure functions. The service stores and raises what they return. Each open point below is decided by the default the code takes, and none is an owner decision.

7. **Day-to-week boundary of thinning (HIS-030 criterion 1).** 08 §11 gives 30 days for keeping every checkpoint, and says older ones are thinned to one per day and then to one per week, but not the age where "daily" becomes "weekly". Default in code: none. `thinningPlan` takes `weeklyAfterMs` from the caller and refuses a value below 30 days. Question: the owner (or the operator) gives the age; until then HIS-030 criterion 1 stays unticked.

8. **Which checkpoint a period keeps (HIS-030).** Default in code: the checkpoint with the highest `seq` in each UTC day (before the weekly boundary) or each epoch-aligned UTC week (after it). A period whose kept checkpoint is not verified against a replay is held back whole. Question: none beyond the spec; recorded for traceability.

9. **Dedupe of named versions (HIS-007 criterion 5).** The criterion says "same document, `seq` and kind, only one version exists", and it is applied to every kind as written. So a second named version at the same `seq` returns the first one, with its name, and does not store a new one. Question: whether a `named` version may repeat a `seq` with a different name. Default in code: the criterion as written (one version per `seq` and kind).

10. **Refusal codes for version creation (HIS-006 criterion 3, HIS-007 criterion 6).** A kind outside 08 §4 and a `seq` above the head are `validation_failed`; a `seq` below the caller's gate is `forbidden`, as in the rest of 08 (HIS-024). The spec does not name the codes. Question: none beyond the DEP registry; recorded for traceability.

11. **First read marker (HIS-027, first visit).** 08 §10 does not say what a caller sees with no marker. Default in code: `advanceMarker` stores any requested `seq` up to the head when no marker exists, and `activitySince` starts at the gate. Question: owner decision on what a first visit shows.

12. **Label of an erased person (HIS-015 criterion 5, HIS-038 criterion 2).** Default in code: an erased identifier is shown as an unknown person, and an assistant named on its run is still shown, because the agent comes from the connection and not from the person. Question: none; recorded because 08 §13 does not say whether the agent name stays.

13. **Who may name a version (HIS-006 criterion 2).** `createVersion` takes `canEdit` from its caller. Default: the service computes it with `editsSomewhere` (08 §9). Question: none; the route is the service's and is not built in this package.

## Round 4 (2026-11-13): stories HIS-031 and HIS-040

These stories were taken in round 4. The code adds a legal hold state (`src/hold.ts`), a hold switch in the thinning plan (`src/thinning.ts`) and a tombstone of one commit's payload (`src/tombstone.ts`). Each point below is decided by the default the code takes; none is an owner decision.

14. **Verifier status after a tombstone (HIS-040 criterion 1).** The chain verifies, but a checkpoint past the removed commit cannot be replayed, so `verifyBundle` reports `incomplete` and not `intact`. Default in code: keep the verifier's rule as it is; the chain check is `problems: []`. Question: owner decision on whether a tombstone should be reported as `intact` with the removed payload named, which would change the verifier's contract (HIS-033).

15. **Copies that hold a tombstoned text (HIS-040 criterion 4).** 08 §13 does not say whether a tombstone covers later checkpoints or the attribution map. Default in code: `tombstone` reports every checkpoint with a `seq` at or after the removed commit (each was built by replaying it), and says that the attribution runs may name it. It rewrites nothing. Question: owner decision on whether checkpoints are rebuilt, removed, or kept with a notice.

16. **Refusal codes for a removed payload (HIS-040 criterion 2).** A read of a removed payload returns `not_found` with a fixed reason that names no text. Default in code: `not_found`, as the DEP registry gives for an absent detail. Question: none beyond the registry; recorded for traceability.

17. **Legal hold and erasure (HIS-031 criterion 5).** 08 §11 and 13 §10 do not say what happens when a person under hold asks to be erased (HIS-038). Default in code: none. Question: owner or legal decision; HIS-031 criterion 5 stays unticked until then.

18. **Who may set a hold, and the audit store (HIS-031 criterion 4).** The code checks that a change names an actor, a reason and a time, and that it changes the state. It does not check the caller's credential, and it does not store the audit record. Question: the service and the administration API decide who may call `applyHold` and where the audit record is kept.

## Round 6 (2026-11-13): stories HIS-043 and HIS-044 (spikes)

Both spikes ran in `packages/history` on this machine (Intel Core i9-10900KF, 20 logical cores, 128 GiB, Windows 10.0.26300, Node.js 22.18.0), on corpus `docedit-corpus 2 (dd2dac5a)`. The figures are one run each with the seeds named; they are targets to validate on real documents, not product limits.

### HIS-043: comparison quality and cost

Criteria 1 and 4 are met by `test/scenarios.ts` (fifteen scenarios, each with a hand-written list of expected changes), `fixtures/comparison/*.json` (the recorded output of both methods) and `test/comparison-fixtures.test.ts`. Criterion 2 is met by `scripts/comparison-cost.ts` (the run of this round, 3,000-commit synthetic trace per document, seed 43, median / p95 in ms):

| Document | Range (commits) | Samples | Steps method | Aligned method |
|---|---|---|---|---|
| 20 pages (123 body children) | 100 | 30 | 12.3 / 29.7 | 9.0 / 14.5 |
| 20 pages | 2,000 | 10 | 127.4 / 161.2 | 29.1 / 36.3 |
| 100 pages (515 body children) | 100 | 30 | 15.7 / 37.4 | 12.8 / 17.9 |
| 100 pages | 2,000 | 10 | 232.6 / 277.1 | 76.5 / 99.9 |

Criterion 3, the recommendation:

- Moves. Both methods report a moved block once, with the kind `moved`, and the same output for paragraph moves, section moves, row reordering and moved-and-edited paragraphs. The fixtures show that the two methods agree on these scenarios; they do not show that they agree on other documents. The kind `moved` is kept until the owner decides (item 2 above). Interfaces should label a move as a move, not as a rewrite.
- Table changes. Rows and cells are matched by identifier. Inserted, removed and reordered rows, a column added with new cells, and merged cells all come out as the expected kinds. A row copied from another row gets a new identifier and is reported as added; the output is correct by identifier, but a reader may expect it to read as a copy.
- Style changes. A style applied to many paragraphs is reported as `formatted` with the attribute names. A changed style definition is reported as `definition`, once, not once per paragraph that uses it.
- Approximate output. The steps method is exact for the recorded steps. The aligned method (used beyond 2,000 commits or across a snapshot) names who inserted text from the attribution map at the later version, but it cannot name who deleted text or who changed formatting (HIS-012 Notes). A field change is one whole-value replacement (item 1 above).
- Warnings the interface must give: a comparison that crosses a checkpoint or a snapshot is approximate about deleted text and formatting authors; a field change shows the value, not the spans inside it; a move is reported by identity, so a block moved and then rewritten by someone else can appear as two changes.
- Which method to serve. The steps method is the default up to 2,000 commits, as HIS-011 says. The aligned method is faster at 2,000 commits on these figures (29 to 77 ms median against 127 to 233 ms), so it is the choice for longer ranges. No time threshold for showing a wait to the user is set here; that belongs to UX.

### HIS-044: attribution map size and cost

Criteria 1 and 2 are met by `scripts/attribution-size.ts` (the run of this round: 20 commits per page, a region restored to its content 250 commits earlier every 250 commits, six people and an assistant, seed 44). Both maps are updated step by step; the memory column is the heap used by a map rebuilt from its serialised form, after a collection (`--expose-gc`).

| Document | Commits | Restores | Map | Runs | Memory (MiB) | Serialised (KiB) | Zstandard (KiB) | Step (ms, median / p95 / max) | Who wrote this, one region (ms, median / p95) |
|---|---:|---:|---|---:|---:|---:|---:|---|---|
| 20 pages | 401 | 1 | per document | 579 | 0.05 | 11.8 | 2.6 | 0.028 / 0.059 / 1.114 | 0.0066 / 0.0995 |
| 20 pages | 401 | 1 | per block | 703 | 0.08 | 15.1 | 4.7 | 0.025 / 0.112 / 0.671 | 0.0009 / 0.0988 |
| 100 pages | 2,008 | 8 | per document | 2,821 | 0.24 | 59.7 | 12.5 | 0.019 / 0.040 / 2.385 | 0.0093 / 0.0231 |
| 100 pages | 2,008 | 8 | per block | 3,341 | 0.38 | 73.8 | 21.7 | 0.019 / 0.083 / 1.249 | 0.0007 / 0.0021 |
| 300 pages | 6,024 | 24 | per document | 8,390 | 0.71 | 181.6 | 38.0 | 0.018 / 0.034 / 1.849 | 0.0141 / 0.0288 |
| 300 pages | 6,024 | 24 | per block | 10,015 | 1.13 | 225.8 | 64.2 | 0.010 / 0.074 / 3.829 | 0.0006 / 0.0012 |
| 1,000 pages | 20,080 | 80 | per document | 27,629 | 2.34 | 613.6 | 129.2 | 0.022 / 0.082 / 12.158 | 0.0515 / 0.0957 |
| 1,000 pages | 20,080 | 80 | per block | 33,007 | 3.74 | 759.9 | 217.8 | 0.014 / 0.133 / 7.184 | 0.0012 / 0.0026 |

Criterion 3, the recommendation:

- Keep one map per document. At 1,000 pages the per-block form has more runs, about 24% more serialised bytes raw and about 69% more compressed, and about 60% more memory, and its step time is not better at the 95th percentile. Its gain is in answering "who wrote this" for one region, which is already below 0.1 ms per query with the per-document map. Per-block storage would be worth reconsidering only if region lookups became the bottleneck, which these traces do not show.
- Limit. These figures do not choose a limit. They give the base for one: about 0.6 MiB serialised (about 0.13 MiB compressed) at 1,000 pages with 80 restores on this trace. The owner or operations should set the checkpoint size budget from them, with the real corpus, before any limit is written into the spec.
- Caveats. One seed, one machine, a synthetic trace of 20 commits per page, and the maxima are single observations. The memory column is a heap difference after a collection and is small in absolute terms; treat it as a rough figure. A trace with more authors per region or a longer run of restores on real documents could change the run counts.

### Open items found this round

- HIS-037 (audit export) is not built in this package. The bundle format (`LogBundle`) has no range filter, no anchor selection for a range, and no instructions field, and a bundle that hides part of a range for a caller cannot keep the chain verifiable without an owner decision on what a hidden commit looks like to an outsider. Stays unticked; the decision is needed (see Notes on HIS-037).
- The figures above are the only measurements in this round; none is taken from the spec.

## Round 7 (history, 2026-11-13)

Status: proposed. Decisions taken by the history lane in this round, each on the spec's default or as a finding, not as an owner decision.

### HIS-034: when a changed webhook may go

- Rule (05 §7 gives the 10-second debounce; the trailing publication is the inference the story already records): at most one `dep.document.changed` per 10 seconds per document, measured from the last publication. A head that arrives inside the window waits, and the window's end publishes the latest durable head, so the last state is announced. Only durable heads are published, and a published head never moves back. The rule is `HeadPublisher` in `packages/history/src/publication.ts`; the service raises the webhook.
- Not decided here: whether a webhook is sent when the window has passed with no change (the rule sends nothing), and whether the trailing publication is required by the owner (it is the story's criterion 2).

### HIS-006 criterion 2 and HIS-026: who may name a version, and the gate

- Naming a version needs `edit` somewhere in the document. The test derives it per role with the authority's `editsSomewhere` (08 §9), so the rule and the function the service calls agree.
- HIS-026 criterion 2 is ticked (requests at the gate and at the head succeed). Criterion 3 is not ticked: its comparison part is tested, its attribution part is the finding below.

### Finding: attribution below the gate (HIS-026 criterion 3, HIS-015 criterion 2)

- `attributionFor` (`packages/history/src/reader.ts`) returns, for a visible version, the runs of the text at that version with their `user` and `seq`, including runs written by commits below the reader's gate. Probe: two commits by two people, gate at the head; the answer named the first person with `seq` 1.
- The spec (08 §7, §9; 07 §8) says the answer is limited by the gate, and HIS-026 criterion 3 says a response contains nothing from below it. Whether such runs are withheld, shown as an unknown person, or kept is not decided. The code is unchanged and HIS-026 criterion 3 (attribution part) and HIS-015 criterion 2 stay unticked until the owner decides. Recommended default for a decision: show the run as the hidden author with no `seq` (the mechanism exists as `HIDDEN_AUTHOR` in `attribution.ts`).

### Open items of this round

- HIS-034 criterion 3 (the export manifest) needs EXP to write `seq` and the head into the manifest; the publisher has them.
- HIS-037 and HIS-040 are not changed in this round (see their Notes).

## Round 10 (history, 2026-11-13): leftover fixes and a comparison refusal

Status: proposed. Decisions taken by the packet's developer, to be confirmed by the owner.

- **Segment format names.** The payload-segment format of `src/cold-segments.ts` is renamed `PAYLOAD_SEGMENT_FORMAT` (`docedit-payload-segment/1`, unchanged value). Both modules exported `SEGMENT_FORMAT` and `src/index.ts` re-exported the cold one, so the audit export (HIS-037, `docedit-audit-segment/1`) was hidden from the package entry. The audit constant keeps the name `SEGMENT_FORMAT`.
- **A steps commit with no steps is a removed payload.** `compareSteps` refuses with `not_found` for it, naming the commit, instead of skipping it (HIS-040 criterion 2; HIS-032 criterion 4). Default taken: the spec says a removed detail fails cleanly and never returns wrong content (08 §13). A `control` or other non-steps commit with no steps is still compared. Assumption to confirm: the service hands over a removed payload as a `steps` commit with `steps: []`, and never as an empty steps commit that was really recorded.
- No criterion was ticked in this round by this decision alone; HIS-040 criterion 2 and HIS-032 criterion 4 stay open because the rebuild and the list path are the services'.
