# ADR 0015: Comment ranges are kept and mapped by the document service, not stored in the document

**Status:** proposed, 2026-09-18, after the first review. It replaces the paired anchor nodes of the first draft.

## Context

The first draft marked a commented range with two zero-width anchor nodes in the document, inserted by the server on the commenter's behalf. The review found problems from three directions:

- **Editing.** Zero-width atoms put two document positions at one caret location. Backspace appears to do nothing because it removed an anchor, typed text lands inside or outside a comment unpredictably, and anchors split words for double-click, spellcheck and find.
- **Security.** Anchors are document content, so any editor could delete someone's comment anchor or re-point it at another clause. The server-authored insertion also had a gap between authorisation and application.
- **Workflow.** Because a comment changed the document, comments had to be disabled while a document was locked for signing.

The room already maintains structures that are mapped through every step: the region index and the attribution map.

## Decision

A comment thread targets a text range or a block by identifier. The range is stored with the thread by the document service, mapped through every commit by the room, saved with checkpoints, and reported to clients, which keep their copy current by mapping it through the steps they apply. Creating a thread is a control-plane call; the room maps the requested range to the head and checks `comment` in the scopes it covers at that moment.

Bookmarks remain anchor nodes, because they are explicit, rare, and part of what the author wrote.

## Consequences

Good:
- Commenting never changes the document: no commits from commenters, comments on locked and approved content, comments during signing workflows.
- An editor cannot move or re-point another person's comment.
- No invisible cursor stops.
- Threads can target figures, tables and equations by block identifier.

Bad:
- When commented text is deleted the range collapses and stays collapsed; undoing the deletion does not restore it. The thread is shown as detached.
- Ranges at old versions come from the nearest checkpoint, so they are approximate between checkpoints.
- The authority service needs a range-mapping call.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Paired anchor nodes | The problems above |
| Marks | Split across blocks, merge and split with formatting, and are still document content that any editor can change |
| Ranges stored only on the client | No single truth for export and history |

## Revisit when

Users need comment ranges to survive delete-and-undo exactly.
