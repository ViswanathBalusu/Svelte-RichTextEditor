# ADR 0009: Regions are block containers with stable identifiers; grants live outside the document

**Status:** proposed, 2026-09-18.

## Context

Owners must be able to let specific people edit only specific parts of a document (R3). The unit of permission has to be something the authority can evaluate cheaply and unambiguously for every step, that survives concurrent editing, and that maps to DOCX.

Prior art on 2026-09-18: Word has editable ranges (`w:permStart` and `w:permEnd`) and locked content controls, and its own specification says they are not a security feature. Syncfusion has editable regions per user or group. CKEditor's restricted editing requires all connected users to be in the same mode, so it cannot express per-user regions. Google Docs has document-level roles only; Google Sheets' protected ranges are the closest server-enforced analogue. SuperDoc imports Word's ranges and has a locked "document section" built on a content control.

Options for the unit:

| Option | Assessment |
|---|---|
| Range markers anchored to positions | Arbitrary inline ranges and faithful to DOCX, but insertions exactly at a boundary are ambiguous, deletions can orphan markers, and the server must reason about positions for every step |
| A `regionId` attribute on each block | Simple, but splitting and pasting clone it, and whoever can edit the block can change it |
| A structural container node | Membership is a fact about a node's parents. Behaves like a table cell. Maps to a block-level content control. Block-aligned only; splitting and merging are explicit operations |
| One synchronised document per region | The only boundary a CRDT can enforce; heavy for everything that crosses regions |

## Decision

A region is a `region` node: a direct child of the body, not nestable in version 1, isolating, with an immutable identifier, a title and a policy (`inherit` or `restricted`). Everything outside regions is the body root and follows the document-level role.

Grants, region states and leases are stored by the document service, never in the document. The token carries the document-level role and group membership; region grants are looked up on the server so they can change while people are connected.

Creating, deleting, moving, splitting and merging regions, and changing a region's attributes, require the `structure` capability plus `edit` in every region affected. Steps may not straddle a region boundary.

## Consequences

Good:
- The authority's check is a range-to-scope lookup plus a capability test.
- A restricted region is protected even from document-level editors, including from deletion.
- Per-region history is a filter on the scopes recorded with each commit.
- Clean DOCX export as content controls plus editable ranges.

Bad:
- No inline protected ranges (a single sentence inside a paragraph cannot be a region). Imported inline ranges are treated as locked and reported.
- Operations across regions are clamped or split by the editor.
- A person who may edit only regions cannot change page setup, styles or numbering definitions.

## Alternatives considered

See the table above. Inline ranges could be added later as a second scope type, because the authority already validates every step; the cost is the boundary ambiguity described above.

## After the first review (2026-09-18)

- Regions cannot express "Name, Date, Signature" blanks in a sentence or a table cell. Those are form fields, a second kind of scope (`field:<id>`) with its own capability, defined in [ADR 0011](0011-fields-in-tree-and-fill-capability.md). Regions remain the unit for blocks of free text.
- The authority no longer decides from the shape of a step which region it touches. It compares the document before and after the commit, scope by scope (07, section 5.1). Attribute and mark steps have empty position maps, so the range-based rule in the first draft could be bypassed.
- Changing a region's `policy` needs `manage`, so an editor cannot lock colleagues out by flipping a region to `restricted`.
- A change to a style, numbering definition or page setup needs rights in every region that uses it, so protected text cannot be defaced through its style.
- Region identifiers are never reused, and a deleted region's grants are retired with it.
- Approvals are bound to a sequence number and a content hash and are recorded in the log.

## Revisit when

Inline protected ranges or nested regions become a requirement, or read restrictions per region are needed (which is a larger change than this decision). Read restrictions became a requirement on 2026-11-06; ADR 0019 keeps regions as containers and hides them through projections.
