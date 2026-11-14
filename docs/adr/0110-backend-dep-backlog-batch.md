# 0110. Backend-dep backlog batch: open questions from the DEP client packet

**Status:** proposed (2026-11-13). Written by the backend-dep developer in the backlog batch, round 1, for PRO-006, PRO-095 and PRO-096 in `packages/backend-dep`. Not reviewed by the owner.

## Context

PRO-006 criterion 5, PRO-095 and PRO-096 were checked against the tests in `packages/backend-dep`. Criteria whose tests exist are ticked with Evidence. Criteria that need a test server or code that does not exist yet, or whose wording the spec leaves open, stay unticked, and each reason is in the story's Notes. This note lists the points that need a decision, with the default the code takes.

## Open questions and the default taken

1. **`catchUp: "page"` and the `caughtUp` ordering (PRO-095 criteria 1 and 2).** `backend-mock` answers a resume with `stream` or `reload` only. No backend-dep test can make a server answer `page`, and no test checks that an in-flight commit reported `unknown` is resubmitted after `sync.caughtUp`. Default: both criteria stay unticked. The channel machine's rules are tested in `packages/protocol`. Question: whether `backend-mock` (or a test double in `packages/backend-dep/test/support`) should answer `page` when a resume is far behind; that is a test-support change in a package owned by another packet.

2. **Upload result (PRO-096 criterion 1).** The criterion says the upload "resolves its URL after `asset.ready`". The port contract (`packages/protocol/src/ports/optional.ts`, `AssetsPort.upload`) resolves `{ asset }`, the identifier, and the signed URL comes from `resolve()`. Default: the port contract. Question: should the port resolve the URL too, or should the criterion read "its identifier"? Owner decision; the story stays unticked until then.

3. **Export progress (PRO-096 criterion 2).** `exports.request` and `exports.get` work, and `cancel` works. Progress is not followed: no polling loop and no handling of `export.*` events reaches a terminal state. Default: unticked. Question: none for this package; the events are read through the notices that the events plane sends (`packages/backend-dep/src/files.ts`), so the work is a short addition once the export events have a test server.

4. **Fonts port absence (PRO-096 criterion 5).** The fonts port has no feature name (G06 in the spec), so `backend-dep` offers it whenever the backend is built. The criterion asks for the port to be absent when the server does not announce `fonts`. Default: the spec's G06 default (present). Question: owner decision. Either the criterion is reworded to exclude `fonts`, or G06 gains a feature name. The story stays unticked until then.

5. **Refusal of an unannounced feature (PRO-006 criterion 5).** Ticked. The document service now refuses the `ch.open` with `unsupported_feature` (`services/document-service/src/data-plane/session.ts`), and `packages/backend-dep/test/service.test.ts` runs the case without a skip. No open question remains.

## Round 2 (2026-11-13): PRO-014, PRO-019 and PRO-022

Written by the backend-dep developer, round 2. Still proposed; not reviewed by the owner.

6. **Virtual time in the lifecycle tests (PRO-014, PRO-019, PRO-022).** `test/support/virtual-time.ts` runs the backend's timers only when a test advances the clock, and logs every timer delay and jitter draw. The service clock (`advanceClock`) moves with it. Default: the tests check the schedule exactly. Question: none; this is test support in the package.

7. **The gateway in the ten-minute test (PRO-019 criterion 6).** No real gateway exists in the tree. The test cuts a socket after 100 s with no frame in either direction. Default: this is a simulation, and the story says so. Question: whether a real gateway test belongs in `services/document-service` or in the 1b conformance kit.

8. **Advertised commit limits (PRO-022 criterion 4).** `backend-dep` did not pass the advertised `maxCommitBytes` and `maxStepsPerCommit` to the channel, so the client built commits with the 04 defaults. Decision taken: `src/backend.ts` now calls `setLimits` on `welcome` and passes `limits` when a channel opens. The channel refuses a commit above either limit with `too_large` and sends nothing. The server half stays in `services/document-service/test/data-plane/sync.test.ts`.

9. **Heartbeat, ack timeout, chunk threshold and presence rate (PRO-022 criterion 3).** Already wired in `src/backend.ts` and `protocol/src/client/session.ts`. Tested by changing each value in the mock server. Question: none.

10. **Token refresh criteria left unticked (PRO-014 criteria 1, 3, 4, 5).** Criteria 1, 4 and 5 are the document service's and are covered by tests there (named in the story Evidence); they were not re-run in this packet. Criterion 3 (a refreshed token with another `tid`) has no test. Default: unticked, reasons in the story. Question for the owner: whether a `tid` change must close the session with 4401, or only be refused.

11. **`pagehide` (PRO-019 criterion 5).** Not built: `backend-dep` does not listen for `pagehide`. Default: unticked. The check is a browser test, to be written with the element's browser suite.

12. **Error codes (PRO-039) not picked this round.** Several criteria depend on the element (`de-auth-required`, `de-error`) or on the sync machine (SYN-017). Default: left for a later round.

## Round 3 (2026-11-13): PRO-018 and PRO-024

13. **Chunking on the wire (PRO-018 criteria 1, 2 and 5).** Default taken: the client's own chunker (`@docedit/protocol` codec, used by `backend-dep`) is tested end to end on the memory network, not in `packages/protocol`. `packages/backend-dep/test/chunks.property.test.ts` reads the outgoing frames and checks the fields of 05 §4, the concatenation and the code-point boundaries, with fast-check. Correction (round 3 review, fixed 2026-11-13): the first version of that test put a 1,200-character `x` prefix before about six random characters, so every chunk edge fell in the prefix and the code-point check could not fail. The generator is now 800 to 1,500 random code points with no prefix, and the test asserts that, over its 50 runs, some edge falls before a four-byte code point and a naive UTF-16 chunker divides a pair on the same submits; with the client's chunker replaced by that naive one (a temporary `vi.mock`, not kept), the lone-surrogate assertion failed on the first run. The codec's own property test (`packages/protocol/src/codec/codec.universal.test.ts`, "cuts only between code points") remains the primary evidence for criterion 2. The mock server does not reassemble, so no ack is awaited there. Criterion 5 is tested against the real document service (`test/service.test.ts`) with a 1,000,000-character insertion, below the 1 MiB `maxCommitBytes`. Question for the owner: none for this packet; the codec's own test stays in `packages/protocol` for the codec in isolation.
14. **Channel close and back-off (PRO-024 criterion 3, client half).** Ticked on the existing `channel-resume.universal.test.ts`: `unavailable` and `slow_consumer` lead to a resume after `retryInMs`. The case without `retryInMs` is not separately tested; the spec makes it optional. Default: unticked for the absent-field case is not required, the criterion says "when present".
15. **Left open in this round (not in backend-dep).** PRO-024 criterion 2 (`reason` on `ch.closed`) is a server assertion and stays unticked. PRO-028 criterion 5 (waiting `retryAfterMs` before a resubmit with the same `id`) belongs to the sync engine, because `backend-dep` only rejects the submit with `SyncRejectError`. PRO-043 criterion 1 and PRO-047 and PRO-050 need client methods that `backend-dep` does not expose through its ports (document create, state change and content replacement); no such port is in `@docedit/protocol/ports`, so nothing is added here. PRO-044 criteria 1, 2 and 4 are server and log checks, not client ones.

## Round 4 (2026-11-13): PRO-004, PRO-005 and PRO-006

Written by the backend-dep developer, round 4. Still proposed; not reviewed by the owner. No criterion was ticked in this round.

16. **Check of the packet's stories (PRO-004, PRO-005, PRO-006).** Every criterion of PRO-004 and PRO-005 is ticked, and each Evidence line names files that exist. `pnpm vitest run packages/backend-dep` (Node.js project, this round) passes 21 files and 404 tests, with 87 skipped. The skips are the browser projects (not run here) and the contract cases that report "no X port" for ports `backend-dep` does not build yet. PRO-006 criterion 2 (comparison of two artifact sets in CI) stays unticked: only one artifact set exists, and the CI job belongs to the main session (`.github/`). Question for the main session: none beyond that job.
17. **PRO-097 (history, comments, leases and imports ports) is blocked and not started.** The port typings exist in `packages/protocol/src/ports/optional.ts`, but `services/document-service` serves no thread, history, lease or import route (its routes are content, regions, grants, fonts, assets, exports and fields). A `backend-dep` implementation could only be tested against the test mock, which has no such routes, so a test would prove the client against itself. Default taken: nothing is written for PRO-097 this round, and its criteria stay unticked. Question for the owner: whether the phase 2 server routes come first (the spec's order) or whether `backend-dep` should add routes to the mock now. The spec default is the former.
18. **Other stories in the packet are complete or owned elsewhere.** PRO-093 and PRO-094 are fully ticked. PRO-098 criterion 2 (run the suite against `backend-dep` and the reference service) and PRO-090 criterion 4 are in `packages/tck` and `packages/element`, not in this packet.
