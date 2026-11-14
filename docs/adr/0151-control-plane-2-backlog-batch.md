# ADR 0151: control-plane-2 backlog batch (PRO-069, PRO-070, PRO-072)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** control-plane-2, round 1.

## Context

The lane took stories from the end of PRO-protocol's REST slice (PRO-073 backwards) whose criteria can be met inside `services/document-service/src/control-plane`. Three stories got code and tests: PRO-069 (the CloudEvents envelope), PRO-070 (the signature of webhook requests) and PRO-072 (the event debounce and the events already raised). PRO-073 was read and not claimed: export completion and failure are raised (`exports.ts`), but import events, thread and comment events and the e-mail rule need routes that do not exist yet. PRO-071 (delivery and the egress rule) needs the dispatcher (BE-055) and the proxy (BE-056), which are not built. PRO-068 (subscriptions) needs `/webhooks` routes wired into the handlers, which this lane does not own.

## Decisions taken as the spec default

- The envelope builder refuses an event without `data.seq` and a `dep.document.changed.v1` without `data.chainHead`. Every schema in `spec/dep/webhooks` requires `seq`, and the changed event requires the chain head, so the builder enforces the schema's own rules.
- The `chainHead` field name is the schema's placeholder (gaps G83). It is kept as it is.
- Signatures follow the Standard Webhooks scheme as 05 §7 names it: `whsec_` secrets with base64 key bytes, `<id>.<timestamp>.<body>` signed with HMAC-SHA256, `v1,<base64>` entries, five-minute tolerance inclusive. The published test vectors were not used, so no criterion that needs them is ticked.
- The debounce for `dep.document.changed.v1` is leading and trailing: the first change of a window is raised at once, the latest change of the window is raised when the window ends. This keeps the last state of a burst.

## Open questions (not decided here)

1. The rate of `dep.commit.rejected` throttling is not stated (05 §7 says "throttled"; PRO-072 says "far fewer events"). No default was chosen. Proposal for the owner: one raised event per subject and per 10 seconds, the same window as `dep.document.changed`, carrying the count of suppressed rejections. Not implemented.
2. Whether a receiver must validate the full JSON Schema. This package has no JSON Schema validator as a dependency (`ajv` is in `packages/protocol` only). Adding one needs `scripts/pnpm-locked.ps1` and the main session.

## Needed from other owners

- `handlers.ts` and `kit.ts`: route `dep.document.changed` through `DocumentChangeDebounce` and pass the hash-chain head; emit `dep.grants.changed` with `seq`, as the schema requires.
- The dispatcher (BE-055) must call `toCloudEvent` and `signDelivery`; the egress proxy (BE-056) applies the address rule of PRO-071.
- `dep.version.*`, `dep.session.*` and `dep.commit.rejected` need emitters.

## Consequences

Three files are new and have tests: `webhook-envelope.ts`, `webhook-signing.ts`, `event-throttle.ts`, each with a `.test.ts`. No existing file in the control plane changed. Stories PRO-069, PRO-070 and PRO-072 carry the ticks and Notes listed in `docs/stories/PRO-protocol.md`.

## Round 2 (2026-11-13)

Lane control-plane-2, round 2, worked PRO-068 and PRO-065 from the end of the slice.

- PRO-068: `webhook-subscriptions.ts` holds the five operations of `/webhooks` and `/webhooks/{id}` over a store, with If-Match, a service-credential check and the two-secret rotation of PRO-070. Tests are in `webhook-subscriptions.test.ts` (11 passed). Proposed body of a subscription (G76 is a placeholder in `spec/dep`): `POST` takes `url` (an absolute http or https URL) and `events` (a non-empty list of distinct event names with a version suffix, at most 64); `PATCH` takes `url`, `events`, `rotate: true` (adds a second active secret and returns it once; a second rotation is `conflict`) and `retire: true` (drops the older secret; `conflict` without a rotation); unknown members are refused with `validation_failed`. Proposal, not a published contract: the owner decides the shape. The reads never return a secret.
- Not built: the test ping and the replay (PRO-068 criteria 4, 5), which need the dispatcher and the egress proxy. The mapping of the operations into the router and the handler map is not in this lane (needs the owner of `handlers.ts`). Criteria 1 to 3 of PRO-068 therefore stay unticked, although the operations are tested.
- PRO-065: criteria 1 and 3 are ticked on the existing memory-variant test in `services/document-service/test/control-plane/routes.exports.test.ts` (run of 2026-11-13: passed). Criterion 2 stays open: only `accept` is tested.
- Open for the owner: the body of a subscription (G76); whether the event filter is a list of exact names or may use wildcards (this round uses exact names only, the spec default is not stated); whether a subscription with no events means "all events" (this round refuses an empty list).
