# 0381 BE-037: `Idempotency-Key` on `PUT /documents/{id}/content`

Status: accepted by decision 101 of `docs/owner-decisions-2026-11-15.md` (option 2). Story: BE-037
criterion 5. Question: ADR 0104, Q9. Revised by lane w5, 2026-11-18.

## Context

BE-037 criterion 5 reads: given the same `Idempotency-Key` is sent twice, only one snapshot commit
exists. 05 §6.1 says `POST` requests that create something accept the header, and `replaceContent`
is a `PUT` without the `idempotencyKey` flag in `packages/protocol`, so the pipeline ignores the
header on this route. The protocol is the contract; changing its flag changes the OpenAPI document,
the conformance kit and 05 §6.1.

## What already holds

- The route requires `If-Match`, and the ETag of the content carries the incarnation and the head.
  The same PUT repeated after it succeeded no longer matches and is refused with 412
  (`precondition_failed`). `services/document-service/test/server/be-037-w5-put-twice.test.ts`
  shows 204 and then 412 with one snapshot commit at seq 1.
- The data plane derives the commit identifier from the ETag and the content hash
  (`replaceContent`, BE-039). A delivery of the same request repeated after a crash is one commit.

## Options

1. Keep the default of Q9: the route does not accept the header. A repeated PUT is refused by
   `If-Match` and cannot store a second commit. Nothing changes in the protocol.
2. Add `idempotencyKey: true` to `replaceContent`, regenerate the artifacts, and change 05 §6.1 to
   "`POST` and `PUT /content`". A repeated request with the key then gets the stored 204 instead of 412,
   which is friendlier to a client that lost the first answer.

## Taken here

Option 2, as decision 101 accepts. `replaceContent` has `idempotencyKey: true` and the code
`idempotency_mismatch` in `packages/protocol/src/definition/resources.ts`; the artifacts under `spec/dep`
are regenerated; 05 §6.1 says "`POST` requests that create something, and `PUT /documents/{id}/content`".
The pipeline already runs any route with the flag through the idempotency store, before the handler
checks `If-Match`, so a repeat with the same key and body gets the stored 204, and the same key with
another body gets `idempotency_mismatch`. Tests: `services/document-service/test/server/be-037-w5-put-twice.test.ts`.
