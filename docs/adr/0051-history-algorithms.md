# ADR 0051: The history algorithms as a universal package

**Status:** proposed, 2026-11-06. Records where the history computations of 08 live and the choices that building them needed (HIS-008, HIS-011, HIS-012, HIS-014, HIS-017 to HIS-021, HIS-033, HIS-046), with the results and recommendations of spikes HIS-043 and HIS-044. Nothing here amends 05, 06 or 08 yet; the proposed amendments are at the end. The project owner has not reviewed any of it.

## Context

08 says what history gives users but not where its computations run. 01 §6 lists no history package: `authority` holds rebase, apply, invariants, the outcome check and range mapping, and 08 §6 says "the service computes comparisons". The local backend (01 §5) has no service, and the conformance kit and tests need the same results, so the computations cannot live in `services/document-service` alone. PLAN-1b left the home of the verification tool of HIS-033 to the story.

The log is recorded in full and hash-chained (HIS-001, HIS-002; ADR 0020), the authority rebuilds the content at any `seq` (HIS-005, `contentAt`), and read restrictions are projections (ADR 0019). The history functions build on these.

## Decision

### 1. Where they live

A new universal package, `packages/history` (`@docedit/history`): lib ES2023, no ambient types, WebCrypto and TextEncoder only through `@docedit/model`, like `authority`. It depends on `@docedit/authority` (projections, the gate, the commit types, `contentAt`, `authorise`) and `@docedit/model`, and on `prosemirror-changeset` 2.4.4 (MIT) for HIS-011. `authority` never depends on it, so the `Room` stays free of history code: the room host keeps the attribution map next to the room and applies each durable commit to it. The verification tool is the package's `bin`, `docedit-verify-log` (`scripts/verify-log.ts`, Node.js), over a universal core (`verifyBundle`). The main session is asked to add `history` to the universal list of `.dependency-cruiser.cjs` and CLAUDE.md.

Every function is pure and takes plain data or callbacks, so a room host can run it in a worker thread (06 §1) and a local backend in a browser.

### 2. Comparisons (HIS-011, HIS-012)

Both methods compare the requester's projections of the two versions (section 7) and share one classification of identified blocks (blocks, rows, cells, stories, footnote paragraphs, hidden-region placeholders, definitions and form fields):

- `added` and `removed`: the outermost identified block on one side only; `moved`: on both sides but in another container, or out of order among the blocks both sides share (a longest increasing subsequence keeps the rest in place); `modified`: a leaf block whose inline content differs; `formatted`: block attributes, block marks or the marks of unchanged text differ; `field`: a value differs; `definition`: a style, numbering or other definition was added, removed or changed. `moved` and `definition` are not in 08 §6's list: they are the recommendation of HIS-043 (below).
- Spans come from a diff of the leaf block's tokens in both methods: words, runs of white space and single other characters (each Chinese character and kana a word) for `word`, code points for `char`. `at` is the offset in the block's content in the newer version, in ProseMirror positions. A diff that needs more than 2,000 edits reports the block as one deletion and one insertion.
- Changes carry `type`, `path` (identified ancestors, so rows and cells are named), `region`, `attrs`, `marks` and `hidden` (a placeholder) where they apply.
- **From the steps** (`compareSteps`): `prosemirror-changeset` over each commit's projected steps (`projectCommit`) gives, for every position, the commit that inserted it and the commit that deleted it. Both span kinds carry `user`, `seq` and `agent`; `formatted` carries the commit that changed the block last. Text that moved into a block without being written there (a split, a join, a word only partly typed) is attributed to the nearest change.
- **By aligning blocks** (`compareStates`): insertions, `added` and `moved` name the author from the attribution map at the later version; deletions, `removed` and `formatted` name nobody, because the map cannot (HIS-012 Notes). DEP's `DiffSpan` (spec/dep) requires `user` and `seq`; they are optional here, and PRO should relax the schema.
- `field` and `definition` changes name the latest commit in the range whose scopes include `field:<id>` or `defs:<type>/<id>` (the per-scope table). A placeholder names nobody.
- **The entry point** (`compare`): both versions must pass the gate as single states; the steps are used only when the requester may also read the run of commits from `fromSeq` (ADR 0034), the versions are at most 2,000 commits apart and no snapshot commit lies between. A named version is therefore compared by alignment for a reader below the gate, so no intermediate commit appears. Every refusal comes before any rebuild. `ComparisonCache` keys by incarnation, both seqs, region, granularity, method and the visibility class.

### 3. The attribution map (HIS-014, HIS-017)

- Runs cover every position of the document, not only text, so "exactly once" is checkable as `sum(len) = doc.content.size`. Runs are kept by length in chunks of at most 128, so a step costs a walk over chunk sizes plus the chunks it touches.
- A step maps the runs through its position map; inserted content gets one run of the commit's user, `seq` and agent. Mark and attribute steps change nothing, and so does a wrapper re-typed in place (a structural replace-around step whose replaced tokens keep their size: `setBlockType`). Pasted and moved content is inserted content. The agent comes from `StoredCommit.agent`, stamped from the connection; the origin is never read.
- A restore passes a hint per step (the runs of the restored content at `toSeq`); the inserted runs keep those authors and gain `restoredBy` and `restoredSeq` from the restore commit (08 §7).
- The serialised form (version 1) is a table of authors and pairs of length and author index, saved with each checkpoint (06 §4.2 side file). `attributionAt` rebuilds the map at any `seq` from the nearest saved one plus a replay; a snapshot commit needs the map saved with its checkpoint.
- A replay can only reproduce a restore's runs with its hint. The room host should therefore write a checkpoint, with the map, right after each region-restore commit: the `restore` version points at that `seq`, so 08 §11 never thins it, and no replay to a later `seq` crosses the restore. A whole replay from `seq` 0 (only needed to backfill maps, HIS-014 Notes) needs the hint again, which needs the restore's `toSeq`: the `versions` row of 06 §4.1 has no place for it yet (proposed below).
- `authorLabel` says `assistant` only when a run, span or group carries an agent; the shell renders it with its own strings and icon.

### 4. The history list (HIS-008)

08 §4's rules, with the readings the spec leaves open:

- the idle gap is a parameter, five minutes by default;
- "the set of authors changes": the authors at a commit are those who committed within the idle gap before it (a person and the assistant acting for them are two authors). Two people writing together form one group; a group ends when one joins or leaves;
- "a change of origin": ordinary editing (`input`, `paste`, `format`, `undo`, `redo`) is one origin; every other origin is one of its own;
- a stored version ends the group it lies in;
- a day is the calendar day in a time zone the caller passes (IANA name, default UTC), as an open question of HIS-008 asks;
- control commits are left out unless asked for, until PRM decides who sees them (HIS-008 Notes);
- versions no group ends (before the first visible commit) are listed on their own.

Pages are newest first, `{ items, nextCursor }`, at most 200 items (default 50), with a cursor of the form `h1.<seq>.<n>` that clients treat as opaque. `namedOnly` lists named versions; with `region` or `field` it keeps the named versions after which a matching commit lies since the previous one. The gate keeps commits after `minVisibleSeq` and the versions it shows as single states, so a reader who sees named versions only gets the named versions.

### 5. Restores (HIS-018 to HIS-021)

- **Checks, before any work, the same for a dry run:** `toSeq` must pass the gate; a region restore needs the region to exist now and at `toSeq` (`not_found` otherwise, also for a region the requester may not read), refuses an approved region or one leased to someone else with `conflict`, and needs `edit` in the region (`authorise('restore.region')`, else `forbidden`); a whole-document restore needs `manage` (`forbidden`) and no active workflow (`workflow_active`).
- **One region:** unchanged blocks that keep their order are left alone; each stretch between them is one replace step with the blocks at `toSeq`. The region node's own attributes are not restored: the title needs `structure` and the policy `manage`, and both are structure and permission state rather than content.
- **Identifiers:** a restored block whose identifier is in use outside the blocks the restore removes gets a new one, derived from a salt that is fixed for one request (`idSalt`), so a dry run and its restore agree. A whole-document restore renames only regions whose identifiers were retired (I3).
- **Definitions** (07 §13): styles, numbering definitions and roles the restored content needs, with the styles and numbering they depend on, are recreated when the user holds `structure`; otherwise paragraphs and tables fall back to the default style, character styles and numbering are dropped and the assignee is cleared, and the plan lists them (`replaced`).
- **Too large:** past the commit limits (04 §3.1) a region restore falls back to a snapshot commit of the current document with only that region restored (08 §8, the spec's default). Its `head` precondition makes the room refuse it if anything was accepted since it was planned, so it cannot overwrite other regions; review SR-M29 proposes several commits or `too_large` instead, which is the owner's or PRO's to decide.
- **Preconditions** (`head`, grants revision, the region's state; for a document, `workflowActive: false` and the approved regions) travel with the plan, so the room checks them again when it applies it (04 §5; SYN-030; HIS-020), together with its invariant and outcome checks.
- **Dry run:** the plan plus the aligned comparison from the head to the result, as `fromSeq` head and `toSeq` head + 1, on the requester's projection. Planning has no effects.

### 6. Verifying a log (HIS-033)

The tool reads a bundle (`docedit-log-bundle/1`): the metadata rows of ADR 0020 with payload hashes, hashes and stored links, the payloads still held, checkpoints with their content hashes (`documentHash` of the envelope) and anchored heads. It checks the stored link and the recomputed hash of every record, each payload present against its hash and size, the head, supplied heads, and every checkpoint a replay can reach from an earlier one whose content the bundle carries. It prints one JSON report and exits 0 intact, 1 altered (a hash differs), 2 incomplete (a record is missing, a head lies outside the log, a replay could not run because payloads are thinned) or 3 unreadable. Reasons are fixed wording: no document text, not even a library's error message. The service can build the same bundle from its stores; HIS-037's audit export can carry it.

### 7. Read restrictions (HIS-046)

Every function that returns content, text, attribution or values takes the requester's hidden set. The hidden set of a history read is the union of what the requester's current access hides in each version the read touches and in the head (`hiddenAcross`): a confidential region deleted since keeps its policy in the old version and lost its grants with it, so it stays hidden; a value that is sensitive now is hidden in old versions too. Comparisons, old versions and attribution are computed on projections; a hidden region is one position of nobody in a projected map; commit scopes of hidden regions and values are left out of the list, and commits that changed only hidden content are listed without them, as HIS-046 criterion 3 says (S12's table said to omit them). Filters, attribution and field history on a hidden scope answer `not_found`, as for a scope that does not exist. A fork's content is the full document for `manage`; otherwise hidden regions are left out and hidden values cleared, because a fork cannot hold placeholders.

## Spike HIS-043: comparison quality

Fifteen scenarios (`packages/history/test/scenarios.ts`) each list by hand the changes a reader would expect; `fixtures/comparison/*.json` records both methods' output next to that list and is the regression fixture of HIS-011 and HIS-012. Both methods name exactly the expected changes in all fifteen. Where the output is approximate:

| Scenario | What both methods report | Where it is approximate |
|---|---|---|
| Paragraph moved; section moved; rows reordered | `moved` for each block out of order | A section is three `moved` blocks, not one section |
| Moved, then edited | `moved` and `modified` with the edit | Exact |
| Rows inserted or deleted; column added | `added` or `removed` rows and cells; the table `formatted` (`grid`) | Exact |
| Cells merged | the first cell `formatted` (`colspan`), the second `removed`, its paragraph `moved` into the first | Three changes for one merge |
| Style applied to five paragraphs | five `formatted` (`style`) | One change per paragraph |
| Style definition changed | one `definition` change with the attributes | The paragraphs that use the style are not named |
| Paragraph split | the first part `modified` (its tail deleted) and the new paragraph `added` | The added paragraph's text was not new |
| Paragraphs joined | the first `modified` (text inserted), the second `removed` | The inserted text was not new; by alignment its author and `seq` are the original ones (a `seq` before `fromSeq`), by steps the joiner |
| Interleaved typing, a field filled, a paragraph pasted | as expected; text inserted and deleted inside the range cancels out | Exact |

Cost, measured on 2026-11-06 on the development machine (Intel Core i9-10900KF, 20 logical cores, 128 GiB, Windows 11 10.0.26300, Node.js 22.18.0), corpus version 2, with `node packages/history/scripts/comparison-cost.ts 3000 0 43`: a synthetic trace of 3,000 commits per document (typing, deleting, marks, splits, joins, pastes, alignment), 30 ranges of 100 commits and 10 of 2,000, each compared once by each method; wall-clock milliseconds, median / 95th percentile, in one process while other agents used the machine.

| Document | Range | From the steps | By aligning blocks | Changes (median) |
|---|---|---|---|---|
| pages-20 | 100 | 11.0 / 33.3 | 7.9 / 11.9 | 96 |
| pages-20 | 2,000 | 132.0 / 151.6 | 30.7 / 41.9 | 713 |
| pages-100 | 100 | 16.5 / 32.8 | 12.5 / 18.5 | 102 |
| pages-100 | 2,000 | 252.6 / 383.7 | 77.8 / 94.9 | 1,287 |

The rebuild of the two versions (HIS-005) and of the map at the later one is not included.

**Recommendation.** Report moves as `moved` in both methods, as built: block identifiers make a move detectable whatever the steps were. Keep one change per block, and let the interface group them: consecutive `moved` blocks as one moved passage, `formatted` changes with the same attributes as one "style applied to n paragraphs", a merge as one table change. Report definition changes as `definition`, and name the paragraphs that use a changed style in the summary rather than in the changes. The interface must say that split and joined text is shown as deleted and inserted, that a comparison across a snapshot or more than 2,000 commits names nobody for deletions and formatting, and that an inserted span whose `seq` is before `fromSeq` is text that moved rather than text written in the range. At 2,000 commits the step method costs three to four times the aligned one (a quarter of a second at the median on 100 pages); both run in a worker, and these figures give no reason to change the 2,000-commit bound of 08 §6.

## Spike HIS-044: the size of the attribution map

Measured on the same machine on 2026-11-06, corpus version 2, with `node --expose-gc packages/history/scripts/attribution-size.ts 20 44`: 20 commits per page by six people and an assistant (the trace above), and every 250 commits one changed region restored to its content 250 commits earlier with its original authors kept. Memory is the heap used by five copies rebuilt from the serialised form, divided by five, the median of three measurements; sizes are the serialised JSON and its Zstandard compression; step times are per step, median / 95th percentile / maximum; "who wrote this" is one region, found by position in the document map and by identifier per block.

| Document (estimated pages) | Commits | Restores | Map | Runs | Memory (MiB) | Serialised (KiB) | Zstandard (KiB) | Step (ms) | Who wrote this (ms) |
|---|---|---|---|---|---|---|---|---|---|
| pages-20 (22) | 401 | 1 | per document | 579 | 0.05 | 11.8 | 2.6 | 0.027 / 0.053 / 0.649 | 0.013 / 0.146 |
| | | | per block | 703 | 0.08 | 15.1 | 4.7 | 0.024 / 0.109 / 1.001 | 0.001 / 0.164 |
| pages-100 (100) | 2,008 | 8 | per document | 2,821 | 0.24 | 59.7 | 12.5 | 0.024 / 0.057 / 4.980 | 0.014 / 0.031 |
| | | | per block | 3,341 | 0.38 | 73.8 | 21.7 | 0.023 / 0.101 / 2.194 | 0.001 / 0.002 |
| pages-300 (300) | 6,024 | 24 | per document | 8,390 | 0.71 | 181.6 | 38.0 | 0.020 / 0.044 / 1.906 | 0.019 / 0.042 |
| | | | per block | 10,015 | 1.13 | 225.8 | 64.2 | 0.012 / 0.083 / 3.832 | 0.001 / 0.003 |
| pages-1000 (1,001) | 20,080 | 80 | per document | 27,629 | 2.34 | 613.6 | 129.2 | 0.027 / 0.070 / 7.362 | 0.049 / 0.095 |
| | | | per block | 33,007 | 3.74 | 759.9 | 217.8 | 0.018 / 0.125 / 10.757 | 0.001 / 0.002 |

The maxima are single steps and include collection pauses; the medians and percentiles are the comparable figures.

**Recommendation.** Keep one map per document, as built. The per-block map has about a fifth more runs (every run is cut at block edges), 1.6 times the memory and 1.7 times the compressed checkpoint size at 1,000 pages, and a higher 95th percentile per step at every size, for a slightly lower median. It wins on "who wrote this" for one region, which the document map already answers in a twentieth of a millisecond at 1,000 pages. A map of 27,629 runs is 129 KiB compressed in a checkpoint; no limit is needed at these sizes. Revisit if a document's map passes about a million runs, for example a document edited for years without restores, where the walk over chunk sizes grows with it: a tree of chunk sizes would bound that walk without storing the map per block.

## What the service and the shell must do

- The room host keeps an `AttributionMap` next to each room, applies every durable commit with `applyCommit` (with the plan's hint for a restore commit), saves `toJSON()` in each checkpoint's side file, writes a checkpoint after each region-restore commit, and loads `fromJSON` from the nearest checkpoint (BE-020; HIS-014 criterion 4).
- `/diff` calls `compare` in a worker with `contentAt`, the commits, `attributionAt` and a `scopeIndex` over `commit_scopes`, the requester's gate and `hiddenAcross`, and a `ComparisonCache` per room host.
- `/history` calls `listHistory` with the commit metadata (from `commit_scopes` for `region` and `field` filters), the stored versions, the gate, the hidden set, the tenant's or user's time zone and a `scopeExists` over `commit_scopes`.
- `/restore` calls `planRestore` with the head, `contentAt(toSeq)` and the maps, the requester's access, region states, leases and the workflow flag. For a real restore it records `pre-restore`, applies the plan through `Room.author` (steps) or writes the checkpoint and calls `Room.snapshot` (snapshot) with the plan's preconditions, then records `restore` and raises `version.restored` (HIS-018, HIS-019). For `dryRun` it returns `plan.dryRun` only: never `plan.result`, which is the full document.
- `/attribution`, old versions, field history and fork content use `attributionFor`, `versionFor`, `fieldHistory` and `forkContent`.
- The operator runs `docedit-verify-log` on an exported bundle (HIS-037 produces it).
- The shell renders comparisons, groups and labels from these results with its own strings (HIS-009, HIS-013, HIS-015).

## Consequences

Good:

- One implementation of every history computation for the service, a local backend and the conformance kit, with the read restrictions built in.
- Comparisons and attribution never see hidden content: they work on projections, and canary property tests check every surface.

Bad:

- New change kinds (`moved`, `definition`), new fields (`path`, `region`, `marks`, `hidden`, `method`) and optional `user` and `seq` on spans need PRO to update `spec/dep`.
- The room host has one more structure to keep and checkpoint, and restores need a checkpoint after them.
- Grouping rules and the day's time zone are readings of the spec until the owner confirms them.

## Alternatives considered

| Alternative | Why not |
|---|---|
| The functions in `authority` | `authority` is the commit path (rebase, apply, check); history reads the log after it. A package of its own keeps the room's dependency surface small and avoids a cycle when history needs the projections |
| The functions in `services/document-service` | Not universal: the local backend and the browser could not use them |
| `packages/history-cli` for the tool (PLAN-1b) | A package for one script; the tool shares the chain code with the service |
| The attribution map per block | Measured above: larger and no faster except for one region's lookup |
| Grouping by consecutive authors | Two people writing at once would give one group per commit |
| A restore that also restores the region's title and policy | The title needs `structure` and the policy `manage`; a region restore needs only `edit` (07 §12) |

## Proposed amendments, once accepted

- 08 §6: the kinds `moved` and `definition`; `user` and `seq` optional on spans and on `formatted`; `path` and `marks`.
- 08 §4: the readings of section 4 (authors in the idle window, origin classes, the caller's time zone).
- 08 §7: a checkpoint after each region-restore commit; 06 §4.1: the `versions` row of a restore records `toSeq` (for example a column `restored_from`), so that a whole replay can reproduce restored runs.
- 08 §8: the order and codes of section 5, and that a region restore leaves the region's title and policy.
- 05 `DiffChange` and `DiffSpan`: as for 08 §6; `HistoryGroup`, `Attribution`, `RestoreResult`: the shapes of this package.

## Revisit when

The owner rules on SR-M29 (several commits or `too_large` for a large region restore), PRM decides who sees control commits in the list, PRO changes the DEP shapes, or a document's map passes about a million runs.
