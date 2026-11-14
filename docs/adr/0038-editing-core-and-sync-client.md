# ADR 0038: The editing core and its sync client

**Status:** proposed, 2026-11-06. Records the choices made while turning spike S1's core into the production core of `packages/engine` (packet B1 of PLAN-1a: FE-023 to FE-039, FE-121, FE-127, SYN-017 to SYN-020, CDM-012). Each choice answers a point the specification leaves open; none is an owner decision. The project owner has not reviewed any of it.

## Context

04 §7 to §9 define the client algorithm; the authority's reference client (`packages/authority/test/harness/client.ts`) is its executable model, which passed the S3 and S12 simulations. 02 §5 lists the building blocks of the editing core but not how they fit ProseMirror's state, history and view. ADR 0019 (proposed) adds projections with a `hidden_region` placeholder. The core must run in Node.js without a browser (FE-121) and must not depend on which backend implements the ports (05 §8.3).

## Decision

### Structure

- The client algorithm is a pure state machine (`src/sync/state.ts`), ported from the reference client: confirmed document and `seq`, incarnation, view token, one in-flight commit, the queue. Every input returns a new state and the effect on the visible document; nothing is adopted until the editing core accepts it. The I/O lives in a driver over a `SyncChannel` (`src/sync/session.ts`): message order, timers, resumes, reloads.
- The core without a view (`DocumentCore`, entry `@docedit/engine/headless`) imports no `prosemirror-view`; a test walks its imports. The web view (`EditorCore`, the main entry) adds the body view, the sub-editors, the key bindings and the view-only plugins. FE-121 asks for the view layer as a separate *package*; it is a separate entry point here, because creating packages is the main session's call.
- The document API (`src/api.ts`) holds no ProseMirror type; tests and the spike harness reach the state through `internals(core)` from `@docedit/engine/testing`.

### One schema for documents and projections

The editing schema is the CDM's projection schema (`buildProjectionSchema` of `@docedit/model/prosemirror`) with rendering only. A full document never holds a placeholder, and the region guard refuses every local step that touches or carries one, or a redacted value (ADR 0019, "What a reader may not send"), so the steps sent are always CDM steps. One schema means a reload that brings a projection needs no new editor state type.

### Rebuilds

- Remote work reaches the editor as one transaction marked as remote: the old unconfirmed steps undone (inverses computed from the documents they applied to), the confirmed change applied, the new unconfirmed steps applied, each paired ("mirrored") with the step it was rebased from. This is the shape prosemirror-collab gives its rebuilds; prosemirror-history rebases its entries through it (`rebased` metadata) and drops the entries of discarded steps (SYN-017 criterion 5), and positions inside local edits map exactly.
- The document never depends on that construction (04 §7; review CONV-1): the state machine computes the result from the confirmed document; the core compares the transaction's result with it and corrects any difference with one replace step, and falls back to replacing the content when a step does not apply. The property test (`packages/engine/test/sync.property.test.ts`, 100 random schedules against backend-mock) asserts that neither happens; in its run of 2026-11-06 at 11:09 on the development machine (Node.js 22.18) it counted 560 rebuilds, none corrected and none replaced.
- Several commits in one message give one rebuild from the state before the first to the state after the last. Each transition reports which steps moved the confirmed document and where each unconfirmed step came from, and the fold keeps all of them, including the steps of an acknowledgement that changed nothing visible. (A first version chained the effects and lost those steps; the property test found it.)

### Sending

- A local edit is sent at once when nothing is in flight and nothing was sent in the last `batchMs`; otherwise when that interval has passed. `batchMs` is a configuration value with the 100 ms target of 04 §8 as default (SYN-018's reading: a bound on the idle-to-send delay).
- A rejection's resubmission is always made from a timer, never in the task that processed the rejection, and repeated refusals of the same work back off: no delay for the first, then 250 ms doubling to 10 s. These defaults are proposals, not measurements; 05 §5.8 names no values.
- A `rebase` rejection whose `head` the client has already reached failed on commits the room holds but has not stored (its tentative state, 04 §5). Resubmitting at once fails again: in one schedule of the property test (2026-11-06), with writes held, the client sent 5,801,744 commits that were all rejected with `rebase_failed` before the run was stopped. The client then waits for the next commit or the backoff, whichever comes first. 04 §8 does not cover the case.
- `markSet` steps are sent as their inner steps. prosemirror-transform 1.12.5, the release `pm-steps/1` pins, inverts mark steps exactly as a `markSet` step of `addMark` and `removeMark` steps, and undo history uses those inverses; `markSet` is not on the allow-list of 04 §4, so an undo of formatting would be rejected with `invalid_op`. The core flattens them before they reach the queue (`src/steps.ts`), and the guard checks the inner steps. History rebasing then counts the flattened steps, which can misplace an undo entry after a remote change in that rare case (FE-049). **For the spec:** the engine definition should either list `markSet` or say that clients never send it.

### Resume, reload, reset

- `catchUp: "page"` is treated as `reload`: no port member reads the missing commits over REST.
- A reload (04 §9 step 3; ADR 0019 item 6) moves unconfirmed work to recovered edits; a reset (04 §8, §3.2) re-applies local steps to the new content and sets aside those that fail. An in-flight commit the resume reports `accepted` is part of the reloaded content; one not reported at all is treated as `unknown` and resent after the stream catches up.
- The stream is caught up at `sync.caughtUp`, or as soon as the confirmed `seq` reaches the head of `ch.opened`, so a missed state message cannot stop the client from sending.
- A confirmed step that fails to apply is a no-op, as 04 §14 requires of every client, and is reported; an exception while processing a message is reported and resumes the channel.
- When the core decides to reconnect it closes the channel, also one the element handed over (a backend allows one channel per document on a connection); `detach()` leaves the element's channel open.

### Composition (spike S1 finding 1; FE-034)

While a composition is open, a remote change that would alter the block being composed (the body paragraph, or the whole footnote or story of an open sub-editor) waits, and every later message waits behind it, so order is kept. After `compositionend` the change is computed again against the state at that moment, in the next task. The acknowledgement timeout stops when an answer arrives, not when it is processed, so a long composition causes no false timeout. There is no upper bound on the wait; FE-034 keeps that open, with what happens when a remote commit deletes the paragraph being composed.

### Editing rules

- **Region guard.** Scopes come from `diffScopes` of `@docedit/authority`, the comparison the outcome check uses (07 §5.1). A scope may change when the access lists `edit`, `suggest` or `fill` for it; `suggest` scopes are allowed until suggestion mode exists (FE-042), and the authority's P4 then decides. P2 is pre-checked (`structure`, and `manage` for a policy). A region created by the transaction itself takes the capabilities its policy gives (07 §4). A field value change is allowed with `fill` or edit in its container; FRW owns the exact rules. The paragraph kept after a region is part of the checked result, so a transaction that needs it is refused whole (FE-039 criterion 5). A footnote inserted inside a footnote or a caption is refused (I10), and the footnote panel refuses it in its own state too. The guard does not judge identifiers from the shape of steps: an undo of Enter carries an `attr` step that reverts the identifier fill, and refusing it made undo do nothing.
- **Identifiers and undo.** The room refuses an `attr` step on `id` even when the same commit then removes or merges the node (`invalid_op`, "changes the identifier of a paragraph (I2)"), which is the shape of an undo of a split. Two choices keep undo working: Enter at the start of a paragraph that holds content inserts an empty paragraph before it instead of splitting, so the original keeps its node and identifier (the outcome ADR 0018 asks for) and no identifier moves between nodes; and an `id` step whose node a later step of the same change removes is not sent, since it cannot affect the result (checked before it is dropped). **For the authority:** P5 judged by outcome (07 §5.1) would accept these commits as they are.
- **Paragraph after a region.** It is added only after a region that a local change left without one, never to documents from elsewhere, so a person who may edit only a region can type in a document whose region has none.
- **Paragraph styles.** Enter at the end of a paragraph gives the new one the style's `next`; without `next` it keeps the style, which is OOXML's rule for an absent `w:next` (A2, lossless round trip). The spec says nothing for a null `next`.
- **Read-only.** After a `read_only` rejection the core refuses local changes until an access with a newer revision grants a write capability again.
- **Select all** inside a region selects the whole body (02 §5.2, the spec's default; FE-032's open question stays open).

### Views

Every read view of a core shares one hub that calls the subscribers of every changed view in one animation-frame callback (a microtask without a DOM). A transaction that changes nothing a view shows schedules nothing; `revision` changes only when the document, the selection, the stored marks, the access or the panel change. The core satisfies the shell's `CoreApi` (ADR 0041) structurally; the DEP `access` object is the `permissions` view, and `access` is the shell's summary at the selection.

### Presence (04 §11)

With a presence port the core publishes the selection as positions in the confirmed document (mapped back through the unconfirmed steps) with the confirmed `seq`, at most `presenceHz` times a second, deduplicated. The peer list leaves out this session and any peer whose scope is a region the reader sees as a placeholder: the server drops such presence (ADR 0019, item 5), and the client never shows it either.

## Consequences

- The client can be property-tested without a browser against the real `Room` (backend-mock), and the same tests run against backend-dep once it exists.
- The defaults for backoff and the futile-rebase wait are unmeasured; FE-033's integration with backend-dep should measure them.
- Flattening `markSet` is a workaround for a gap between the pinned library and the allow-list; it should go once 04 §4 decides.
