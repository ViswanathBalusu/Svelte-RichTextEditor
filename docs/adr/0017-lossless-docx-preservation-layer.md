# ADR 0017: Lossless DOCX round-trip through a preservation layer

**Status:** proposed, 2026-11-06. Follows the project owner's decision on assumption A2 on 2026-11-06: Word files must round-trip without loss. Revises [ADR 0004](0004-semantic-document-model.md), whose "revisit when" condition this decision met.

Spike S11 (SPK-028) ran on 2026-11-06 (`docs/spikes/2026-11-06-s11-lossless-docx.md`). On 78 real Word files with recorded licences, every part came back byte-identical without an edit (R0). Every applicable scripted edit kept the rest of the file (R1). Word opened the exports without a repair prompt, except for one fuzzing file whose original already prompts. The design holds, with the changes under "Changes from spike S11"; it stays proposed until they are made and the owner has decided the second review's SR-C1 and SR-C2.

## Context

Until now the spec assumed DOCX was best-effort (00 §5, A2). The owner decided that lossless round-trip is required. In the same decision the owner confirmed A4: the CDM document, not LaTeX source and not the Word package, stays the stored source of truth. A3 also stands, so PDFs are still typeset by one house class.

00 §5 described what A2 would cost: "the model must retain the original package parts and unknown XML, and the layout engine must chase Word's layout behaviour". The editors that reach Word fidelity keep the original package so that unknown content survives a save (ADR 0004, Context).

The rest of the design limits where preserved data can live:

- The authority checks every attribute against a grammar (invariant I11), so that hostile strings never reach the exporters or the editor's styles.
- Comments already live outside the document as ranges that the service maps through every commit (ADR 0015).
- Assets are immutable, content-addressed and attached to documents (06 §4.4).
- Node identifiers never change (invariant I2). Split, copy and paste create fresh identifiers (03 §9).

## What "lossless" means

This is the proposed contract. Spike S11 (SPK-028) tests it on a corpus of real Word files before `cdm: 1` is frozen.

| Level | Promise |
|---|---|
| R0, untouched | A file that is imported and then exported without any edit has the same parts and relationships, and every part is byte-identical. Only the ZIP container may differ |
| R1, edited | After edits: (a) parts that no edit affected are byte-identical; (b) in parts that changed, every element outside the edited content is unchanged, compared as canonical XML; (c) an edited element keeps the attributes and child elements the CDM does not model, unless the edit removed the element; (d) content the CDM cannot represent is still there, in the same place relative to its neighbours, unless someone deleted or moved it |
| R2, modelled | What the CDM models (text, styles, numbering, tables, fields, notes, sections, suggestions, regions) is written so that Word shows what the editor showed. This is what EXP-090 to EXP-096 already require |

Not promised:

- a byte-identical ZIP container;
- that Word paginates the file as the editor or the PDF does (see "Layout" below);
- that identity-bound values, such as Word's paragraph identifiers and revision-session identifiers, survive copy and paste: copies get fresh values, as copies in Word do;
- preservation of anything inside a document pasted from another document, unless the fragment assets come with it (as for images).

## Decision

Keep the semantic CDM of ADR 0004 and add a **preservation layer** in three parts.

### 1. Source package and source map, outside the document

An import stores the original file as an immutable asset (EXP-108). It also stores a **source map** as an immutable asset. For every node the import created, the source map records the node's identifier, where its original element is in the package, and the canonical hash (03 §2) of the node as imported.

The DOCX writer uses the original package as its template:

- Parts it does not need to regenerate are copied byte for byte.
- A node whose current canonical hash equals its import hash is unedited, and its original element is copied verbatim.
- Identity-bound values (paragraph and text identifiers, revision-session identifiers) are kept only through the source map, so they are never duplicated by copies.

This gives R0, R1 (a) and R1 (b) without putting XML in the document.

### 2. Preserved properties, inside the document

Attributes and child elements of a modelled element that the CDM does not model are kept in the document. Examples are text effects in run properties, conditional table formatting, and unknown children of section properties. Kept in the document, they travel with the content through edits, splits, copies, history and restore, as Word's own properties do.

- On block and definition nodes they go in a new attribute, `preserved`. It defaults to null.
- On text they go in a new mark, `preserved`.

Both hold a JSON element tree, never XML text:

- element names in Clark notation (`{namespace-uri}local-name`), attribute values and text as strings;
- depth at most 8 and at most 16 KiB of canonical JSON per attribute (targets to confirm in S11).

The writer serialises the tree with its own escaping. A hostile value therefore cannot inject markup, and the authority can check the grammar without an XML parser.

### 3. Preserved content, inside the document as atoms

Some content cannot be represented by the CDM at all:

- text boxes, shapes, charts, SmartArt, embedded and linked objects, ink;
- nested tables, and floating pictures with text wrap;
- content controls the model does not map;
- alternate-content blocks without a usable fallback.

Each such piece becomes a `preserved_block` or `preserved_inline` atom. The atom refers to a **fragment**: an immutable asset attached to the document that holds the original XML and the parts it relates to (media, chart parts, embeddings). The atom also carries a label (for example "chart"), a fallback image or text, and a display size.

- The editor shows the fallback. People can select, move, copy or delete the atom as a whole. Nobody edits inside it.
- The LaTeX writer typesets the fallback.
- The DOCX writer puts the fragment back and renumbers its relationships.

The two atoms and the mark belong to a named feature, `preserve` (03 §11.1). A reader that does not know them refuses the document instead of dropping them (03 §2). The `preserved` attribute is part of the core schema, but it may be non-null only in a document whose `requires` lists `preserve` (invariant I1).

## Changes from spike S11

The S11 report gives each change with its evidence; in short:

1. **The contract.** R1 holds at block level, with the tolerance the report defines, and the elements dropped on purpose are listed: Word's spelling marks, its page-break cache, and the revision identifiers on runs of edited paragraphs.
2. **Source map.** It also records the material between blocks (passed on when a block is deleted), the section context of a paragraph that holds section properties, the shape of an original element the CDM cannot record, revision attributes by suggestion `id`, and the canonical-form and CDM versions. The map is about a third of a package's size and holds content hashes: it stays on the server (second review, SR-C1).
3. **Preserved properties.** An import self-check (when the compact residue does not reproduce the original, every original child is kept), and a write rule with a precedence table (for example, a theme colour is dropped when the value it overrides is edited). Identity-bound attributes (`w:rsid*`, `w14:paraId`, `w14:textId`) are named, and markup-compatibility attributes stay out of element trees.
4. **Preserved atoms.** Fragments are small ZIPs of the original XML, its namespace bindings, its relationships and its related parts. Run-level atoms keep their run properties inside the fragment. A complex field spans runs and paragraphs, so the editor moves a field's atoms as a unit.
5. **Size.** Preservation makes the corpus's documents 5.9 times larger on average, and a large file (a 12.6 MB `document.xml`) exceeds the 16 MiB limit of I7. Repeated trees and namespace URIs dominate. Before `cdm: 1` is frozen, the model needs shared residues (one definition per distinct tree) and short registered prefixes.
6. **Model changes** for CDM-051, listed in the report: marks on inline atoms or a rule that they carry none; an origin attribute (fragment reference and hash) on `image`, `equation`, `field`, `footnote` and `anchor` (SR-M10); grammar limits of depth 12 and 32 KiB for style definitions; shared residues; nullable `page_setup` defaults; import labels as the suggestion `user` (SR-M14); and element trees for small markers.
7. **Security.** The evidence supports the second review's SR-C1 (lossless exports and the original package only for readers who see the whole document) and SR-C2 (preserved data created only by import). Both are owner decisions 1 and 2 in `docs/owner-decisions-pending.md`.

## Layout

00 §5 said that lossless round-trip makes the layout engine chase Word's layout behaviour. That is true only if the editor must show imported documents paginated as Word paginates them. It is not implied by keeping the file intact:

- the PDF is still typeset by the house class (A3);
- the web view never shows pages (02 §7);
- the page view is gated on evidence (11 §5).

So this ADR does not decide it. Whether the page view must reproduce Word's pagination for imported documents is added to the gate decision (SPK-013).

## Consequences

Good:

- R0 and R1 are reachable without an OOXML-shaped model. The LaTeX writer, the authority, permissions and history do not change in kind.
- Unknown properties follow content as they do in Word.
- Unedited content is copied, not regenerated, so preservation does not depend on regenerating XML exactly.

Bad:

- New work in the model: two atoms, a mark, an attribute on many node types, a grammar for element trees, and invariant checks for all of them.
- The DOCX writer becomes a package patcher with a template, a source map and relationship renumbering. That is more work than the direct writer of 09 §11.
- Imported documents and their history are larger. S11 measures by how much.
- A preserved atom is a black box for search, the accessibility checker and comparison. The outcome check (07 §5.1) compares it as a whole, like any other atom.
- Pasting into another document keeps preserved content only if its fragment assets are attached there, as for images.

## Alternatives considered

| Alternative | Why not |
|---|---|
| An OOXML-shaped model with package retention (rejected in ADR 0004) | Still wrong for LaTeX output and for regions as block containers, and it would be a second model to keep in step with the first |
| Everything outside the document, in the source map only | Unknown properties are lost as soon as a paragraph is split, copied or retyped. Mapping run ranges through commits, as for comments, would cover typing but not splits and copies |
| Raw XML strings in attributes | Hostile markup would reach the writers and the editor. Checking well-formedness would need an XML parser in the authority, and the canonical form would depend on how XML is serialised |
| Re-import on export: diff the edited CDM against the original package | Needs unbounded heuristics, and fails on moves and splits |

## Open questions

- **Phasing.** Decided by the owner on 2026-11-06: the package-patching DOCX writer ships in phase 2, together with import (EXP-090 to EXP-096 and EXP-118 to EXP-120 moved from phase 4).
- **Corpus.** Which real Word files to collect for R0 and R1, under which licences, and the tolerance for R1 (b).
- **Regenerated elements.** Which elements are dropped on purpose because Word regenerates them, for example proofing marks, last-rendered page breaks and spelling state.
- **Comment parts.** Whether comment, people and extended-comment parts are preserved through the source map or regenerated from the thread store (ADR 0015).
- **Inline atoms without identifiers.** Equations, pictures and fields have no `id`, so the source map cannot track them. S11 decides whether `preserved` on them holds the original element together with a hash of the modelled attributes, so that an unedited equation is written back as its original Office math.
- **Page view.** Whether it must reproduce Word's pagination for imported documents (SPK-013).

## Revisit when

Spike S11 (SPK-028) shows that R0 or R1 cannot be met on the corpus with this design.
