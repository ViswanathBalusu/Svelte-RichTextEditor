# 0378 PRM-013: the baseline under several users' formatting suggestions

**Status:** proposed (2026-11-17, lane w9). Needs a decision before PRM-013 criterion 4 can be ticked.

## Context

The baseline of a scope is the content with every suggestion rejected (07 §5.2, P4). For `fmt` marks the baseline takes the formatting back to the recorded `before`. `headOf` (`packages/authority/src/permissions/suggestions.ts`) uses the `before` of the last `fmt` mark in the node's mark list; the engine does the same when it resolves suggestions (`recordedMarks`, `suggestion-resolve.ts`; ADR 0132 item 4).

When two users change the formatting of the same text, each `fmt` mark records the non-suggestion marks the run had when that user first changed it (`suggestFormat`, `packages/engine/src/suggestion-edit.ts`). The second user's `before` therefore already holds the first user's change. The baseline is the first user's `before`, so the order in which the marks were added matters.

The order is not available:

- Marks carry no time (03 §5: "Marks carry no time"; the time is the server time of the commit that introduced the identifier, which only the service indexes).
- Suggestion identifiers are random node identifiers, not time-ordered.
- The canonical form orders marks of one type by the RFC 8785 text of their attributes (ADR 0018, mark order), so the list a document is stored in is not the order of adding.

So "the last `fmt` mark" is an arbitrary one of them, and with two users the baseline can still hold the first user's change (alice bolds, bob italicises with `before` = bold: the baseline is plain text when alice's mark is taken and bold when bob's is). Because the check is run on canonical documents, two servers cannot disagree, but the baseline is wrong for one of the two orders.

The criterion "every user's marks are handled the same way and none excludes another's" is met for `ins` and `del` (the test in `packages/authority/test/suggestions.test.ts`). For overlapping `fmt` marks it is not.

## Options

1. **Record the order.** Give `fmt` a small ordinal (`n`, the number of `fmt` marks the run carried when the mark was added), and take the `before` of the lowest. A change to the CDM mark definition (CDM-039, `cdm1.ts`) and to the published schema hash.
2. **Record `before` against the baseline.** A second user's `fmt` on a run that already carries another user's `fmt` copies the run's earliest `before`. All `fmt` marks of a run then agree, and any one of them gives the baseline. Rejecting one user's change alone would no longer restore the state before that change.
3. **Derive the order from the history.** The service indexes the commit that introduced each identifier (03 §5). The authority is given only the document, so it would need that index as an input. Not available to the comparison in `P4` today.

## Default used until decided

None. Nothing is changed in `headOf`: no option is better than the present behaviour for every case, and one that looks right in the example above is wrong in another (text that began bold, formatting removed by one user and added by another). PRM-013 criterion 4 stays unticked. The owner (or the CDM owner) decides.
