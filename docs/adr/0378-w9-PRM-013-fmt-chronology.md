# 0378 PRM-013: the baseline under several users' formatting suggestions

**Status:** option 2 chosen by the owner (decision 79, `docs/owner-decisions-2026-11-15.md`); applied 2026-11-18, lane w9. The remaining gap is recorded under Decision.

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

## Decision (2026-11-17, lane w9)

The owner chose option 2 (`docs/owner-decisions-2026-11-15.md`, decision 79: "recorded against the baseline when the first suggestion is made"). Applied as follows.

- `suggestFormat` (`packages/engine/src/suggestion-edit.ts`): a run that already carries another user's `fmt` gives the new `fmt` that mark's `before`. Every `fmt` of a run then records the baseline, so `headOf` gives the same baseline in any mark order. `headOf` itself is unchanged for that purpose.
- Consequence for the engine: rejecting one user's `fmt` alone puts back the baseline, not the run's formatting before that user's change. The other user's formatting goes with it while that user's `fmt` mark stays. This is the trade-off the option names.
- Consequence for P4 (ADR 0050 item 2): the check rejects the submitter's own suggestions and compares the scope before and after. With a copied `before` that rejection no longer restores the run's formatting before the submitter's change, so a second user's `fmt` over a run holding another user's `fmt` was refused. `headOf` (`packages/authority/src/permissions/suggestions.ts`) now leaves the formatting of a run out of a comparison that keeps another user's `fmt`. The baseline comparison (every `fmt` rejected) still compares it.
- Remaining gap, not decided here: a suggester who changes the formatting of a run that carries another user's `fmt`, without adding their own `fmt`, is not refused by that comparison. The baseline is unchanged (rejecting every suggestion restores the plain run), and the other user's marks are unchanged. Closing the gap needs the check to know the run's formatting before the commit, per character, for runs that hold another user's `fmt`. It is a P4 design change and is left to the owner.
- Documents that already hold `fmt` marks with differing `before` values (made before this change) keep the old behaviour: `headOf` takes the last one.

## Default used until decided

None (superseded by the decision above). Nothing is changed in `headOf`: no option is better than the present behaviour for every case, and one that looks right in the example above is wrong in another (text that began bold, formatting removed by one user and added by another). PRM-013 criterion 4 stays unticked. The owner (or the CDM owner) decides.
