# ADR 0388: Offsets of every layout node, subtree sharing, and numbers the flow prints

Status: proposed (lane w1, 2026-11-18). Stories: FE-078, FE-077, FE-064.

## Context

02 §9.2 says every node of the layout tree records the block identifier and the document offsets it
covers. Paragraph fragments and lines did. Tables, rows, cells, boxes and pages did not, and the
earlier lanes left the choice open (ADR 0304, item 2). FE-078 criterion 4 asks for the same object
for an unchanged subtree in two successive trees. FE-077 left open whether the flow prints computed
`seq` and `ref` text. None of this is in the owner's decisions of 2026-11-15 and 2026-11-17. The
defaults below are the lane's reading of the spec and are open to the owner.

## Proposal

1. **Offsets are inside the top-level block.** They use the same coordinates as the `from` and `to`
   of a paragraph fragment inside its own block. A CDM node is 1 position when it has no content
   and 2 positions plus its content otherwise (the rule of `inlineSize` in `flow.ts`, and of
   ProseMirror).
2. A **box** (figure, display equation, preserved or extension block) covers 0 to the size of its
   content, or 0 to 1 for an atom. A **table** covers 0 to the size of its rows. A **row** and a
   **cell** cover their own range inside the table's content. A cell's range includes its own two
   positions. A row that is cut across pages keeps the whole row's range in each piece, because a
   cut at a paragraph boundary has no offset of its own at row level.
3. A **table fragment** covers from its first row's start to its last row's end. A **page** records
   `start` and `end`, each a block identifier and an offset: where its body's first fragment starts
   and where its last ends, or null for a page with no body fragment. Headers, footers and footnotes
   are not part of it.
4. The fields are optional in the types, so that a tree built by hand (a test, a spike adapter)
   still type-checks. `layoutFlow` sets them on every node it makes.
5. **Subtree sharing.** `shareSubtrees(previous, next)` gives the new tree the previous tree's
   objects wherever the content is equal, and makes equal parts of one tree one object. The
   incremental layout applies it to each tree it returns. A block that moved has a new fragment but
   keeps its line objects, because lines are placed relative to their fragment. This is the
   identity a painter uses (FE-092).
6. **Numbers the flow prints (FE-077).** A `seq` or `ref` field prints the text the shared numbering
   algorithm computes, over its cached text. A numbered equation block carries its number in
   `FlowBox.number`, without parentheses. `toFlow(envelope, { effects })` takes the counter effects of
   a projection's hidden regions, so a projection prints the full document's numbers (owner decision
   11).
7. **Equation sizes (FE-064).** The engine takes an optional `MathMeasurer`. Where it answers `null`
   the stand-in stays. The element's measurer draws with KaTeX in a hidden box in the shadow root. A
   `FaceArrivals` source for the math faces must load them (`{ load: true }`), because a face that no
   equation uses is never loaded by drawing.

## Consequences

Stored serialisations of layout trees gain the new fields, so any golden file or digest of a tree
changes once. Painters and hit testing may read the ranges. The page range is derived from the
fragments and is not a second source of truth.
