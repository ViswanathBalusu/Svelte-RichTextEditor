# ADR 0375: Mentions in a comment body (PRO-060)

Status: proposed. Lane w5, 2026-11-17.

## Context

The body of a comment is open (gap G71): `CommentInput` and `Comment` are placeholders. 13 §5 says a mention is a node in the comment body, chosen through `searchPrincipals`, and that the service raises `dep.comment.mentioned` so the host can send the notification. The editor's mention picker (UX-031, `packages/ui/src/shell/mention-search.ts`) inserts `{ "type": "mention", "principal": "user:<sub>" }` or `group:<id>`.

## Decisions

1. The service reads a mention as an object with `type` equal to `mention` and a `principal` string of the form `user:<id>` or `group:<id>` with no whitespace, wherever it lies in the body. Anything else is ignored.
2. A comment raises `dep.comment.mentioned` once for each distinct principal, in order of first appearance. The data is `{ comment, thread, principal, seq }`. The principal is the one the node holds (the host's `sub` or group), not a surrogate, because the host sends the notification.
3. The events are raised for a reply (`POST /threads/{tid}/comments`) and for the first comment of a new thread. An edit of a comment (`PATCH /comments/{cid}`) raises none: whether an edit should notify the people it newly mentions is open and is left to the owner.
4. A refused request raises nothing. The service does not check that a mentioned principal may see the thread; the host decides what to send (13 §5).

## Consequences

A host can build notifications from the webhook alone. The body shape is still not fixed in `spec/dep`; if G71 settles on another node name, `mentions.ts` is the one place to change.
