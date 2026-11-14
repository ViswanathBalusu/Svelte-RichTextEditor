# ADR 0019: Read restrictions through per-reader projections of one log

**Status:** proposed, 2026-11-06. Follows the project owner's decision on SPK-005 that day: version 1 must be able to hide some regions and some field values from some people who can open the document. This reverses a non-goal of 00 §3 and of 07 §1. Spike S12 (SPK-029) tests the design before phase 1b, as SPK-005 requires.

S12 ran on 2026-11-06 (`docs/spikes/2026-11-06-s12-read-restrictions.md`). The design holds with the five changes under "Changes from spike S12", which this text now includes. It stays proposed until the owner confirms the policy questions.

## Context

Until now everyone who could open a document could read all of it. Permissions controlled only who may change what (07 §1). 00 §10 and 07 §17 warned that read restrictions need filtered content, filtered sync, filtered history and filtered export.

The rest of the design limits the options:

- One server-authoritative, totally ordered log per document (ADR 0001, accepted). The outcome check compares whole documents (07 §5.1).
- ProseMirror steps address positions. A position counts every character before it, so a document with something removed has different positions.
- Regions are isolating block containers that are direct children of the body (ADR 0009). Selections that start in a region stay in it, and moving a region needs `edit` in it (P2).
- Field values live in the tree (ADR 0011, 12 §3.3).

## What is hidden

- **Confidential regions.** A region whose content, and optionally title, only principals with a read grant may see. Proposed as a third value of the region policy, `confidential`, where grants convey `view` explicitly. With no matching grant a reader gets nothing of the region except a placeholder, unless they hold `manage`.
- **Hidden field values.** A field whose value only some principals may read. The reserved `sensitive` attribute (12 §3.2) becomes that rule. Proposed readers: the field's assignee role, users with `manage`, and principals named by a grant.

Which of these is in version 1, and their exact rules, are for S12 to settle and the owner to confirm.

## Decision (proposed)

Keep one document and one log. The server never sends a reader anything they may not read. Instead each reader works on a **projection**:

1. **Projection.** For a set of hidden scopes, the projection of a document replaces each hidden region with a `hidden_region` atom (carrying its identifier and, if allowed, its title). It replaces each hidden value with an empty value and a redaction marker. Readers with the same hidden set share projections (a *visibility class*).
2. **Content.** Content reads, checkpoints sent to clients, catch-up and resets all carry the projection for the reader's visibility class.
3. **Sync out.** For each stored commit and each visibility class, the room computes one replacement step between the projected documents before and after: the "diff step", from the first to the last differing position. A commit that changes only hidden content gives an empty commit, which still advances the sequence number, so the protocol stays gap-free (G5). Projected documents are persistent structures, so the cost scales with the change and the number of the body's children, not with the size of the content. S12 measured it; a commit that does not touch hidden content is better sent as its own steps mapped to projected positions (change 4 below).
4. **Sync in.** A reader's commit is rebased in projected space over the diff steps since its base. It is then mapped to full positions through the projection map. Its slices may not contain hidden atoms: a reader cannot move or copy what they cannot see, and P2 already requires `edit` in a region to move it. The result then goes through steps 5 to 7 of 04 §5 on the full document, unchanged.
5. **Everything else per visibility class.** Presence positions are mapped, and presence inside hidden content is dropped. Comments anchored in hidden content are hidden. The divergence check (04 §13) hashes the projection. History, comparison and attribution are served as projections, behind the existing `minVisibleSeq` gate (07 §8). Search runs on the server over the projection, and on the client over what the client holds. Exports run as the requester (their projection), unless an operator with `manage` asks for the full document.
6. **Changes of access.** When a grant change hides or reveals something for a connected reader, the room closes the reader's channel. The reader's next open is a forced reload with the new projection, and unconfirmed work goes to recovered edits, as for any reload. (Changed by S12; the first version of this item sent a `sync.reset`.)

## Changes from spike S12

1. **View token.** `ch.opened` carries an opaque, keyed token naming the visibility class it serves, and the resume echoes it. A missing or different token forces a reload. Without it, a reader who lost access while disconnected could resume on the old projection: the server cannot know which projection a client holds. A DEP change (PRO).
2. **Changes of access** are a close and a forced reload (item 6 above).
3. **Content reads check the grants revision in storage**, or the control plane's notifications are delivered reliably. Otherwise a reader whose access was just revoked is served the hidden content while the room still holds the old grants. Commits are not affected: they are sent only after a write conditional on the grants revision.
4. **Mapped steps first, diff steps as the fallback.** A commit that does not touch hidden content goes to each class as its own steps, mapped to projected positions. This costs in proportion to the change and keeps each step's type, so selections and comment anchors map exactly. A commit that touches hidden content goes as a diff step.
5. **What a reader may not send.** Steps that touch a placeholder, slices that carry a placeholder or a redacted value, and changes to the value or default of a hidden field. The last rule is stricter than the permissions: an editor cannot change a value they cannot read. Changing `sensitive`, or a region's policy to or from `confidential`, needs `manage`.

## What leaks, and what does not

The content, title (when hidden) and values of hidden scopes never leave the server for a reader without access. That holds for messages, checkpoints, history, search results, exports and logs sent to clients. S12's oracle checks every message.

Two things remain visible:

- the existence and position of a hidden region, through the placeholder;
- the timing of commits that changed only hidden content, through empty commits.

If either is unacceptable, alternatives are noted under Open questions.

## Alternatives considered

| Alternative | Why not (for now) |
|---|---|
| Each confidential region as its own document with its own log, referenced from the main document | Strongest separation: no bytes and no timing leak. But cross-region operations, such as wrapping content in a new region, lose atomicity across logs. Numbering and cross-references need composition. The outcome check, history and restore become multi-document. It is a large change to ADR 0001, ADR 0009 and the CDM. Keep it as the fallback if S12 fails |
| Same-size scrambled placeholders (positions unchanged) | Leaks the length and structure of hidden content and the pattern of edits; too weak for confidential text and values |
| Client-side filtering | The client would receive the content; not a control |

## Consequences

Good:

- The log, the authority, the outcome check, history and restore keep one document and their current semantics. Read restrictions are a layer on the way out and on the way in.
- Readers without access never receive hidden content.

Bad:

- New machinery: projections, diff steps per visibility class, mapping of incoming steps, per-class caches, resets on access changes, filtered presence, comments, history, comparison, search and export.
- Every endpoint that returns content, and every message that carries steps or positions, must go through the projection. A single missed path is a leak, so S12 needs an oracle that scans every outgoing message.
- The editor shows placeholders that cannot be selected inside, and `fill` on a hidden value is impossible.

## Affected areas and stories

The design task touches every epic that reads or sends content. S12 lists the stories to add and the stories to change. These are known to assume full read access today: PRM-004 (criterion 5), FRW-001, FRW-002 and the field read endpoints (FRW, around line 1220), EXP-095 (custom parts hold every value), and UX's proofing and assistant ports (around line 996). Also every story about content reads, catch-up, history, comparison, attribution, activity, search, export and presence. Until S12 closes, no new story may assume that readers see the whole document.

## Open questions

- Whether region titles are hidden or shown, per region.
- Whether timing leaks from empty commits matter. If they do, empty commits can be batched or delayed for readers without access, at the cost of latency.
- Who may read a hidden value by default; whether hidden values appear in the sealed PDF for each participant; and what the evidence bundle shows.
- How suggestions and comments in hidden regions are reviewed.
- Whether owners always see everything, or whether a region can hide content even from some owners (separation of duties).
- Whether a reader may delete a field whose value they cannot read. S12 allows it under the full room's rules; deleting reveals nothing.

## Revisit when

S12 (SPK-029) shows that projections cannot be kept correct and leak-free, or that their cost is out of budget. The fallback is the separate-documents alternative.
