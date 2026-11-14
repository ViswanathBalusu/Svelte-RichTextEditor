# ADR 0031: Completing CDM 1: invariant codes, the footnote model, citations, projections and the S11 changes

**Status:** proposed, 2026-11-06. A maintainer's proposal from the phase 1b model packet (M1), for the project owner to review. It records every decision the packet took where 03, 12 or an earlier record is silent. The values live once in `packages/model/src/definition` and `packages/model/src/validate`; the generated tables are `spec/cdm/cdm-1.attributes.md`, `cdm-1.writer-support.md` and `cdm-1.violations.json`.

## Context

CDM 1 is still a draft (ADR 0018). The phase 1b stories ask for the rest of 03 as data and checks, for the field nodes of 12 §3, and for the read restrictions of ADR 0019. Three inputs arrived while the work ran: spike S1 decided the footnote evidence (CDM-001), spike S12 tested projections (CDM-053), and spike S11 named seven model changes for lossless Word files (ADR 0017).

## Decision

### 1. Violations and the invariant engine (CDM-013)

- Every violation carries its invariant, a stable snake_case `code`, the JSON Pointer `path` and the `nodeId` of the node it concerns (its own `id`, a definition's identifier, or the nearest enclosing one; null for the envelope). A code never changes its meaning. The list is published as `spec/cdm/cdm-1.violations.json`.
- Other packages add invariants through one interface: `registerInvariant()` for every call, or `invariants` in the context for one call. FRW's field invariants run through the same interface. A check declares its codes; one that throws or reports an undeclared code makes the document invalid with `check_failed`, because the authority refuses what it could not check.
- Context that invariants beyond the document need: `identifierChanges` (I2 "never changes": the identifier changes of the commit's attribute steps, with `copy` for a copy that gets its own identifier, as the authority already reads them) and `previous` (the document before the commit: the math gate runs only on LaTeX it did not hold). A change by replacement stays an open question (CDM-012).
- A required attribute that is absent is `attribute_missing`, not only a null one.

### 2. Where a problem belongs

| Problem | Invariant and code |
|---|---|
| `latex` longer than 4,000 characters; a grid of more than 63 columns | I7 `limit_exceeded` |
| A link scheme outside the allow-list | I9 `link_scheme` |
| An extension's name, payload or fallback outside its grammar; no fallback (a block needs a picture or a text, an inline a text) | I12 `extension_envelope`, `extension_fallback` |
| A field `value` or `default` of the wrong shape, a JSON number in a number field included | I15 `value_type`: the field invariants check values whole, so a fill gets `field_invalid` (12 §4.2) |
| `headerRows` above the number of rows | I6 `header_rows` |
| A numbering level the definition does not have | I4 `numbering_level_missing` |
| A `node:` target that is not a heading, a numbered paragraph or a caption (a paragraph holding a `seq` field) | I4 `field_target_unresolved` |
| A target in the wrong form for its kind (`ref`: `bookmark:`, `node:`, `eq:`; `styleRef`: `style:`; `formValue`: `field:`), a missing one, or a target or sequence name on a kind that takes none | I11 `field_target_form` |
| Table properties on a style that is not a table style | I11 `table_property` |
| `minLevel` above `maxLevel` | I11 `toc_levels` |
| Two options of one choice field with one identifier | I11 `duplicate_option_id` |
| One suggestion identifier with two users | I2 `suggestion_user` |
| `fmt.before` not `{ marks, attrs }`; on text, attributes recorded; on a block, marks recorded or attributes other than `style`, `align`, `numbering` | I11 `fmt_before` |
| A table in a story or a footnote; a footnote in a footnote or a caption | I10, checked by `validate()` as well as by the content expressions |

A `seq` field without a name stays valid: it counts in no sequence (the numbering semantics of CDM-042 already say so).

### 3. The footnote content model (CDM-001)

`footnote` holds `paragraph+`, exactly one paragraph in version 1 (I1 `footnote_paragraphs`). Spike S1 (`docs/spikes/2026-11-06-s1-prosemirror-shadow-root.md` §5) found that under the drafted `note_inline*` text typed after a line break at the end of a footnote goes before the break in Chromium, Edge and WebKit and the break is lost in Firefox, because the sub-editor's root is not a textblock; under `paragraph+` all four browsers are correct, and lifting the limit later needs no new major version. Because a paragraph admits any inline node, `validate()` refuses a footnote inside a footnote (I10) instead of the content expression. The `note_inline` group is gone.

### 4. Canonical form and fixtures (CDM-010, CDM-011)

- `canonicalNode` and `canonicalEnvelope` refuse a number that is not an integer in the interoperable range with a `CanonicalizationError` naming the path. Member names are written as own properties, so `__proto__` stays data.
- The fixtures (`packages/model/fixtures/canonical`) store each input, its exact bytes (`.jcs`) and their SHA-256, with `canonicalFormVersion`. The generator refuses a changed output for an unchanged input under the same version: a change of the rules is declared by raising `CANONICAL_FORM_VERSION`. An independent implementation in Python (`packages/model/conformance/canonical.py`) reads only the published ProseMirror schema.
- The JSON Schema carries each attribute's `default` as an annotation, so other implementations know what the canonical form omits.

### 5. Fields (FRW-001 to FRW-006)

- The kind `attachment` is refused in version 1 (12 §3.2 reserves it).
- I15 gives the same verdict as `checkFieldValue` of `@docedit/rules` (ADR 0030 §6): text and formula values are strings of at most 4 KiB, numbers decimal strings of at most 64 characters, dates ISO calendar dates. The entry checks and presets of FRW-004 are the rules package's alone.
- A mirror prints a checkbox as ☒ or ☐ and a choice as its option's label (`valueText`).
- `numbering_def.levels` needs one to nine levels.

### 6. Sources, citations and bibliographies (CDM-052)

- `source_def` in `defs` (after `rule_def`), one attribute per CSL variable (`kind` is the CSL item type; `title`, `authors`, `editors`, `issued`, `accessed`, `containerTitle`, `publisher`, `publisherPlace`, `edition`, `volume`, `issue`, `pages`, `number`, `doi`, `url`, `isbn`, `issn`, `language`, `note`, and `extra` for other CSL variables by their CSL names). Dates are EDTF level 0 strings.
- `citation`: an inline atom with `items` (source, prefix, suffix, locator, CSL locator label), `mode` (`normal`, `narrative`, `suppressAuthor`) and `cached`. `bibliography`: a block atom with `include` (`cited`, `all`). Every cited source exists (I4).
- They are core, not a feature: both writers support them (biblatex; Word citations and the sources part), and a feature name would need a protocol entry for no reader that lacks them.
- `settings.citationStyle` offers `authorYear` (default) and `numeric` as the house class's styles (A3). This is for the owner and EXP to confirm; whether the editor renders through CSL or through biblatex styles stays open.

### 7. Projections (CDM-053)

- The region policy gains `confidential` (ADR 0019).
- `hidden_region` is a projection-only node: an atom with only `id` and `title`, no `ext`, selectable whole, allowed only as a direct child of `body` in the projection schema (`projectionSchema()`, published as `spec/cdm/cdm-1.projection.json`). The spike's version sits in the `block` group; this one is narrower.
- The redaction marker is any object whose `redacted` member is `true` (`REDACTION_MARKER` is `{ "redacted": true }`). A stored document or commit with either is I1. Who may read a value (the read rule of FRW-088) stays ADR 0019's proposal.

### 8. Writer support (CDM-046)

Rows that 03 §10 does not give are proposed as supported by both writers: `smallCaps`, `allCaps`, `hidden`, `link`, `break`, the `date` and `title` field kinds, gutter, page numbering and the watermark; `styleRef` is partial in LaTeX. `preserved_def` is not applicable to LaTeX. EXP confirms or corrects them.

### 9. Pasted definitions and new documents (CDM-023, CDM-016)

- A brought definition with a new identifier is added; one whose identifier the target has is dropped and the target's wins. A reference that resolves nowhere is dropped: a style becomes null (the default style), a character-style mark or a cited source is removed, numbering becomes null.
- `newDocument()` gives every built-in style its structure (kind, name, `basedOn`, heading levels) and no formatting.

### 10. The model changes of spike S11 (CDM-051)

Made: inline atoms carry formatting and suggestion marks as text does; `origin` (fragment and SHA-256 of the modelled attributes, feature `preserve`) on `image`, `equation`, `field`, `footnote`, `anchor` and `citation`; element trees 12 deep, 32 KiB on `style_def`, registered short prefixes for the OOXML namespaces with Clark notation only for others; `preserved_def` and `{ "ref": id }` trees; `preserved_inline.tree` for small markers. Not made: nullable `page_setup` defaults (it changes what an omitted value means and the canonical bytes of every page setup ProseMirror writes) and import labels as suggestion users (an exception to the authority's P4 check). Both are left for scheduling.

## Consequences

- The ProseMirror schema hash, the JSON Schema and the types changed twice in one day; the authority's engine fixtures, the protocol's artifacts, the corpus, the engine, export-latex and export-docx had to follow.
- Every implementation of `validate()` reports the same codes, and the fixtures of `packages/model/fixtures/invariants` pin them.

## Open questions

- Node marks: ProseMirror cannot limit them to paragraphs, rows and tables; `validate()` does (CDM-008, owner).
- Whether "present in every document" (03 §4.1) makes a missing built-in style I1 (CDM-016, owner).
- How a commit that replaces a node is told from one that deletes it and creates another (CDM-012).
- The data source of the `title` field, the semantics of `styleRef`, and the citation styles (sections 6 and 8).
- The release check of CDM-048: no release of CDM 1 exists to compare attribute sets against.
