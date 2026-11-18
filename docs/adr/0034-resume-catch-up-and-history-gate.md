# ADR 0034: How a resuming channel catches up, and the shape of the history visibility gate

**Status:** accepted, 2026-11-18 (owner decisions 140, 166 and 202 of `docs/owner-decisions-2026-11-15.md`, and the bulk acceptance of decisions 196 to 220), with item 3 of section 1 corrected by decision 202: beyond the limits the answer is `reload`, never `page`. Proposed 2026-11-06. Decision stories SYN-026 and HIS-023. It also records three choices the specification leaves open that the same work needed: the code for a server-authored commit whose preconditions no longer hold, the rule evaluation budget of a commit, and how a snapshot commit is written. Nothing here amends 04, 05, 07 or 08 yet; the proposed amendments are at the end.

## Context

04 §9 lets a resuming client stream the commits it missed, page through them over REST, or reload, but leaves to the server which one it gets beyond the catch-up limits, and says nothing about what a reader under read restrictions (ADR 0019) may stream. 07 §8 names one function, `minVisibleSeq(user)`, while 08 §9 says that under the default setting `editors` everyone without `edit` sees named versions only, which is a set of versions rather than a threshold. HIS-023 asks for the exact shape before the gate is built.

The resume point is the client's claim. The server keeps no record of which states a session was attached for, and a malicious client can claim any `seq`.

## Decision

### 1. Catch-up (SYN-026)

The room answers `ch.opened` with `head`, `incarnation`, `inflight` and `catchUp`, decided in this order:

1. `reload` when there is no `resume`, the incarnation differs, `resume.seq` is not a sequence number from 0 to the head, `resume.seq` is below the first commit the room holds (a room started from a checkpoint), `resume.seq` is below the user's visibility gate (section 2), or a snapshot commit lies after `resume.seq`.
2. `stream` when the missing commits are within both catch-up limits (`catchUpCommits`, default 5,000, and `catchUpBytes`, default 5 MiB, measured as the serialised size of the stored commits): the commits from `resume.seq + 1` to the head, then `sync.caughtUp`, then live commits.
3. Beyond the limits, `reload` (corrected by owner decision 202; the first version answered `page` when the host served `GET /documents/{id}/commits` and `reload` otherwise). The value `page` stays in the schema and the server does not send it.
4. Behind the projection gateway (ADR 0019) the reload carries the reader's projection.

`inflight` is present whenever `resume.inflight` was sent, on a reload too (S6 decision D08). It is `accepted` with the stored `seq` only for the caller's own stored commit, and `unknown` otherwise, including a commit that is still waiting to be stored: a resubmission with the same `id` attaches to the pending acknowledgement (04 §5 step 2), so `unknown` is safe.

### 2. The visibility gate (HIS-023)

The gate is a number per user and moment, `minVisibleSeq(user)`, the lowest sequence number whose content the user may read. Two rules are built on it:

- **A single state** (content at a `seq`, a version, one side of a comparison) is visible at or above the gate, at the head, and at a named version. The head is never blocked.
- **A run of commits** after a `seq` (`resume.seq`, `after`, `fromSeq`) may be sent only when that `seq` is at or above the gate, because the commits reveal every state between it and the head. Named versions do not open runs.

The settings of 08 §9:

| Setting | `minVisibleSeq(user)` |
|---|---|
| `editors` (default) | 0 for a user who holds `edit` somewhere in the document through their role or a grant; otherwise the head |
| `all` | 0 |
| `since_access` | The last commit stored at or before the token's `access_since` claim, so that the state current at that moment is visible. Without the claim, the head: the gate fails closed, for editors too |

"`edit` somewhere" counts the role and matching grants only, not the temporary limits of 07 §4: a lock, an approval or a lease does not take history away from an editor.

**A viewer who resumes after a short disconnect** under `editors` reloads, unless they resume at the head. The server cannot tell whether the client really held the state it claims, and a reload reveals only the head. Viewers have no unconfirmed work; suggesters and fillers re-apply theirs to the reloaded content, as on a reset.

**A named version** discloses its own content, the attribution map at its `seq`, and a comparison with another visible state. The comparison is computed from the two states (block alignment, 08 §6, second method), never from the commits between them, so that no intermediate commit's author, time or text appears.

**Settings.** A document's setting wins over the tenant's; the tenant's is the default for documents without one; without either, `editors`. Only tenant administrators change either (08 §9: "the tenant chooses"), through the administration API (13 §10). A change applies at once to every request, history already written included: the gate is evaluated when a request arrives, so nothing is rewritten, and nothing already delivered is recalled.

### 3. Choices the specification leaves open

- **A server-authored commit whose preconditions no longer hold** (04 §5, closing paragraph) is refused with `conflict` and action `drop`: the state it was authorised under has changed, and the control plane must decide again rather than retry.
- **The rule evaluation budget of a commit** is 100,000 steps of `@docedit/rules` (`RoomInit.ruleBudget`). It is about thirteen times the 7,675 steps measured for evaluating every field of a synthetic document at the targets of 2,000 fields and 500 rules, and about 0.7 ms at the costliest step rate measured (4,923,993 steps in 33 ms), both from ADR 0030 §7 on the development machine. An overrun is refused with `rate_limited` and `retry` (ADR 0030; 04 §12). The overrun is deterministic, so a retry of the same commit fails again; the rule builder should refuse a rule set whose static step bound exceeds the budget (ADR 0030, open question 2).
- **A snapshot commit** (04 §3.2) is written alone, once every commit before it is stored. The room asks the host for a checkpoint of the durable state just before it (08 §3: "around every snapshot commit"); the checkpoint at the snapshot's own `seq` is the one the request references, written by the control plane before it asks. Subscribers receive `sync.reset`; a reader behind the gateway receives the projection of the new content, and visibility is derived again, so that a reader whose class the snapshot changed reloads.

## Consequences

Good:

- One function decides every place a sequence number is supplied, and the room, the content rebuild (`contentAt`) and, later, the REST routes call it.
- A resume never streams across a snapshot, a rewound log or the gate, so a client never applies a commit to the wrong document.

Bad:

- Under the default setting every reconnect of a non-editor is a content read. A signed resume token that names the `seq` at which a session was attached (like the view token of ADR 0019) would let them stream what they could have seen live; it is not needed for correctness.
- `page` needs the commits resource and a client that buffers live commits while it pages.

## Alternatives considered

| Alternative | Why not |
|---|---|
| The gate as a predicate over (user, `seq`) everywhere | Runs of commits need a threshold anyway; a predicate per `seq` would have to be evaluated for every commit of a stream |
| Let viewers stream from any `seq` they claim | Text deleted before their access would reach them (07 §8) |
| Always `page` beyond the limits | Not every host serves the commits resource in phase 1b; `reload` is always available |
| `since_access` without the claim behaves as `editors` | Silent widening; the host misconfiguration should be visible as missing history, not as more history |

## Amendments made (2026-11-18)

- 07 §8: "`minVisibleSeq(user)` is a sequence number; a single state is visible at or above it, at the head and at a named version; a run of commits only from a `seq` at or above it."
- 08 §9: the table of section 2, the rule on `access_since` without the claim, and the precedence of the settings.
- 05 §5.2: the order of section 1; `page` is not sent (decision 202); `inflight` on a reload. 04 §9 item 4 says `reload` beyond the limits (decision 166).
- HIS-024, HIS-025 and HIS-026 follow section 2; their Notes say so.

## Revisit when

Reconnect cost for viewers matters (then add a signed attach token), the commits resource serves class steps (then the gateway may page), or SYN-038 measures the catch-up limits and the rule budget.
