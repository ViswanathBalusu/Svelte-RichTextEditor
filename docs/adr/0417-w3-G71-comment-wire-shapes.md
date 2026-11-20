# ADR 0417: The thread and comment wire shapes (gap G71)

Status: proposed. Lane w3, 2026-11-18. The owner's answers of 2026-11-15 name no thread or comment shape, so this takes the spec's wording and the shapes the document service already stores.

## Context

05 section 6.2 lists the thread and comment routes. It does not give the bodies (gap G71). `Comment` held only an identifier, `CommentInput` was an open object and `Thread` had no comments, so the editor's shell (UX-028 to UX-032) could not be connected to a backend: it needs authors, times, comment bodies and the state of each thread. The document service already stores all of that (`services/document-service/src/storage/thread-store.ts`).

## Decisions

1. A comment body is a list of parts, `{ type: 'text', text }` and `{ type: 'mention', principal }`. A mention holds only `user:<id>` or `group:<id>` (13 section 5, 07 section 1); a name comes from the host (`resolveUsers`). A text part is plain text. This is the shape the mention picker and the thread view already use (`CommentBodyPart`, `packages/ui/src/core-api.ts`) and the node `mentions.ts` reads (ADR 0375).
2. `CommentInput` is `{ body: CommentBodyPart[] }` with at least one part. `POST /documents/{id}/threads` takes `{ target, comment }` with a `CommentInput`; `POST /threads/{tid}/comments` and `PATCH /comments/{cid}` take a `CommentInput`.
3. `Comment` is `{ id, author, createdAt, editedAt, body }`. `author` is `user:<id>`; `editedAt` is null until the first edit.
4. `Thread` is `{ id, state, assignee, target, createdBy, createdAt, comments }`. The list and the single read both carry the comments, so a client needs no second call to show a thread. `assignee` is a principal (`user:<id>`) or null.
5. A range in `target` is where the text is at `baseSeq`; the list at `?seq=N` maps each range to `N` (as the service did). A range with `from` equal to `to` is a thread whose text was deleted, shown as detached (ADR 0015).
6. Entity tags stay as the service makes them (`"<id>:<state>:<assignee>"` for a thread, `"<id>:<editedAt>"` for a comment). They stay in the `ETag` header of the single reads and writes. A list item and a comment inside a thread have no header of their own, so each `Thread` and `Comment` also carries its current tag as `etag`. A client uses it as the `If-Match` of the next conditional write and treats it as opaque.
7. Notices (05 section 5.6) are unchanged: `thread.*` carries `{ state, seq, range | block }`; `comment.*` carries `{ thread }`. A reader receives a notice only for a thread whose scopes it may read (ADR 0019): the service filters by scope, and so does the mock backend.
8. The mock backend (`@docedit/backend-mock`) implements the `comments` feature with the same rules: the room's range mapping and permission checks, the same tags and notices, the 5,000-thread limit.

## Not decided here

- Whether a comment body may hold more than text and mentions (links, formatting). The parts are an open list of objects with a `type`; a later part type is a minor change.
- A size limit for a comment. The service's request-size limit applies; the spec gives no figure.
- Whether an edit of a comment that adds a mention notifies the person (ADR 0375, item 3).

## Consequences

The shapes in `spec/dep` and `packages/protocol/src/generated` are real, so `backend-dep` validates responses against them. Service tests that sent `{ text }` as a comment now send `{ body: [{ type: 'text', text }] }`.
