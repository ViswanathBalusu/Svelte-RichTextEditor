# 0366: The bibliography in the web view repeats the converter's rules (lane w1, FE-140)

- Status: proposed
- Date: 2026-11-15
- Story: FE-140 criterion 2

## Context

FE-140 criterion 2 asks the web view to list the cited sources in the chosen style and to follow the citations. The second review (SR-M20) asks that the editor and the PDF show the same bibliography. The LaTeX converter already generates the citation texts and the bibliography itself, in the two styles of `settings.citationStyle` (`packages/export-latex/src/citations.ts`; ADR 0046, proposed), so there is no CSL engine and no biblatex output to differ from.

`@docedit/engine` does not depend on `@docedit/export-latex`, and lanes may not add dependencies in this run.

## Decision (proposed)

1. The web view generates the entries with the same rules as the converter: numeric lists the sources in the order of first citation with `[n]`; author and year sorts by first author, year and title and adds `a`, `b`, … to equal labels; `include: all` adds the uncited sources. The entry text (names, year, title, container, volume, pages, edition, number, publisher, address) is built the same way.
2. Until the two packages can share one module, the rules are repeated in `packages/engine/src/bibliography.ts`. This is a copy, and a change to one side must be made on the other.
3. The entries are drawn by a node view from a node decoration (`packages/engine/src/view/bibliography-view.ts`). The list is one non-editable unit with the role `list`; each entry is a paragraph with the role `listitem`; italic runs are `i` elements; an address is text, not a link. Nothing is stored in the `bibliography` node.
4. An empty bibliography shows the text "Bibliography: no sources cited yet". The text is English only for now, as the other labels of the editing schema are.

## What should replace the copy

One of these, for the owner or the maintainers of the two packages to choose:

- move the generator into `@docedit/model`, which both packages already depend on; or
- make `@docedit/export-latex` a workspace dependency of `@docedit/engine` and import `computeCitations`.

Either removes the copy. A test that feeds one document to both and compares the entries should come with it; it cannot be written today without the dependency.

## Not covered

- The text of a citation in the web view is still its `cached` text or `[citation]`.
- The page view does not draw the bibliography (it is not built).
