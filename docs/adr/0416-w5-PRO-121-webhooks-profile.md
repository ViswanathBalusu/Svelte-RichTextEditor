# ADR 0416: How the kit tests webhooks (PRO-121)

Status: proposed (lane w5, 2026-11-18). Point 3 applies a proposal of ADR 0316 that the bulk
decisions 196 to 220 of `docs/owner-decisions-2026-11-15.md` accept; points 1, 2 and 4 are new and
not decided by the owner.

## Context

PRO-121 waited on three things (story Notes, lane w5, first round): the feature name `webhooks`,
the address of a receiver the target can reach, and a way to count `dep.document.changed.v1` at the
receiver. The target refuses loopback and private addresses on purpose (10 section 3.2), so a
receiver on the kit's own host is refused.

## Decisions (proposed)

1. **No feature name.** DEP defines no feature `webhooks` (05 section 2), and none is added. As for
   `fonts` and `imports`, the profile always runs and each scenario is skipped, with the reason,
   when `GET /webhooks` is `not_found`. Adding a feature would change the protocol definition, the
   generated artifacts and discovery. Alternative: add the feature and require it; the profile and
   the README row then change in one place.
2. **The receiver is the operator's input.** The kit starts a receiver (`packages/tck/src/receiver.ts`)
   and takes `receiver.host`, `receiver.port` and `receiver.url` (`--receiver-host`,
   `--receiver-port`, `--receiver-url`). `url` is the address the target reaches it at: a public name
   or tunnel for a hosted server. Without it the receiver listens on `127.0.0.1` on a free port.
3. **A test-mode allow-list for the reference service** (ADR 0316 proposal 2). `DOCEDIT_TEST_WEBHOOK_ALLOW`
   is a list of exact IP literals the egress proxy reaches although it would refuse them. It is
   refused unless the test-mode switch is on (`checkConfig`), it never allows a name, a range or a
   redirect target that is not listed, and the policy for every other address is unchanged
   (`services/document-service/src/control-plane/pro-121-test-allow.test.ts`).
4. **Provisional figures.** The debounce scenario sends 100 commits (the number of the criterion)
   and allows 1,000 ms of network jitter on the ten-second gap between two deliveries of one
   document. The window itself, ten seconds, is the spec's. The retry scenario fails the first two
   attempts of a delivery; the schedule is the server's (`DOCEDIT_WEBHOOK_RETRY_BASE_MS` and
   `DOCEDIT_WEBHOOK_RETRY_FACTOR`, which have no default, ADR 0216), so a server without a retry
   schedule fails the scenario, because 05 section 7 says delivery is at least once.
