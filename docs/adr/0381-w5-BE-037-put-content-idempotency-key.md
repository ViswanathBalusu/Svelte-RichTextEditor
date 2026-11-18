# 0381 BE-037: `Idempotency-Key` on `PUT /documents/{id}/content`

Status: proposed (lane w5, 2026-11-17). Story: BE-037 criterion 5. Open question: ADR 0104, Q9.
The owner has not decided it and `docs/owner-decisions-2026-11-15.md` does not list it.

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

Option 1, as the default of Q9 says. Criterion 5 stays unticked: its words name the header, and the
route does not read it. If the owner chooses option 2 the change is the flag, `pnpm generate`, the
wording of 05 §6.1 and one test through the header.
