# ADR 0107: Conformance kit backlog batch (round 1)

**Status:** proposed, 2026-11-13. Records the decisions that the kit's stories needed in round 1 of the backlog run (PRO-098, PRO-108, PRO-110, PRO-111, PRO-114, PRO-116, PRO-131, FRW-065 to FRW-067). The project owner has not reviewed it. Nothing here amends 05 or 11.

## Context

The kit (`packages/tck`) runs black-box profiles against any DEP server. Most open criteria of these stories wait for something outside the package: a server that announces `assets`, `read-restrictions` or `fields`, a `backend-local`, a webhook feature, or the workflow actions of G95. Round 1 changed the kit in three places and left the rest open.

## Decisions

### 1. Identity-blind engine fixtures (PRO-110 criterion 5, `semantics.steps`)

The engine fixtures (`packages/authority/fixtures/engine/golden/apply.json`) apply steps without a user. The server applies 03 §5, so a suggestion mark (`ins` or `del`) that does not name the submitter is refused with `permission_denied`. For apply-002 the kit now accepts exactly that refusal: the code must be `permission_denied`, the message must be the 03 §5 message, and the steps must contain a suggestion mark. Any other refusal still fails. The count of such refusals is reported apart from the others.

Default taken: the kit does not change the fixture, and does not submit the mark with the submitter's identity, because that would change the fixture's canonical hash.

### 2. A room refusal the pure engine does not make (`semantics.steps`, apply-020)

apply-020 removes one boundary of a region (P3). The pure engine applies it (`applySteps` in `packages/authority/src/rebase.ts`), but the room refuses it with `invalid_op` ("step 2 removes one boundary of region ... (P3)"). The mock backend and the reference service both do this. The spec does not say which layer owns P3 at step level. This is an open question for the authority (SYN-002), not decided here. Until it is answered, `semantics.steps` is a known failure of the mock and of the reference service, listed in `packages/tck/test/mock.test.ts` and `packages/tck/test/reference.test.ts` with the case.

### 3. Known-defect lists shrink with the service

Thirteen entries of `REFERENCE_KNOWN` passed in the round-1 run (among them `core.sync.ack`, `core.sync.reset`, `core.rest.idempotency`, `fields.announce` and `fields.prefill`) and were removed, as the kit's design asks. A regression in one of them now fails the run.

### 4. The intermittent `perm-region.property` failure was a kit defect

`perm-region.property` failed once on the reference service with a random seed, and the report showed only fast-check's wrapper. The kit now reports the inner failure whole, with fast-check's replay parameters (`{ seed, path, endOnFailure }`; `propertyFailure` in `packages/tck/src/profiles/perm.ts`). With that, property seed 3 (8 runs) reproduced it: an owner with no grants submits an `across` delete from the intro to the middle paragraph, the service accepts it, the oracle agrees, and the open region is gone. The next operation names the open paragraph, and `buildSteps` threw "no node pOpen00000000001 in the document". The service did nothing wrong. `buildSteps` now skips an operation whose node an earlier accepted commit removed. Regression tests: `packages/tck/test/perm-property.test.ts`, and a fixed-seed run in `packages/tck/test/reference.test.ts`. After the fix, seeds 1 to 30 and 100 to 499 at 25 runs each (10,750 property runs, a scratch loop over `runKit` against a local reference service, 2026-11-13) all passed: no accepted commit outside the writable set was found.

## Open

- The map and rebase engine fixtures are replayed by `packages/authority/test/engine.test.ts`, not by the kit. The kit has no `prosemirror-transform` dependency, and no server operation exists for map or rebase. Adding the dependency needs `scripts/pnpm-locked.ps1` and the main session's approval.
- `read-restrictions`, `assets`, `fields` and webhooks have no server that announces them, so their profiles have not run against a real target.
