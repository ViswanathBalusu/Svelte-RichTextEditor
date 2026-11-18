# ADR 0379: A revoked channel token is answered with an `error` of code `revoked`

Status: proposed (lane w8, story SEC-014, 2026-11-17). The owner has not decided this.

## Context

SEC-014 criterion 2 says that the old token of a revoked user is refused with `revoked` in a new
`hello`, in `ch.open`, in `auth.refresh` and as a REST bearer. The first, third and fourth already
did so. A `ch.open` that carried a revoked `token` was answered `ch.rejected` with `forbidden`,
because the codes of `ch.rejected` (05 §5.2) are `not_found`, `forbidden`, `unsupported_engine`,
`unsupported_cdm`, `unsupported_feature`, `channel_limit`, `already_open` and `unavailable`. Question 1
of the lane U-SEC-001-016 record asked which answer is right.

## Options

1. Add `revoked` to the codes of `ch.rejected`. This changes the protocol vocabulary and the
   generated schema, and every client must learn a new code.
2. Answer the `ch.open` with a non-fatal `error` of code `revoked`. 05 §5.2 already lists `error`
   among the replies to `ch.open`, and the open-documents quota refusal uses it. `revoked` is
   already an `error` code (05 §7).
3. Keep `forbidden` and reword the criterion.

## Proposal

Option 2. A `ch.open` whose channel token fails verification as revoked is answered with
`error` (`re` the `ch.open` id, `ch` its channel, `code: "revoked"`, `fatal: false`). Every other
refusal of a channel token stays `ch.rejected` with `forbidden`. The text is in 05 §5.2 (the notes
of `ch.open`). The code is in `services/document-service/src/data-plane/session.ts`
(`#openChannel`), the proof in `tests/security/test/revocation.test.ts`.

## Consequences

A client that waits only for `ch.opened` or `ch.rejected` must also handle an `error` that answers
its `ch.open`; it must already do so for `quota_exceeded`. If the owner prefers option 1, the code
changes in one place and the test changes its expected type.
