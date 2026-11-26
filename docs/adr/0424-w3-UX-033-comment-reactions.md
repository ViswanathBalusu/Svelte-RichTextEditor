# 0424 Comment reactions (UX-033)

Status: proposed (lane w3, 2026-11-25). Owner decision 33 (2026-11-15) says to build reactions: protocol, server and comment pane. The decision does not say which reactions exist or who may react; the points below are the defaults chosen here.

## Decisions proposed

- **Feature.** `reactions`, announced in discovery beside `comments`. Without it the editor offers no reaction control. `Comment.reactions` is present only while at least one reaction is held.
- **Reactions.** A fixed set of six names: `thumbsUp`, `heart`, `laugh`, `celebrate`, `eyes`, `done`. A fixed set keeps the control and its names in the interface language, and keeps a service from storing arbitrary text. The owner may change the set; the shell takes the set from the protocol shape.
- **Who may react.** A user with `comment` in the scopes of the target thread, as for a reply (13 §5 assumes `comment`).
- **Resource.** `POST /comments/{cid}/reactions/{reaction}` adds the caller, `DELETE` removes the caller. Both are idempotent and return the comment with its entity tag. They take no `If-Match` (a reaction is the caller's own and never conflicts), so the definition marks it `optional`. The first is a `POST` because the definition requires `If-Match` of every `PUT`.
- **Shape.** `Comment.reactions` is a list of `{ reaction, users }`, in the order of the set above, without reactions that nobody holds. `users` are `user:<id>` in the order they reacted.
- **No commit.** A reaction is not part of the document and is not in the commit log. The service keeps it with the comment and raises the notification `comment.reacted` on `/comments/{cid}`, so connected clients read the thread again. It does not change the comment's entity tag, so an edit made from an earlier read is still accepted.
- **Names.** The shell shows the names of the people with `resolveUsers` (13 §5, UX-025).

## Not decided

- Whether a reaction on a deleted comment is kept (it is not: it goes with the comment).
- A limit on reactions per comment and per user. None is set; each user holds each reaction at most once.
- Webhooks: no `dep.*` event is raised for a reaction.
