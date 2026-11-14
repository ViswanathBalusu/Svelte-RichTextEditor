# ADR 0003: ProseMirror's model, transform and state as the editing core, behind the project's own API

**Status:** proposed, 2026-09-18.

## Context

The editing core needs a strict schema, changes that can be inverted and mapped over other changes, a mature undo history that works with collaboration, and documented behaviour inside a shadow root. Engines examined on 2026-09-18:

| Engine | Finding |
|---|---|
| ProseMirror | MIT. Model, transform and state are separate packages usable without the view. The view deliberately supports shadow roots, including `getComposedRanges`. Very active |
| Tiptap | MIT core over ProseMirror, but its pagination, DOCX conversion and tracked changes are paid products; open shadow-root issues |
| Lexical | MIT, pre-1.0. Shadow-root support arrived in June 2026, open roots only. Model and view are coupled |
| CKEditor 5 | GPL or commercial. Best model for Word concepts, but the needed features are commercial and the shadow-root request has been open since 2016 |
| Slate | First-party view is React only |
| A fully custom engine | SuperDoc moved to one in its version 2, after years on ProseMirror |

## Decision

Use `prosemirror-model`, `prosemirror-transform`, `prosemirror-state` and `prosemirror-history`. Use `prosemirror-view` for the web view, and as the hidden input bridge of the page view if spike S9 confirms that design. Hide all of it behind the project's document API (02, section 5.1). The CDM is defined independently and the ProseMirror schema is generated from it. ProseMirror's step semantics are part of the `pm-steps/1` engine definition.

## Consequences

Good:
- Invertible, mappable steps are exactly what a server-authoritative log needs.
- Years of browser workarounds for input and selection come with the view.
- Ports of the model and transform packages exist for .NET and Python, which helps backends in other languages.

Bad:
- ProseMirror has no first-class ranges that cross blocks; comments and bookmarks use paired anchor nodes.
- Step semantics are defined by a library. The engine identifier pins them, and the conformance kit carries fixtures.
- If the model outgrows ProseMirror, the core must be replaced. The API boundary and the independent CDM keep that possible.

## Alternatives considered

See the table above. A fully custom engine is the long-term escape route, not the starting point.

## After the first review (2026-09-18)

- ProseMirror cannot create or fill nodes that have a required attribute, so block identifiers default to null in the editing schema and are checked at the end of a commit.
- Definitions and stories share the document with the body, so standard commands such as "select all" would reach them. They are isolating and not selectable, body commands are scoped, and headers, footers and footnotes are edited in sub-editors whose steps are mapped onto the one document.
- ProseMirror drops attributes it does not know and throws on node types it does not know. Forward compatibility therefore uses an `ext` attribute on every node and a `requires` list on the document (03, section 11).
- `prosemirror-view` has no EditContext support. Using that API would be a second input pipeline, not an enhancement.
- The standard table commands know nothing about suggestions, so the project writes its own.
- The exact release of prosemirror-transform is pinned in the engine definition, and the generated schema is a normative artifact, because applying a step depends on both.

## Revisit when

The model needs something ProseMirror cannot represent without distortion (for example independent stories with their own selections), or the input bridge proves unworkable in the page view.
