# ADR 0112: Protocol backlog batch (PRO-004, PRO-022, PRO-028)

Status: proposed (2026-11-13, backlog round 1 for `packages/protocol`)

## Context

`packages/protocol` owns the DEP types, codecs and client state machines. Three of its stories had
criteria that could be met inside the package: PRO-004 (the codec round trip), PRO-022 (the limits a
client must respect) and PRO-028 (the client's handling of `sync.reject`). The rest of each story
belongs to the server, `backend-dep`, or the conformance kit.

## What this batch did

- PRO-004 criterion 3 is ticked. `packages/protocol/test/golden.test.ts` round-trips every valid frame of
  the PRO-110 message fixtures through `depCodec()` and refuses every invalid one. The conversation fixture
  is not round-tripped: it is a scenario with `$` placeholders.
- PRO-028 criterion 6 is ticked. `ClientChannel` ignores a `sync.reject` whose `re` it does not own.
- PRO-022 criterion 4 gains its client half. `ClientChannel` refuses to build a commit above
  `maxCommitBytes` or `maxStepsPerCommit`, and answers with a local `too_large` failure. The story stays
  unticked until `backend-dep` passes the advertised limits in with `setLimits`.

## Decisions taken to build this (proposed, for the owner to confirm)

1. **Size of a commit.** The spec says "serialised commit" (04 §3.1) without a format. The guard measures
   `JSON.stringify(commit)` in UTF-8 bytes, which is the form the codec sends in `d`. The 04 defaults
   apply (1 MiB, 500 steps) until a caller sets the advertised limits. Spec default used; no owner decision
   taken.
2. **Local refusal before sending.** A commit above the limits is refused on the client, not sent to be
   answered with `too_large`. The story's wording ("a client never builds such a commit") asks for this.
   The server still answers `too_large` for a commit that reaches it.
3. **Unknown `re`.** A `sync.reject` whose `re` matches no submit is ignored, as PRO-028 criterion 6 says.

## Criteria that stay open, and why

| Story | Criterion | Reason |
|---|---|---|
| PRO-022 | 3: `backend-dep` uses the advertised heartbeat, ack timeout, chunk threshold and presence rate | `backend-dep` (packet B) |
| PRO-022 | 4: a client never builds an oversize commit | Local guard built; needs `backend-dep` to call `setLimits` from `welcome`. Server half is in `services/document-service` (`sync.test.ts`). |
| PRO-028 | 4: `field_invalid` names the failed rule | Server rules (FRW-025, FRW-060, FRW-065) |
| PRO-028 | 5: wait `retryAfterMs` before resubmitting with the same `id` | The caller resubmits; `ClientChannel` only returns the reject |
| PRO-037 | 3, 4: each trigger gives its close code | Needs the server and the kit. `classifyClose` maps the nine codes; it does not trigger them |
| PRO-031 | 7: no `presence.update` without the feature | `ClientChannel` has no presence sender; the sender belongs to `backend-dep` |
| PRO-032 | 1, 2: browser refusal of edits; unknown field in `access` ignored | Browser test is in the UI. `sameAccess` compares the whole object, so an unknown member counts as a change. Whether that is "ignored" is open (see below). |
| PRO-039 | 4, 5, 6, 7 | `backend-dep` and the UI. `internal` closes the channel with its code and is not treated as a back-off case. |
| PRO-092 | 4, 5 | UI (`hasPort()` answer is built) and the contract suite (PRO-098) |

## Open question (not decided here)

`PRO-032` criterion 2 says an unknown field in `access` is "ignored (PRO-005)". Today the channel passes
unknown members through, and `sameAccess` treats a change in an unknown member as a new `access`. Either
reading may be right. Owner or spec decision needed: should an unknown member count toward "the same
access"? Not changed here.

## Batch 2 (2026-11-13, packet D: protocol definition stories)

Packet D worked on PRO-038, PRO-028 and PRO-130. No criterion was ticked in this packet, because each
open criterion needs something outside `packages/protocol` or a decision the spec does not make.

### What was built

- `packages/protocol/src/codec/problem.ts`: `checkProblem`, a conformance check for one problem. It
  refuses a code outside the registry, a code on a surface its registry entry does not name, a
  `ch.rejected` code outside its list, a missing retry hint on `rate_limited` and `quota_exceeded`
  (`retryAfterMs` on the socket and `sync.reject`, `Retry-After` on REST), and a `field_invalid` on
  `sync.reject` without a `rule`.
- `packages/protocol/src/codec/problem.universal.test.ts`: 15 tests, with a fast-check property over
  codes outside the registry. They also check the wire through `depCodec().check` and `ShapeValidator`.
  All 15 pass on the Node.js project.

### Decisions taken (proposed; spec defaults used)

1. The retry hint rule for `quota_exceeded` on REST is `Retry-After`, as PRO-038 criterion 3 says. The
   registry gives it `httpStatus` 429 and no separate rule.
2. `checkProblem` does not check `ch.closed` or `error` for retry hints. Their registry surfaces include
   `rate_limited` and `quota_exceeded`, but the story names only the socket and REST.
3. A `retryAfterMs` of 0 is accepted. Negative or non-integer values are refused.

### Criteria that stay open, and why

| Story | Criterion | Reason |
|---|---|---|
| PRO-038 | 2: the kit fails any response with a code outside the registry | The kit is not built. The check it will call exists. |
| PRO-038 | 3: `rate_limited` and `quota_exceeded` carry the hint | No server route is checked with `checkProblem`, and no route returns these codes yet (packet A2). |
| PRO-028 | 4: `field_invalid` names the rule | The check exists. No FRW rule produces `rule` yet (FRW-025, FRW-060, FRW-065). |
| PRO-028 | 5: wait `retryAfterMs` before resubmitting the same commit with the same `id` | Open decision (below). |
| PRO-130 | 5: the prose of 05 agrees with the definitions | `docs/spec/05-protocol.md` has none of `access_changed`, the view token or empty `steps`. The spec edit is outside this package. |

### Open decision for the owner (not decided here)

PRO-028 criterion 5 assumes that the client resubmits a rejected commit. `ClientChannel` does not. It
reports `kind: 'reject'` and the caller decides. A channel-side retry with the same envelope identifier
would also need a policy for how many times to retry and when to stop, and 04 §8 does not give one. The
spec default is the caller's retry, so nothing changed. Owner or spec decision needed: who resubmits a
`retry` rejection, and with which bound.

### Existing failures seen in this packet (not caused by it)

`pnpm vitest run packages/protocol --project node` shows four failures that predate this packet:
`test/artifacts.test.ts` (`spec/dep/dep-1.gaps.json` is stale against a fresh generation, and the gap
list has two fewer entries than the definition), and `test/report.test.ts` (the S6 report lacks rows for
G120 and D120). They come from definition or report changes made elsewhere. The packet did not run
`pnpm --filter @docedit/protocol generate` because that rewrites `spec/dep`, which the owner of the
definition should regenerate. The owner should run it.

## Batch 3 (2026-11-13, round 1: protocol definition stories PRO-006, PRO-008)

Status: proposed. Stories looked at: PRO-002, PRO-006, PRO-008, PRO-022, PRO-028, PRO-037, PRO-038, PRO-049, PRO-082, PRO-092, PRO-110, PRO-116, PRO-130, PRO-131. Most of their open criteria need the conformance kit, a server route, the user interface, FRW rules or a CI job. Those stay open with a reason in each story's Notes.

### What this batch did

- PRO-008 criterion 4 is ticked. Server half: `pm-steps/1` in `engines` (existing document-service test). Client half: a new test in `packages/protocol/src/client/negotiate.universal.test.ts` shows that `checkDiscovery` accepts an unknown announced feature and `negotiateFeatures` drops it.
- PRO-006 criterion 2 gains its check. `compatibilityProblems` in `packages/protocol/src/generate/compat.ts` reports every removal or change of a contract field between two artifact sets of one major version, and every new required member. Tests are in `packages/protocol/test/compat.test.ts` (eleven cases, one property test). The criterion itself stays open: it asks for the comparison in CI, and the CI job belongs to the main session (`.github/`).

### Decisions taken to build the compatibility check (proposed; spec default, owner to confirm)

1. **Scope of "adds only".** 05 §1 rule 2 names additions but does not say what counts as a change. The check treats as a change: a removed entry, a changed contract field of a registry row (direction, channelScoped, id, re, method, path, security, ifMatch, idempotencyKey, success, surfaces, retryable, closeCode, relayForbidden, port, resource), a changed or removed property, a member that becomes required or stops being required, a removed response code, a changed request body, a removed or changed parameter, a new required parameter, and a different major version. Adding a surface to an error or a response code is therefore a break here, which is stricter than the rule needs. Owner may relax it.
2. **Prose ignored.** `title`, `description`, `$comment`, `summary`, `example` and `examples` do not count.
3. **Parameters by reference.** A `$ref` to a component parameter is resolved in the later document, so its `required` flag is read.

### Criteria that stay open, and why (round 1)

- PRO-002 criteria 1 and 3: the routes of FRW-025, FRW-060 and FRW-065 do not exist, and the matrix of PRM-056 is not built.
- PRO-028 criterion 4: `rule` needs FRW rules; criterion 5 stays open by the earlier decision (no client retry policy in the spec).
- PRO-037 criteria 3 and 4: triggered by the server and the kit; the mapping from fatal codes to close codes is still open (gap 16).
- PRO-038 criteria 2 and 3: the kit must fail out-of-registry codes, and no route returns `rate_limited` or `quota_exceeded` yet.
- PRO-049 criteria 4 and 5: `seq` gating is the server's. The client refusal of an unknown `requires` belongs to the element's open path, not to this package.
- PRO-082 criteria 1 to 3 are user interface and UX-050 work. Criterion 4 needs an `extensions` property in the typings, which UX owns; it is not added here.
- PRO-092 criterion 5 waits for PRO-098. Criterion 4 needs the user interface.
- PRO-110 criterion 5 and PRO-116 criterion 4 need the kit to pass fully (apply-020 still fails, ADR 0107 section 2) and a one-hour fuzz run.
- PRO-130 criteria 4 and 5 need the `hidden_region` placeholder in the CDM schema and the prose of 05 to describe `access_changed`; neither is in this package.
- PRO-131 criteria 1 to 3 need a server that announces read restrictions.

### Failing tests seen during this round, not caused by this batch

`packages/protocol/test/artifacts.test.ts` ("match a fresh generation", "list every gap and decision") and `packages/protocol/test/report.test.ts` (gap and decision rows) fail because `spec/dep/dep-1.gaps.json` differs from a fresh generation: the gap register (`packages/protocol/src/definition/gaps.ts`) changed outside this batch: the fresh generation holds gap G103 and the committed `spec/dep/dep-1.gaps.json` does not. The artifacts need regenerating (`pnpm --filter @docedit/protocol generate`) by the owner of the register. This batch did not edit the definition or the spec artifacts.
