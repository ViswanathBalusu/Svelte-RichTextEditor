# 0377 SYN-030: the deterministic commit identifier of a server-authored commit

**Status:** proposed (2026-11-17, lane w9)

## Context

04 §10 and 06 §3 say that the control plane writes a request to the outbox "with a deterministic commit `id`", so that a retry cannot apply it twice and a crash between the control plane and the room cannot lose it. 08 §2 says the identifier is "derived for server-authored commits". No document says from what, or in what shape. The room accepts only UUID version 7 identifiers, and the outbox keeps one item for each (tenant, document, commit identifier).

## Decision (proposed)

1. The identifier is the first 16 bytes of SHA-256 over the length-prefixed parts of the request, with the version (7) and variant bits of RFC 9562 set. It passes the room's identifier check. Its first 48 bits are hash bits, not a time. Nothing reads the time of a server-authored commit's identifier: the log's order is `seq`. Code: `services/document-service/src/data-plane/commit-id.ts`.
2. The parts name the operation and what it relied on, so that the same request gives the same identifier and a request made after the document moved gives another:
   - prefill: `prefill`, tenant, document, the requesting actor, the head `seq` the request was authorised against, and the steps as stable JSON (keys sorted);
   - repair: `repair`, tenant, document, the head `seq` and the SHA-256 of the content the repair writes;
   - import and restore (`replaceContent`): the reason, tenant, document, actor and the caller's `requestId`. The import job passes its job identifier. A caller that gives no `requestId` gets a random identifier, because nothing names "the same request" for it.
3. The same prefill sent twice against an unchanged head is one outbox item. A prefill sent after the head moved is a new request and a new commit. Setting a field to the value it already has is harmless.

## Consequences

A retry of an import job after a crash between the job and the room is one commit. The REST `PUT /content` and a version restore give no request identifier yet; they stay random, and keep the `If-Match` check as their guard against a repeat. Choosing an identifier for them (the `Idempotency-Key` header, for example) is left to BE.

## Open

Whether the head `seq` belongs in the prefill's parts. Without it, a second identical prefill after other edits would be discarded as a repeat, which would lose a deliberate re-fill. With it, a retry that arrives after a commit from someone else is applied again, which sets the same values again. The second is the safer error, so it is the default here.
