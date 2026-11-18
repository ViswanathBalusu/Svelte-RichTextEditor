# ADR 0377: Links to headings, and the notice for a referenced target (FE-133)

Status: proposed. Lane w1, 2026-11-17. For the owner to confirm or change.

## Context

FE-133 criterion 3 says a link to a bookmark or a heading moves the caret there when it is followed. 03 §5 defines `link.href` as `http`, `https`, `mailto` or "an in-document target" (I9). The CDM's pattern for that target is `#` followed by 1 to 128 characters of `A-Za-z0-9_:.-`. Neither the spec nor the CDM says what names a heading. Headings are paragraphs whose style has an outline level (03 §4.3) and every paragraph has an `id`.

Criterion 5 says that deleting a bookmark that a cross-reference targets is explained and that the editor offers to show the references (I4). The core already refused the deletion (`referenceGuardPlugin`) but said nothing.

## Decisions (proposed)

1. An in-document target `#x` is read in this order: a bookmark named `x`, else the paragraph whose `id` is `x` when that paragraph is a heading (its style has an outline level through the cascade, the rule the outline uses). A bookmark wins when both exist. A paragraph that is not a heading is not a target. Definitions, stories and footnotes are not searched. No change is made to the CDM, the pattern or the validator.
2. Following a heading link puts the caret at the start of the heading. Nothing is added to the document. The editor does not write heading links itself; a host or a later dialog (UX) may offer the identifier.
3. A deletion refused because a `ref` field still names its target is recorded as a refusal with the reason `referenced`. Its `count` is the number of references and its `scopes` is empty. The shell says "a cross-reference still points to what you tried to delete" (singular or with the number) and offers "Show references". The sentence names neither the target nor the references (ADR 0019).
4. "Show references" selects one reference and moves to the next at each press, then returns to the first. References in a scope the reader may not view are skipped.

## Consequences

A heading link breaks when the heading's identifier changes, and identifiers are stable under edits (CDM-012). A heading link to a paragraph whose style loses its outline level stops resolving and the link does nothing. If the owner prefers a separate prefix for node targets (for example `#node:<id>`, as `ref` fields write them), the change is in `followInternalLink` and `headingPosition` in `packages/engine/src/links-bookmarks.ts`.
