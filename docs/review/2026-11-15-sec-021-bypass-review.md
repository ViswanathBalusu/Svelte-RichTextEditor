# Security review of the permission bypass suite (SEC-021)

**Date:** 2026-11-15. **Reviewer:** the developer agent of lane w3, which did not write the suite or the generators. **Status:** a review by an agent, not by a person; the owner may ask for a second reading by a named security reviewer. Nothing here is an owner decision.

**Threat reviewed:** "Changing a part of a document without permission" (10 §3.3). Its control is the outcome check of 07 §5.1 with the rules of 07 §5.2. The attempts are the rows of 07 §16 that concern commits.

## How the review was done

- Read `tests/security/test/bypass-classes.test.ts` in full, and the fixture titles of `rebase-tricks.test.ts`, `sec-025-rebase-oracle.test.ts` and `corrupting-commits.test.ts`.
- Read the generator of crafted and ordinary commits, `packages/authority/test/harness/client.ts` (the step kinds and the crafted kinds), the outcome check (`packages/authority/src/permissions/outcome.ts`, the loop over changed scopes and the P2 block) and the move detection in `scopes.ts`.
- Compared the list with 07 §5.2 (P1 to P6) and 07 §16, wrote a fixture for each row that had none over the wire, and ran the file: `pnpm exec vitest run --project node tests/security/test/bypass-classes.test.ts`, Node.js on Windows 11, 2026-11-15, 20 passed on memory storage. The 20 PostgreSQL cases were skipped here because the shared test container was not running; the `integration` job of `.github/workflows/ci.yml` runs them.

## Fixtures that answer the threat

All in `tests/security/test/bypass-classes.test.ts`, over the wire against the real service, on memory and PostgreSQL storage.

| Bypass class (07 §5.2, §16) | Fixture title |
|---|---|
| Attribute step, empty position map | attr step with an empty position map on a restricted region is refused |
| Mark step, empty position map | mark step with an empty position map on a restricted region is refused |
| Node-mark step | a node-mark step on a restricted paragraph is refused (new) |
| Crafted `replaceAround` | a crafted replaceAround that restyles a restricted paragraph is refused; unwrapping a restricted region into the body with a replaceAround is refused (new) |
| Removing one region boundary (P3) | removing exactly one region boundary, the closing token, is refused (P3); a bare region token deleted on its own cannot apply and is refused |
| Inserting one region boundary (P3) | the unbalanced open, the unbalanced close and the bare unbalanced token fixtures |
| Deleting a whole restricted region (P2) | deleting a whole restricted region as a document editor is refused (P2) (new) |
| Moving a whole restricted region (P2) | moving a whole restricted region as a document editor is refused (P2) (new) |
| Flipping a region to `restricted` (P2, `manage`) | flipping a region to restricted without manage is refused (P2) (new) |
| Suggested deletion in a restricted region (P4) | a suggested deletion over the text of a restricted region is refused (P4) (new) |
| An allowed step hiding a forbidden one | a commit that mixes an allowed edit with a restricted one is refused whole (new) |
| Reusing a node identifier (I2, P5) | reusing a node identifier is refused (I2) |
| Re-creating a deleted region (I3) | re-creating a deleted region to inherit its grants is refused (I3) |
| `doc` and `defs` scopes | a change in the doc/defs scope without structure is refused |
| Viewers and commenters (P6) | viewers and commenters are refused any commit with permission_denied (P6) |
| The gate is specific | a normal edit by a document editor in the open body still succeeds |

Fixtures in neighbouring files that answer the same threat:

- Stale bases: `tests/security/test/rebase-tricks.test.ts`, "steps built on an old base that map into a protected region are refused once rebased" and "an accepted rebased commit stores the mapped steps, not the steps the client sent" (SEC-025).
- Wrapping content in a new region without `structure`: `tests/security/test/prm-057-row3-verdicts.test.ts`, "a filler cannot wrap body content in a new region".
- Step types outside the allow-list: `tests/security/test/corrupting-commits.test.ts`, "refuses step types outside the allow-list and malformed step JSON with invalid_op" (SEC-027; the list is `ALLOWED_STEP_TYPES` in `packages/authority/src/steps.ts`).
- The rows of 07 §16 against the room, in process: `packages/authority/test/threats.test.ts`, rows 1 to 6, 9 and 13.

## Generators and oracle

- **Generator of commits:** `packages/authority/test/harness/client.ts`. Ordinary clients produce every step type on the allow-list (`replace`, `replaceAround` through `setNodeMarkup`, `attr`, `addMark`, `removeMark`, `addNodeMark`, `removeNodeMark`). Malicious clients send crafted commits: an insert into the restricted region, a forged suggestion, a changed identifier or policy, a `replaceAround` that unwraps a region, a mark over the whole document, a base ahead of or far behind the head, a replayed commit identifier, a node mark in another user's name, and a mark removal over the whole document.
- **Generator of schedules:** `packages/authority/test/harness/ops.ts` orders edits, crafted sends, crashes and permission changes. It is not a generator of steps; the draft register of 2026-11-13 named it as one.
- **Oracle:** `packages/authority/test/harness/oracle.ts` serialises every scope and fails the run if an accepted commit changed a scope outside the submitter's writable set (PRM-017).
- **Where they run:** `packages/authority/test/convergence.property.test.ts`, and `services/document-service/test/postgres/convergence.pg.test.ts` against PostgreSQL (SYN-047). `tests/security/test/sec-025-rebase-oracle.test.ts` runs random commits, direct and rebased, against the same oracle. `packages/authority/test/scopes.test.ts`, "fuzzing the outcome check", and `packages/authority/test/fuzz.test.ts` check that the check always returns a verdict.

## Gaps

No bypass class named in SEC-021 criterion 1 or in the commit rows of 07 §16 is without a fixture after this review. What remains:

1. **A restricted region swapped with one neighbouring block.** Cutting the restricted region and pasting it on the other side of one paragraph the editor may move is accepted. The stored document is the same as if the editor had moved that paragraph, which is allowed, and an outcome check cannot tell the two apart. The move detection (`scopes.ts`, longest common subsequence of the body's children) names the paragraph as the moved block. This is consistent with 07 §5.1, but 07 §16 says a document-level editor cannot "move a whole restricted region" without qualification. Not a fixture gap: a question for PRM and the owner on the wording of that row. The new move fixture moves the region past two blocks, where the region is the moved block, and it is refused.
2. **Two restricted regions.** The fixture document has one restricted region. Moving a restricted region relative to another restricted region has no fixture over the wire.
3. **Fill-only participants and the suggestion baseline.** P7 to P9 and the full P4 baseline are SEC-022 and SEC-023; this suite has one P4 fixture only.
4. **Write paths other than `sync.submit`.** Restore, import and form filling were not examined in this review. They are other rows of the register and other stories.
5. **PostgreSQL not run here.** The seven new fixtures passed on memory storage only in this session.

## Findings and owners

| Finding | Owner | Disposition |
|---|---|---|
| Seven rows of 07 §16 had no fixture over the wire | SEC (lane w3) | Fixed in this review: seven fixtures added |
| The draft register named `ops.ts` as the step generator | SEC | Corrected above |
| Gap 1, the wording of 07 §16 row 4 | PRM, owner | Open question |
| Gap 2, a second restricted region in the fixture document | SEC | Open; a later round of SEC-021 |
| Gap 5, the PostgreSQL run of the new fixtures | integrator | Runs in the CI integration job |
