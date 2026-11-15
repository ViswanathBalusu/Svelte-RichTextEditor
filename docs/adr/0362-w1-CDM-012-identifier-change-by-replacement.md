# ADR 0362: An identifier changed by replacing a node around its content (CDM-012, criterion 6)

**Status:** proposed, 2026-11-15. Prepared by lane w1 (epics FE, CDM, WASM). It reads an open question of 03 §8 (I2) in the narrowest way that the steps themselves support. The owner may widen or reject it.

## Context

I2 says that a non-null `id` never changes. CDM-012 criterion 6 asks that a change "by an `attr` step or by replacement" is reported. The authority already refuses a change by an `attr` step (`packages/authority/src/invariants.ts`, judged by the commit's outcome, ADR 0050 item 1).

A replacement is harder. A `replace` step that removes one node and inserts another says nothing about whether the second is "the same node": 03 does not define sameness across a replacement, and deleting a paragraph and typing a new one must stay allowed. ADR 0031 section 1 left this open.

One replacement is not ambiguous. `setNodeMarkup` makes a `replaceAround` step that removes the opening and closing tokens of one node, keeps its whole content in place as the gap, and inserts the tokens of one new, empty node around that content. Nothing of the node but its markup (type, attributes, marks) is replaced. The editing core's own guard (`packages/engine/src/guard.ts`, P5) cannot be relied on, because a client that is not ours can send this step.

## Decision (proposed)

1. A `replaceAround` step is a change of markup of the same node when all of these hold: the gap is the whole content of one node (`gapFrom = from + 1`, `gapTo = to - 1`, and the node at `from` ends at `to`), the slice is one closed, empty, non-leaf node, and `insert` is 1. For such a step the identifier of the node at `from` before the step and the `id` of the inserted node are compared exactly as the old and new values of an `attr` step on `id` are.
2. The outcome rules of ADR 0050 item 1 apply unchanged: the change is refused with `invalid_op` (I2) only when the node is still in the commit's result with another identifier and no node of the result holds the old one.
3. Every other replacement is a removal and a creation, not a change of identifier: a `replace` step, a `replaceAround` step of any other shape (wrapping, lifting, a change of several levels), and the replacement of a leaf node. An identifier removed this way is simply gone; for a region, I3 already forbids its reuse.

## Consequences

- `model.validate()` is unchanged: it still takes the identifier changes from its caller (`identifierChanges`), and the authority still decides I2's transition before it calls the validator.
- A client that wants to change a node's type and keep its place must keep its `id`, which is what the editing core does.
- A hostile client can still drop an identifier by deleting a node and inserting a copy with a fresh `id` in one `replace` step. That is a deletion by the rules above, and it needs the permission to delete the node. If the owner wants this refused as well, 03 must first say when two nodes across a replacement are the same node.

## Evidence

`packages/authority/test/invariants.test.ts`: "refuses changing the identifier by replacing the node around its content (I2; ADR 0362)" and "accepts a replacement around the content that keeps the identifier, or that a later step removes".
