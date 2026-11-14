# ADR 0001: Server-authoritative sync instead of a CRDT

**Status:** accepted, 2026-11-06, when the project owner confirmed assumption A1: version 1 does not need offline-first editing (proposed 2026-09-18). Short disconnections and closed tabs are handled by the recovery journal of 02 §2.2.

## Context

The product needs real-time collaboration (R7), server-enforced edit permissions on parts of a document (R3), suggestion-only and comment-only roles (R8), a history that can be trusted (R4), and a server that can typeset the document (R5).

Most collaborative editors today use Yjs, a CRDT (conflict-free replicated data type). Research on 2026-09-18 found:

- Yjs's own threat model says "Server-side filtering of updates is a common antipattern" and that suggestion-only users "should work on a separate Yjs document fork". Its author has written that giving secure access to only part of a Yjs document is currently not possible.
- Every product found that enforces per-user editable ranges while people co-edit does it on an authoritative server.
- Yjs's attribution and version-comparison features were still release candidates (version 14), and its ProseMirror binding had an open issue in which content that violates the schema is silently dropped.

## Decision

The server is the authority on every edit. Clients submit commits of ProseMirror steps against a base version. One room per open document rebases them, checks invariants and permissions, stores them, and only then acknowledges and broadcasts them. The engine is named `pm-steps/1` and is specified in 04.

The protocol negotiates the engine per channel, so another engine can be added without a new protocol.

## Consequences

Good:
- Permission checks on every change, including suggestion-only and comment-only roles.
- A rejected change is simply removed by the client. A rejected CRDT update cannot be un-applied and forces the client to discard its local state.
- The log is the history, with attribution stamped by the server.
- The server always holds the real document, which export, search and comparison need anyway.
- No tombstones, garbage-collection settings or binding quirks.

Bad:
- No offline-first editing. Disconnections are tolerated; long offline sessions are not supported.
- The off-the-shelf Yjs servers (Hocuspocus and others) cannot be used.
- A backend that enforces permissions must run the document model. Mitigations: the authority sidecar, and relay mode for backends that need neither permissions nor export.
- Rebasing can drop a local step when someone else removed the content it applied to.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Yjs with server-side validation of updates | Its maintainers call it an antipattern; validators have known blind spots (pending updates, arbitrary root types, client-chosen identifiers) |
| Yjs with one document per region, access controlled per document | Secure at region granularity and friendly to backends in any language, but needs a composite editor over many documents, makes cross-region edits non-atomic, multiplies history and export work, and cannot enforce suggestion-only or fill-only roles. The first review established that this is not a fallback from the chosen design: it would replace the log, sequence-based history, restore, comparison, attribution and the permission outcome check. It is a rewrite |
| Loro or Automerge | Stronger built-in history, but the same access-control problem and a much smaller server ecosystem |
| Plain `prosemirror-collab` with no server rebase | Simple, but clients on slow links starve under contention. Kept as relay mode |
| A custom operational-transformation engine | CKEditor reports that tree OT took over a year and several reworks |

## After the first review (2026-09-18)

- This decision is a one-way door and should be confirmed before phase 1.
- What the design offers instead of offline-first editing is disconnection tolerance: a journal of unconfirmed commits in the browser, resubmitted with the same identifiers, and paged catch-up after long gaps.
- The reviewer checked the server-side rebase procedure index by index against ProseMirror's own and found it equivalent. Convergence after a rejection or a rebased acknowledgement must not rely on stored inverse steps, because the inverse of a mark step is not exact after an overlapping mark step; the client keeps its confirmed document and rebuilds from it.
- Permission checks compare the document before and after a commit instead of reasoning about step shapes (07, section 5.1), and the log write is conditional on the grants revision, so a lost notification cannot leave a revoked user able to write.

## Revisit when

Offline-first editing becomes a requirement; or a CRDT library ships production-ready write access control below the document level.
