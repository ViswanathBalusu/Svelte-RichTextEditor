# ADR 0390: What each backend tier may announce (proposed)

Status: proposed. Lane w5, story PRO-101. The maintainers have not accepted it.

## Context

05 §9 gives three tiers (native, sidecar-backed, relay) and a one-line limit for each. A relay
announces none of `regions`, `suggest-enforced`, `fields`. A sidecar announces "everything the
authority service supports". The spec does not say which feature needs which call of the authority
service (05 §10), so "supports" cannot be checked.

## Choices

1. The check is a pure function, `tierProblems` in `packages/protocol/src/client/tiers.ts`, so the
   kit, a sidecar's start-up and a host can all run it on a discovery document.
2. A native backend has no limit. Passing the step-semantics and rules fixtures is what makes a
   backend native; the function does not run them. The kit's `semantics` profile and the authority
   package's fixtures do.
3. `AUTHORITY_SERVICE_NEEDS` lists the calls each feature needs: `regions` and `suggest-enforced`
   need `open` and `applyCommit`; `fields` also needs `evaluateRules`; `rules` needs
   `evaluateRules`; `history` needs `open`, `materialise`, `restoreSteps`, `diff` and `attribution`;
   `exports` and `assets` need `open` and `materialise` (content reads); `read-restrictions` needs
   `open`, `applyCommit` and a `projection` call. Features not listed (`presence`, `comments`,
   `leases`, `workflow`, `sign`, `seal`, `extensions`, `preserve`) do not depend on document
   semantics: they live in the backend's own planes, or are relay-safe as the kit's relay selection
   already treats them. This is a proposal; it can change when PRO-104 to PRO-106 fix the
   signatures.
4. `projection` is not a call of 05 §10. The second review (SR-M6, ADR 0019) says a sidecar needs
   projection calls. Until the interface defines them, no service has the call, so no sidecar can
   announce `read-restrictions`. A relay cannot either, for the same reason.
5. A relay with an authority service announces what the service supports, except the three
   features it may never announce. A relay without one announces only the features that need no
   call. This matches the kit's selection (`packages/tck/test/relay-selection.test.ts`).
6. The authority service states what it supports at `GET /v1/authority/capabilities`, built from the
   calls it implements (`IMPLEMENTED_CALLS`). A sidecar announces no feature outside that list.

## Consequences

- Criterion 3 of PRO-101 stays open for its second half: the kit selects `core-relay` for a relay,
  but the profile has no scenarios until PRO-124.
- Adding a call to the service widens what a sidecar may announce, with no other change.
