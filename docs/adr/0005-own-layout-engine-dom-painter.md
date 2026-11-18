# ADR 0005: Own layout engine with a DOM painter, reached in two stages

**Status:** proposed, 2026-09-18.

## Context

A Word-like experience needs real pages while editing (R1). Research on 2026-09-18 found that every product verified to have true pagination runs its own line-breaking and page-layout engine:

- Google Docs has had its own layout engine since 2010 and moved to canvas rendering in 2021.
- ONLYOFFICE paints to canvas with its own layout and font engines.
- SuperDoc and Eigenpal compute layout without the DOM and paint absolutely positioned DOM; both keep a hidden editable element for input.
- CKEditor's pagination only draws predicted break lines and supports Blink browsers only. Tiptap's Pages extension describes itself as a layout overlay and can loop forever on blocks taller than a page.
- CSS fragmentation exists only for multi-column layout and printing, and Paged.js re-chunks the whole document on every change.

Owning layout means owning the caret, selection, hit testing, input methods and accessibility.

## Decision

The end state (the page view, called stage B in the first draft) is a layout engine with no DOM dependency, a painter that draws absolutely positioned lines into virtualised page boxes inside the shadow root, a caret and selection overlay computed from layout data, and a hidden `prosemirror-view` as the input bridge, with the EditContext API as an enhancement where it exists.

The first releases (the web view, called stage A in the first draft) use a visible `prosemirror-view` and an authoritative PDF preview. The layout engine starts only after the vertical slice is complete (11).

The painter targets the DOM and not canvas.

## Consequences

Good:
- Page fidelity is possible at all, including split tables, footnotes and page sections.
- Painted text is real text: selectable by assistive technology through the bridge design, searchable, and sharp at any zoom.
- A canvas or PDF painter can be added later behind the same layout tree.
- The product is usable before the layout engine exists.

Bad:
- The largest and least predictable piece of work in the project.
- Native spellcheck, mobile selection handles and browser find-in-page are lost in the page view and need replacements.
- Text measurement differs slightly between browsers, so collaborators can see different page breaks between compiles. Reconciliation with the LaTeX compile (09, section 7) bounds this.

## Alternatives considered

| Alternative | Why not |
|---|---|
| One editable element with spacers between pages | Browser line breaking differs per engine; split tables, footnotes, columns and per-section page sizes are impractical |
| One editable element per page | Selections cannot span editing hosts; splitting paragraphs across hosts corrupts the model |
| CSS paged media or Paged.js | Not available for live editing |
| Canvas painter | Needs a parallel accessibility tree and its own text rendering quality work |
| Server-side layout (as Collabora does) | A round trip per keystroke and a server session per document; wrong for an embeddable component |
| EditContext only | Ships in Chrome and Edge only as of 2026-09; WebKit has no plan |

## After the first review (2026-09-18)

- Pagination is something every competitor already has; it is not this product's differentiator, yet it is the largest item. The page view is therefore gated on customer evidence at the end of phase 2.
- The continuous editing surface is a permanent view ("Web layout"), not a stopgap, and must not pretend to show pages. Real pages to read come first from the typeset PDF and then from a read-only painter, which needs the layout engine but none of the input work.
- Spike S7 evaluates driving an existing permissively licensed layout core (Eigenpal's Apache-2.0 core, canvas-editor, Docen) before any layout engine is written. The first draft of this record did not consider that.
- The hidden input element was given three conflicting jobs: whole-document accessibility tree, input-method anchor at the caret, and keyboard handling. `prosemirror-view` also has no EditContext support, so that would be a second input pipeline. The design of the bridge is now the subject of spike S9.
- Canvas gives no control over ligatures anywhere and none over kerning in Safari, so the painter follows canvas defaults, and spike S5 also evaluates measuring from font files with HarfBuzz.

## Where layout and measurement run (FE-075, 2026-11-18)

The layout engine and the text-measurement kernel run in one worker from the start, and the tree crosses to the main thread as plain data, in slices; the main thread runs the same engine as a fallback. This answers the open question of 02 §15. The grounds, the measurement of the crossing and the way back are in [ADR 0390](0390-w1-FE-075-layout-placement.md), which is proposed: the owner has not answered the question in so many words.

## Revisit when

EditContext ships in all supported browsers, or the measurements of spike S5 show that canvas measurement cannot match painted text closely enough.
