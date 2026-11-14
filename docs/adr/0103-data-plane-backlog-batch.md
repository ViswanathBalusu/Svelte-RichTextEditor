# ADR 0103: Data-plane backlog batch (round 1)

**Status:** proposed, 2026-11-13. Owner: data-plane agent (PLAN-1a A1 and PLAN-1b packet A).

## Context

Packet A works in `services/document-service/src/data-plane/`. Most of its phase 1b stories are
untouched, and most of their open criteria wait for packets B, C or K, or for PostgreSQL. This
round looked for criteria the existing code already meets and that existing tests already show.

## Decisions taken in this round

1. **Evidence comes from the tests in `services/document-service/test/data-plane/`.** The tests
   for the data plane sit in `test/`, outside `src/data-plane/`, and the packet's ownership rule
   forbids new files there. No new test file was written, so no criterion is ticked on an
   untested claim. Stories cite those test files by path.
2. **Five stories ticked on passing tests:** BE-027 (criteria 1, 2), PRO-018 (3, 4, 6), PRO-024
   (1, 4, 5), PRM-021 (1, 2, 4), PRO-044 (3).
3. **PRO-018 criterion 4 is ticked with a configured timeout.** The test sets `chunkTimeoutMs` to
   200 ms. The default of 10 seconds is set in `src/data-plane/settings.ts`, and the spec figure
   is not measured here. The spec's default is used, as the owner asked.
4. **Not ticked, with reasons in the story Notes:** every criterion that needs the client, the
   codec in `packages/protocol`, PostgreSQL, a browser, a load measurement or a 10-minute run.

## Open items for the main session

- `services/document-service/test/data-plane/session-1b.test.ts`, "rate limits (BE-030)", the
  test "answers messages over the connection limit ...", fails on the current code. The
  connection bucket has capacity 3. `ch.open`, the first submit and the second submit take the
  three tokens and the second submit is admitted, but the test expects it refused. Possible fixes:
  capacity 2 in the test, or a different count in the expectation. The owner of `test/` decides.
  BE-030 criterion 2 stays unticked until that test passes. This batch did not touch the test.
- BE-030 criterion 3 (another tenant's latency) is not measured; the test checks only that the
  other tenant is not limited.
- BE-027 criterion 4 needs a queue-depth gauge (BE-086). None is asserted.
- PRO-018 criteria 1 and 2 belong to the codec in `packages/protocol` (packet B). Criterion 5
  needs a 1 MiB commit in the test; the current test sends about 800 kB.

## Consequences

Ticks depend on the existing test files in `test/`. If those files move or change, the Evidence
lines must change with them.

## Addendum (developer pass, 2026-11-13)

1. **A unit test in `src/data-plane/` is allowed.** `src/data-plane/limits.test.ts` (9 tests,
   pure, no sockets) covers the token buckets and their keys (address, tenant, user keyed by
   tenant and identifier, connection). It is the only new file. Decision 1 above still holds for
   every session-level test: those stay in `test/data-plane/`.
2. **Three more criteria ticked on passing tests.** BE-030 criteria 1 (upgrade 429 before
   verification, frames before `hello` closed with 4429) and 4 (presence coalesced before the
   room), both from `test/data-plane/session-1b.test.ts` and `presence.test.ts`; SYN-027
   criterion 2 (live commit is `head` plus one) from `test/data-plane/sync.test.ts`.
3. **Spec default kept for BE-030 limits.** The figures are ADR 0053's (`src/data-plane/settings.ts`).
   No figure was measured.
4. **Notes only.** PRO-019 (server half passes; client heartbeat has no named test) and PRO-037
   (4429 now sent; the other triggers are not all tested) got Notes updates, no ticks.
5. **Failing test, not changed.** Open item 1 above still stands: the connection-limit test in
   `test/data-plane/session-1b.test.ts` fails, and it sits outside this packet's directory. The
   owner of `test/` should set its connection capacity to 2 (the `ch.open` takes a token).
   `test/data-plane/convergence.test.ts` (SYN-047 through the data plane) also fails on a coverage
   assertion (`invalid_op` never produced by the schedules); it is not cited as evidence anywhere.

## Round 2 (2026-11-13)

1. **New tests sit in `src/data-plane/`, which the packet owns.** `lease.test.ts` (BE-018),
   `gate.test.ts` (HIS-024) and `metrics.test.ts` (BE-086) use fake clocks or in-process ports, so
   they need no PostgreSQL, no socket and no browser. Decision 1 of round 1 still holds for the
   session-level tests, which stay in `test/data-plane/`.
2. **Ticks, each on a passing test:** BE-018 (criteria 1 and 4), HIS-024 (criterion 5), BE-086
   (criterion 2).
3. **Node lease defaults stay as implemented.** `settings.ts` sets a 15 s validity, a renewal
   every 3 s and a 1 s margin. The spec leaves these open (06 §2.1 "every few seconds"), so they
   are the implementer's choice and are not measured. The tests use the defaults and fake clocks.
4. **Not ticked:** BE-018 criteria 2, 3 and 5 (a lost lease must close every room's channels in a
   running plane; ownership fencing and a killed node's restart need PostgreSQL). HIS-024
   criteria 1, 2, 4 and 6 (a control-plane copy of the rule, ungated routes, no route-table walk,
   and the named-version half of criterion 6 is phase 2). BE-086 criteria 1, 3 and 4 (the metric
   list is incomplete, the registry and label checks are not written).

## Round 3 (2026-11-13, packet A)

Stories handled this round: BE-027, BE-038, BE-039.

1. **Tests for the outbox sit in \src/data-plane/outbox.test.ts\.** They drive \OutboxDelivery\ over \MemoryOutbox\ with a clock the test moves, and a stand-in room that checks the precondition and keeps a log. The room's own checks are not claimed by these tests.
2. **Ticks, each on a passing test:** BE-027 criterion 4 (\src/data-plane/metrics.test.ts\, the per-tenant \dep_send_queue_bytes\ gauge; a measure in bytes, as the gauge already reports); BE-039 criterion 4 (the crashed-claim test in \outbox.test.ts\); BE-038 criteria 1 and 2 (\	est/control-plane/routes.commits.test.ts\, memory variant run; the PostgreSQL variant was skipped because no PostgreSQL runs here).
3. **Not ticked, with reasons in the story Notes:** BE-038 criteria 3 (no cold segment store exists) and 4 (no test of the answer beyond the catch-up limits); BE-039 criteria 2, 3, 5 and 6 (the room's re-check, the single commit and the approved-region refusal belong to the room); BE-027 criterion 3 (latency and memory are not measured).
4. **Open question, decided by the spec default and not changed:** the send-queue bound (\sendQueueBytes\, set in \settings.ts\) is not given in the spec. The gauge reports bytes, not messages, which the spec does not fix either.

## Round 4 (2026-11-13, packet A)

Stories handled this round: BE-020, BE-021, BE-023 and SYN-031.

1. **Tests sit in `src/data-plane/`.** `checkpoint-policy.test.ts` (9 tests) and `transient.test.ts` (3 tests). Both use the plane fixture of `test/data-plane/support.ts`, as `read-commits.test.ts` already does, over the in-memory stores with real timers and short settings. No PostgreSQL, socket beyond loopback, or browser is needed.
2. **Defect fixed in `src/data-plane/room-host.ts`.** `enforceBudget` ran at each room load and could close a room that had just loaded: it had no channel yet, so the first channel was refused with `ch.rejected` (`the room stopped serving the document`). A room is now a candidate only when its `idleSince` is set, which happens when its last channel leaves. This follows BE-021 criterion 3 (a room with a channel is never evicted). The spec does not say what a room opening under memory pressure should do; this is the implementer's choice, recorded here and not a spec change.
3. **Defaults asserted, not measured.** `settingsFrom({})` resolves to 2,000 commits, ten minutes, two minutes between checkpoints and a 60 s idle delay, as the spec states. The trigger tests use scaled values (for example 150 ms and 300 ms) to test the rule, not the defaults.
4. **Ticks, each on a passing test:** BE-020 criteria 1 and 6; BE-021 criteria 2 and 3; BE-023 criterion 1; SYN-031 criterion 1 (the authority's criteria 3 and 4 were already ticked).
5. **Not ticked, reasons in the story Notes:** BE-020 criteria 2 (no snapshot in the test), 3 (workers inline), 4 (object and index row not asserted) and 5 (HIS-029); BE-021 criteria 1 (ownership release not observable: the store has no read) and 4 (BE-086 and BE-084 not built); BE-023 criteria 2, 3 and 4; SYN-031 criterion 2.
6. **Leftover from the last review, still open.** No PostgreSQL runs here, so no PostgreSQL variant has been run. `read-commits.test.ts` still runs over memory stores only. `idempotency-retention.test.ts` is in `services/document-service/src/control-plane/`, outside this packet, and was not touched.
7. **Failing test, not changed (item 1 of round 1 still stands).** `test/data-plane/session-1b.test.ts`, "answers messages over the connection limit ...", still fails on the connection bucket capacity. It sits outside this packet's directory. The other data-plane tests pass: 154 passed, 7 skipped (the `.pg` variants and the PostgreSQL-only cases).

## Round 6 (2026-11-13, packet A)

Stories handled this round: PRO-024 and PRO-044 (the packet's partly done stories with criteria the
data plane could meet). BE-024, HIS-001, HIS-002, HIS-003, PRM-006, PRM-019, PRM-020, SYN-004,
SYN-015, PRO-028, PRO-032, PRO-130 and BE-019 were checked: each open criterion needs the control
plane, the client, the authority's indexes, FRW, PostgreSQL, a measurement or a snapshot commit that
is not built yet. Their Notes were left as they are.

1. **Rate-limit decision (the leftover from the last review).** BE-030 does not say whether `hello`
   or `ch.open` count against the connection bucket, and 05 does not either. The spec default kept
   here: every message after `hello` counts against the connection, the user and the tenant, and
   `hello` does not. `hello` is refused or admitted by the address buckets before any token is
   verified (BE-030 criterion 1), so it is not counted twice. `ch.open` is a message after `hello`
   and counts. The code in `src/data-plane/session.ts` (`#admit`, called for every non-chunk
   message after `hello`) does this, and it is unchanged. With capacity 3, `ch.open`, the first submit
   and the second submit take the three tokens, so the test "answers messages over the connection
   limit ..." in `test/data-plane/session-1b.test.ts` must use capacity 2 (or expect the third
   submit to be refused). That test is outside this packet and was not changed. Owner of `test/`
   decides; BE-030 criterion 2 stays unticked until it passes.
2. **New tests in `src/data-plane/`.**
   - `close-reasons.test.ts` (4 tests, all passing): the `ch.closed` reason and code
     for revocation (`forbidden`), a stopped room (`unavailable`), a room fenced by another node
     (`unavailable`, no `retryInMs`, which 05 §5.2 allows) and `slow_consumer`.
   - `telemetry-hygiene.test.ts` (1 test, passing): no span and no data-plane error holds the typed
     text, the session token or a bogus token.
3. **Ticks, each on a passing test:** PRO-024 criterion 2 (`close-reasons.test.ts`).
4. **Not ticked:** PRO-044 criterion 4 (the data plane's spans and errors pass, but the control
   plane's REST logs and traces are not searched, and the criterion is about all logs and traces);
   PRO-044 criteria 1 and 2 (REST, control plane).
5. **Fence close carries no `retryInMs`.** `room-host.ts` sends `retryInMs` for the `unavailable`
   closes of `fence()` but not for the fence that a rejected write causes. 05 §5.2 makes it optional,
   so this is not a defect. Recorded here so that the owner of the spec can decide whether a fenced
   client should wait before it reopens.
6. **Environment.** No PostgreSQL or browser was run. `pnpm vitest run` on the two new files passes
   (5 tests). Type-check of the package was not run in this round.

## Round 7 (2026-11-13, packet A)

Stories handled this round: BE-030 (the leftover from the last review). The other candidates in
PLAN-1a A1 and PLAN-1b A (BE-019, BE-024, BE-029, HIS-001 to HIS-003, PRM-006, PRM-019, PRM-020,
PRO-028, PRO-031, PRO-032, SYN-004, SYN-015, SYN-047) were checked again against their open criteria
and their Notes. Each open criterion still needs the control plane, the client, the authority's
indexes or rules, the FRW workflow, PostgreSQL, a browser, CI or a measurement, so none was ticked.

1. **REST limiter (BE-030 criterion 2, REST half), decision in the data plane.** `src/data-plane/limits.ts`
   gains `RateLimits.rest(tenant, user, now)`, which takes from the same tenant and user buckets as
   the socket messages, and `retryAfterSeconds(waitMs)` (RFC 9110 delta-seconds, rounded up, at least
   one). Tests: `src/data-plane/limits.test.ts`, 13 tests passing (4 new). The spec default kept:
   a REST request counts against the user and the tenant as a socket message does.
2. **Not ticked.** BE-030 criterion 2 stays open: no control-plane route calls `rest()`, so no REST
   429 is shown. This needs the route wiring in `src/control-plane/` (packet C, which owns it) or in
   `src/server.ts` (main session), and a route test.
3. **Not run.** No PostgreSQL, browser or container. The type-check of `services/document-service`
   was run and shows no error in `src/data-plane/limits*.ts`; the package's other errors, if any, were
   not inspected.

## Round 4 (data-plane developer, 2026-11-13)

1. **Nothing ticked this round.** The packet's remaining open criteria in `src/data-plane/` either need work outside the packet or a measurement that has not been taken. The unticked criteria and their reasons:
   - PRO-037 criterion 3: eight of the nine close codes are triggered by tests in `test/data-plane/session.test.ts` and `session-1b.test.ts`. 4500 is reached only by an exception escaping a handler after `hello`. No seam in `src/data-plane/` produces one, and the test hooks live in `src/seams.ts`, which the packet does not own. Criterion 4 needs a decision on the WebSocket layer's 1009 close, which is not among the nine codes.
   - BE-019 criterion 2 (position maps and node, region, field and comment indexes): not built. The rebase window is enforced in `packages/authority/src/room/room.ts`, but no index is derived on open. Criteria 4 and 5 need a measurement and a 16 MiB document in worker threads. The replay itself does run in workers (`room-host.ts`, `materialise`), so criterion 5 is partly in place.
   - BE-029 criterion 2 (token checks): the verifier is `src/control-plane/tokens.ts` (packet C or A2). The data plane maps any verifier failure without a registry code to 4401.
   - HIS-001 criteria 1 and 2 and HIS-002 criterion 4 (snapshot kind): wait for BE-037 and the log store's snapshot writes in `src/storage/log-store.ts`.
   - HIS-003 criteria 2 and 3: criterion 2 needs a CI scan with the control plane's mapping rows. Criterion 3 is about session records, and the data plane keeps none, so ticking it would be hollow.
   - PRM-006 criterion 1 and SYN-004 criterion 1: the workflow transition and participant completion have no source until FRW, so the criteria cannot be met as written.
   - SYN-047 criterion 1: all seven step types need harness changes in `packages/authority/test`, outside this packet.
   - SYN-015 criterion 1, BE-024 criterion 1 and SYN-015 latency: targets measured by BE-058 on the reference deployment. No figure is invented here.
2. **Open decision for the owner (not decided here).** PRO-037 criterion 4 needs ADR 0035 to say what closes a frame that the WebSocket layer cuts at eight times `maxMessageBytes`, given that 1009 is not one of the nine codes of 05 §5.7.
3. **No file changed except the stories' Notes (PRO-protocol.md, PRO-037) and this ADR.**
