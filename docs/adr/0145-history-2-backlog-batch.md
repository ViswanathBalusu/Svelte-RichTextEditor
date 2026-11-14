# 0145. History backlog batch 2: open points from the history packet

**Status:** proposed (2026-11-13). Written by the history-2 developer in backlog round 1, for `packages/history` stories HIS-039 and HIS-045. Not reviewed by the owner. Nothing here is decided for the owner.

## Context

Stories HIS-039 (purge plan), HIS-045 (old packages) and HIS-046 (projection) were taken from the end of the history slice. HIS-046 and HIS-039 are ticked where the package can show the criterion; the decision in HIS-045 is the owner's, so its criteria stay unticked. This note records what the code and the spec say, and the default the code takes, so that the owner can decide.

## 1. How long old packages stay runnable (HIS-045; open in 08 §15)

**Facts from the spec (03 §11.3, 08 §3 and §11, 08 §15):**

- A migration is a pure function from version n to n+1, recorded as a snapshot commit with origin `migration`, with a checkpoint on each side.
- Every commit should record the schema version and the engine version it was made with. Reading history older than a migration uses the checkpoint before it and the matching older model package, which "stays published".
- The policy for how long old packages stay runnable is open (08 §15).

**Facts from the code:**

- `chain.ts` takes the CDM schema as an argument (`schema?: Schema`, "without it no replay runs"). The verifier does not choose a package; the caller does. So the code can replay with any package it is given, and nothing in the package says which one.
- The bundle metadata has an `engine` string (`chain.ts`). The per-commit metadata type `CommitMeta` (`src/types.ts`) has no schema version and no engine version. So the rule of 03 §11.3 that every commit records both is not reflected in the type this package reads. This is a gap to record, not to fix here: the field belongs in the commit record of 06 §4.1, which the service writes.
- `thinning.ts` never removes a checkpoint that borders a snapshot commit (`bordersSnapshot`). That protects the checkpoint on each side of a migration from thinning (HIS-030).

**Answer to criterion 1 of HIS-045, from the spec alone:** a replay needs the old package back to the checkpoint before the last migration that the requested version depends on. A replay of a version after the last migration starts at the checkpoint after it and needs only the current package, provided that checkpoint exists. The spec does not state that this holds for every version, because checkpoints are written by the service's policy (BE-020) and can be missing.

**Options (the spec's list, HIS-045 criterion 2), with the cost each one carries:**

- (a) Keep old packages runnable for a fixed window. The cost is the size and the build of every retained model package, for as long as the window lasts. The window is a number the owner has not given.
- (b) Convert old payloads at migration time. The cost is a rewrite of the log or of its payloads at each migration, which the hash chain (08 §2) must then cover again, so the migration would change recorded hashes. This conflicts with the append-only log and is not recommended by this note.
- (c) Limit comparison and restore to versions after the last migration. The cost is that older versions can be viewed (HIS-010) but not compared or restored across the migration. The spec does not say whether that is acceptable to users.

**Default in code:** none. The code runs any replay with the package it is given. Nothing refuses a version older than a migration.

**Question for the owner:** choose (a), (b) or (c), or a window for (a). Until then HIS-045 criteria 1 to 4 stay unticked, and HIS-005, HIS-011 and HIS-012 are not updated.

## 2. The support window for components and service nodes (HIS-045 criterion 3)

03 §11.3 says the service supports versions n and n-1 side by side for a published window. It does not say whether the history window (how far back old packages are kept) is the same window. Default in this note: not the same, because (a) is not chosen. Question: the owner states whether the two windows are the same.

## 3. Retention between soft delete and purge (HIS-039; open in 08 §13)

`purgePlan` (`src/purge.ts`) takes `retentionMs` from the caller and checks only that it is a whole, non-negative number of milliseconds. Default in code: none; the spec does not give the period. Question: the owner or the operator gives the period. The plan's tests use a placeholder period of thirty days in the test file only, to exercise the rule; no product value is implied.

## Consequences

- HIS-045 is open until the owner chooses. Its Notes name this note.
- HIS-039 criteria 2 and 5 are ticked at the plan level. The deletion, the backup documentation and the audit write stay in the service.
- HIS-046 criteria 1 to 4 are ticked. Criterion 5 (negative tests on every endpoint) waits for the route table of HIS-026.

## 4. Round 2: HIS-038 and HIS-042 (lane history-2, 2026-11-13)

**HIS-038 criterion 3 (chain after erasure): ticked.** The chain covers the surrogate identifier, and the erasure deletes only the mapping from `sub` to the surrogate, which the verifier does not take as input. The test shows the same bundle verifies before and after, byte for byte (`test/erasure-chain.test.ts`). Criteria 1, 2, 4, 5 and 6 stay open: the row deletions, the scan of the service for the `sub`, the documentation and the audit are the service's, and the history list and the comparison do not yet apply `shownAuthor`.

**HIS-042 (suggestion decisions): no criterion ticked.** The package now has the identifier index and the date from the introducing commit (`src/suggestions.ts`), tested in `test/suggestions.test.ts`. Open points for the owner:

- Default in code: the index keeps the lowest `seq` when one identifier appears in several commits. The spec does not say which commit wins.
- The index is not in 06 §4.1. The service needs a table from suggestion identifier to `seq`, or a column on the per-scope table. The owner chooses the shape; the code takes no decision here.
- The origin names `suggestion.accept` and `suggestion.reject` are from 08 §14; the origin of a suggestion's introduction is not named in the spec, so the code does not check it.

**HIS-041 (key destruction): not taken.** No criterion can be met inside `packages/history`: the encryption of commits and the key service belong to the service and to the key management stories (SEC-056, SEC-057).

Status of this section: proposed, not reviewed by the owner.

## 5. Round 3: HIS-032 and HIS-034 (lane history-2, 2026-11-13)

**HIS-032 (thinning payloads): criteria 1, 2, 3 and 5 ticked on the plan** (`src/payload-thinning.ts`, `test/payload-thinning.test.ts`). The scheduler and its rows are the service's. Decisions in the code, each one the spec's or the story's wording, none chosen silently:

- The pinned version kinds are `named`, `export`, `sent` and `completed`, as HIS-032 criterion 2 names them. `pre-restore`, `restore` and `import` are not pinned, because the story does not name them. Default in code: not pinned. Question: the owner says whether they are.
- A pinned version keeps the payloads after its nearest checkpoint at or before it, up to it. This is the rebuild data, not the whole log.
- A snapshot commit's payload is always kept, because a replay stops at a snapshot and its content is what follows.
- The period is passed in by the caller (`periodMs`). Default in code: none. Question: the owner or the operator gives the period; the tests use a placeholder of thirty days in the test file only.
- The response for a thinned range is `payloadOf`'s `not_found` with a fixed reason. The spec names no code for it (HIS-032 notes, open). Question: the owner chooses the code the API returns (`not_found` or a dedicated one in the DEP registry).

**HIS-034 criterion 5 ticked** on the verifier of HIS-033 (`test/chain.test.ts`). Criteria 1 to 4 (the webhook and its debounce, the export manifest, the durable-commit rule) are the service's and stay open.

**Not taken in round 3:** HIS-037 (range export). Its range and anchor parts need HIS-036 (anchors in write-once storage), which is not built, and its hidden-commit rule needs a decision: whether a commit the caller cannot see is shown as a metadata row, a hash only, or left out. The chain cannot verify an outside reader across a left-out row. That is for the owner, and no criterion is ticked.

Status of this section: proposed, not reviewed by the owner.

## 6. Round 4: HIS-037 and HIS-035 (lane history-2, 2026-11-13)

**HIS-037 (audit segment): criteria 1 and 2 ticked.** `src/audit-segment.ts` builds the segment of a range (metadata rows, payload hashes, the anchors inside the range, and the verification steps) and verifies it alone through `verifyBundle`, started at the segment's first `seq` (the new `firstSeq` option of `src/chain.ts`). `scripts/verify-log.ts` accepts a segment file. Tests: `test/audit-segment.test.ts`. The route and the authorisation are the service's. Review fix (2026-11-13): the module is now exported from `src/index.ts`, so the service can call `auditSegment`; criterion 1 is ticked at library level only, and no service route calls it yet. Criteria 3 and 4 stay open. Decisions in the code, each one a default, none chosen for the owner:

- Records below the caller's gate are left out, with their metadata and payload hashes, and the segment starts at the gate. One hash from below the gate is still revealed: the first record held keeps its `prevHash`, the chain hash of the record at `from − 1`, because that record's own hash is computed over it and the segment cannot verify without it. The hash shows no metadata or text. A link-only form that hides it would need a different chain check; the owner decides whether revealing it is acceptable. Default in code: "left out", with that one link hash. The alternatives are a metadata row with its hashes only, or a hash only. The owner chooses.
- With that default, the link into the first record held is trusted only as far as an anchor covers it. The verifier reports no gap, and the segment is `intact` on its own.
- The metadata of an in-range commit still names its scopes, and a scope may be a hidden region. Removing them would change the hash the chain is checked against, so a segment cannot simply strip them. The code takes no decision; criterion 3 stays open until the owner chooses how such a commit is shown.
- A range ending below the gate is refused with `forbidden`, a range ending above the head with `not_found`, a range that starts after it ends with `validation_failed`.
- "Anchor records covering the range" is read as the anchors whose `seq` lies in the range. An anchor just before the range would also cover its link; the code does not include it. Default in code, for the owner to confirm.

**HIS-035 (anchoring period and granularity): decision not taken; no criterion ticked.** The facts and the cost formulas, for the owner:

- 08 §12 says "periodically". It gives no period, no unit and no maximum delay. The code has no default.
- Unit (a), per document: one signed, time-stamped head per document per period. Signatures and time-stamps per day is at most `documents / (period in days)`. At 1,000,000 documents, anchoring each document once a day gives 1,000,000 of each per day, about 11.6 per second on average; hourly gives 24,000,000 per day, about 278 per second on average. These are the arithmetic of the formula, not measurements, and they assume every document changes in every period, which lowers the real count.
- Unit (b), per tenant batch: a Merkle root over the heads of one tenant's documents that changed in the period, signed and time-stamped once. Signatures per day is `tenants / (period in days)`. The tenant count is not in the spec, so the figure cannot be stated. A relying party then needs the inclusion path, the signed root and the time-stamp to check one head (this is HIS-037's bundle plus one path).
- Maximum delay between a change and its anchor: the period plus the time the run takes. A missed run is covered by the next one (HIS-036 criterion 5).
- Proposal for the owner, not a decision: unit (b), because its signature count depends on tenants and periods, not on documents. The period is the owner's choice.

Status of this section: proposed, not reviewed by the owner.

## 7. Round 8: HIS-029 (lane history-2, 2026-11-13)

Written by the history-2 developer in backlog round 5. Proposed, not reviewed by the owner.

- Segment bounds: one segment per run of consecutive `seq` values that are all older than the period, so a segment never spans a `seq` that stays hot. The object name is `segments/{fromSeq}-{toSeq}.payloads.zst` (08 §11). A run is not split by size, because the spec gives no size limit; a limit is for the owner or operations to set.
- Segment text: the canonical JSON (RFC 8785 through `canonicalize`) of `{ format: "docedit-payload-segment/1", entries: [{ seq, payloadHash, payload }] }`. The format name is this package's choice; the spec does not name a segment format. The codec (zstd in the service) is an input, so the compression is not decided here.
- Order of a move: the object is written, read back, its payload hashes checked against the metadata, and only then are the payloads removed from the hot store. The index row for the segment must be written in the same transaction as the removal; the spec does not say this, so it is recorded here as the rule the service must follow.
- Legal hold: a hold does not stop a move (08 §11, HIS-029 criterion 6). The plan reports the hold so that the audit can show it was in force.
- Unavailable segments: a cold range that cannot be read answers `unavailable` with the sequence number that failed; hot-only ranges are not affected. The fixed status words are this package's (`unavailable`, `missing`, `mismatch`); the spec names only `unavailable`.

Status of this section: proposed, not reviewed by the owner.

## 8. Round 9: HIS-025 and HIS-031 (lane history-2, 2026-11-13)

Written by the history-2 developer in backlog round 9. Proposed, not reviewed by the owner.

- `since_access` boundary (HIS-025 criterion 4). The gate follows ADR 0034: the state current at the token's `access_since` is visible, which is the last commit stored at or before that time. HIS-025 criterion 4 says "from the first commit at or after that time". The two differ by one commit. Spec default in code: the gate's rule (ADR 0034), unchanged. Question for the owner: which one applies. Criterion 4 stays unticked until the owner decides.
- Legal hold (HIS-031 criteria 1 and 2). A hold in force stops the checkpoint thinning plan, the payload thinning plan and the purge plan. The three plans are checked together in `packages/history/test/legal-hold-plans.test.ts`. The soft delete that the purge waits on is recorded by the service; this package takes its time as an input.

Status of this section: proposed, not reviewed by the owner.
