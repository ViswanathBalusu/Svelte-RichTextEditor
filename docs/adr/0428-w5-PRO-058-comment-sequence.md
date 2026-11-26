# 0428 Comments have a sequence number of their own (PRO-058)

Status: proposed (lane w5, 2026-11-18). It applies owner decision 73 and fills in what the decision leaves open.

## Context

`GET /documents/{id}/activity` lists what changed since the caller's read marker, and the marker is a `seq` of the log. A comment is not a commit, so it has no `seq`. ADR 0312 (lane U-PRO-052-068, section 7) left the question open. The owner decided (decision 73, docs/owner-decisions-2026-11-15.md): "Comments get a sequence number of their own."

## Decisions (proposed)

1. A comment takes the next number of its document when it is stored: 1, 2, 3 and so on, in the order the stores commit. A reply is a comment and takes one. Another document counts on its own. The number is the comment's position in the activity and is not content: it is not in the CDM and no commit is made.
2. A number is never given twice. PostgreSQL keeps the last number in `comment_counters` (migration 0102); the upsert that takes the next number locks that row, so two comments made at once get two numbers. Deleting a thread or a comment does not lower the counter.
3. The caller has a comment marker beside the log marker: `read_markers.comment_seq`, 0 when none. `PUT /documents/{id}/read-marker` takes an optional `commentSeq` next to `seq`. Each marker moves forward only, on its own: a body without `commentSeq` leaves the comment marker alone, and `commentSeq` alone is not allowed to move the log marker (the body keeps `seq`, which is required). The answer carries `commentSeq` only when the request named it. A `commentSeq` above the last number given is `not_found`, as a `seq` above the head is.
4. The activity lists the comments by other people whose number is above the comment marker, in the order of the number, at most the last 200 (as before). Each item carries its `seq`. The reply carries `commentMarker` and `commentHead` so a client knows what to send next. With no marker, every comment by others is listed.
5. A comment stored before migration 0102 has no number and counts as 0, so it is never above a marker. Migrations after 0007 are in no release (`migrations/releases.json`), so no released database holds one; a backfill is not possible in a migration anyway, because row-level security is forced on `comments`.
6. The number is for comments only. `body.commentSeq` is listed in `SEQ_INPUTS` as exempt from the history gate: it reads nothing and is not a position in the log.

## Not decided here

- Whether a comment edit or a reaction counts as activity. It does not: only a new comment does, as before.
- Whether the interface sends `commentSeq` itself. No client sends a read marker yet (the element has no activity view).

## Consequences

- The time comparison of the first version (comments after the commit time of the marker) is gone: it needed a position that did not exist and gave a different answer when the clock of a commit and of a comment differed.
- The reply shape of the activity is still a proposal (gap G70); `ReadMarker` in `spec/dep` gains the optional `commentSeq`.
