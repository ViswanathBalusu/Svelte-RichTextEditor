# Spike S11: lossless DOCX round trip on real Word files

**Status:** spike result, 2026-11-06, SPK-028; not reviewed by the project owner. It takes account of the second review's findings SR-C1, SR-C2 and SR-M10 to SR-M19 (`docs/review/2026-11-06-second-review.md`), which the owner has not decided.

## Question

Does the preservation layer of [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md) round-trip real Word files without loss? The ADR's contract has three levels: R0 (untouched: every part byte-identical), R1 (edited: what the edits do not reach is unchanged, and edited elements keep what the CDM does not model) and R2 (modelled: Word shows what the editor showed). Its mechanisms are a source package and source map outside the document, preserved properties inside it (the `preserved` attribute and mark, JSON element trees in Clark notation), and preserved atoms that refer to fragment assets.

## Answer

Yes for R0 and R1, on all 78 corpus files, with changes to the ADR and to the model (listed at the end).

- **R0:** 78 of 78 files. Every part of every file comes back byte-identical, and so do the compressed bytes. The writer patches every modelled part even when nothing changed, so this also shows that the patching is exact.
- **R1:** all 263 scripted edits that applied pass (typing 60, splitting 57, deleting a block 56, restyling 59, moving a preserved atom 31). A stress test that regenerates every paragraph of every file from the model and its preserved data passes on 78 of 78.
- **Word:** Word for Microsoft 365 (16.0 build 16.0.20527) opened 492 of 497 files without a prompt: 78 originals, 78 R0 exports, 263 R1 exports and 78 fully regenerated exports. The 5 that prompted are all `poi/deep-table-cell.docx`, a fuzzing file with 5,000 nested tables whose original already prompts. LibreOffice is not installed on the spike machine, so it was not checked.
- **`validate()`:** every imported document is valid, with `preserve` in `requires` and every asset reference checked (I4).

The design holds, but four results change it:

1. **Clark notation and repetition make preserved data large.** Over the corpus the CDM is 5.9 times larger with preservation than without (2,158,902 against 367,190 bytes of canonical JSON). On a large real document (12.6 MB of `document.xml`) it reaches 54.0 MB and fails I7's 16 MiB limit; 67 % of the characters are namespace URIs, and its 37,101 element trees hold only 964 distinct values (2.0 MB).
2. **Inline atoms cannot carry marks in the CDM.** `validate()` refuses any mark on a node other than text, except suggestion marks on paragraphs, rows and tables. Run properties of tabs, breaks, pictures and preserved atoms, and tracked changes of anything but text, therefore have to live elsewhere. The prototype keeps them inside the atom's fragment or tree.
3. **The element-tree grammar is too shallow for the original XML of inline atoms.** None of the 12 inline pictures fits depth 8 (median depth 9, maximum 14), and 2 of 11 equations exceed depth 8 or 16 KiB. This settles SR-M10's question against storing original XML trees on atoms: the prototype stores a reference to a fragment and a hash of the modelled attributes instead, and that works.
4. **Two mechanisms the ADR does not name are needed:** gaps (markers between blocks, kept in the source map by byte range) and a lens rule for properties (an import self-check plus a write rule with a precedence table), described in "Changes ADR 0017 needs".

## What was built (kept, not throwaway)

All in `packages/export-docx` (`@docedit/export-docx`), a universal package: lib ES2023, no ambient types, no Node.js or browser API in `src/`.

| Part | Where |
|---|---|
| ZIP reader and writer that copy unchanged entries raw (compressed bytes, CRC, sizes); limits on entries, total size and ratio checked before expanding | `src/zip.ts` |
| Strict UTF-8 decoding (TextDecoder is not allowed in universal packages) | `src/utf8.ts` |
| XML parser working on bytes: offsets of every start tag, content and end tag, namespace resolution, refusal of DTDs, undeclared entities and UTF-16; iterative canonical XML | `src/xml.ts` |
| Element trees: conversion, the grammar check (the model's `checkGrammar`), canonical text, serialisation with prefixes from the target part | `src/tree.ts` |
| Property lenses for `w:pPr`, `w:rPr`, `w:sectPr`, `w:tblPr`, `w:trPr`, `w:tcPr` and `w:style`, with the import self-check and the write rule | `src/props.ts`, `src/marks.ts` |
| Importer: DOCX to CDM, source map and assets (fragments, pictures) | `src/import.ts`, `src/assets.ts`, `src/source-map.ts` |
| Package-patching writer: verbatim copies by byte range when the hash is unchanged, regeneration otherwise, gaps, sections, relationship and part clean-up | `src/export.ts` |
| Node hashes equal to `nodeHash`, but linear in document size | `src/hash.ts` |
| R0 and R1 checks, reusable by CI (EXP-120) | `src/conformance.ts` |
| The scripted edits | `src/edits.ts` |
| Tests | `test/roundtrip.test.ts`, `test/edits.test.ts`, `test/layers.test.ts`, `test/lenses.test.ts`, `test/measure.test.ts` |
| Word check | `scripts/export-for-word.ts`, `scripts/word-open-check.ps1` and two recovery helpers |
| Corpus and provenance | `corpus/`, `corpus/SOURCES.md` |

What the importer models (its R2 subset): paragraphs with style, alignment, indents, spacing, keep and widow options and direction; text with the 14 run-formatting marks; tabs and line, page and column breaks; inline pictures as `image`; tracked insertions and deletions of text as `ins` and `del` marks; tables with a regular grid (style, width, alignment, grid, row height, column spans, vertical alignment, shading); sections and page setups with header and footer references; headers and footers as stories; paragraph, character and table styles. Everything else is preserved. Numbering, footnotes, endnotes, comments, fields, equations, content controls, hyperlinks and bookmarks are not mapped to CDM nodes; they survive as residue or atoms. Mapping them is EXP-100 to EXP-105.

Building blocks chosen against the borrow list (SPK-026 §5):

| Need | Chosen | Why |
|---|---|---|
| DEFLATE | `fflate` 0.8.3, MIT (borrow list: adopt) | Synchronous, no platform APIs |
| ZIP container | Hand-written, about 300 lines | `@zip.js/zip.js` (the borrow list's first choice for raw copies) has an asynchronous, stream-based API with Blob, Web Streams and workers, which the universal package's lib ES2023 setting excludes. The subset Office writes (stored and deflated entries, data descriptors) is small |
| XML with positions | Hand-written, about 500 lines | The writer needs, in one pass, byte offsets of start-tag ends as well as element ends, resolved namespaces, and refusal of DTDs. `@rgrove/parse-xml` (ISC, the borrow list's first candidate) was not evaluated in code here; EXP-097 should run it against `test/layers.test.ts` |
| Canonical XML | Own, defined below | `xml-crypto`'s canonicalisation keeps prefixes and namespace declarations, which this comparison must ignore |

## Corpus

78 files, 2,795,027 bytes, listed with origin, licence and hash in `packages/export-docx/corpus/SOURCES.md`: 37 from Apache POI (Apache-2.0), 23 from docx4j (Apache-2.0) and 18 from python-docx (MIT). Generators: Word 2007 to Word for Microsoft 365 on Windows, Word 2008 and 2011 for Mac, LibreOffice 6, files built by docx4j and python-docx, and one fuzzing file.

Coverage of what SPK-028 names, counted at import: text boxes (12 atoms), shapes (7), charts including chartex (9), SmartArt (1), embedded objects and ActiveX (13 atoms; 19 embedded parts and 5 ActiveX controls in the packages), nested and irregular tables (13 preserved tables), content controls (20 block, 6 inline), tracked changes (text revisions as marks; 36 revision atoms, moves included), comments (60 anchors), complex fields (67 field characters and 23 field codes), Office math (11 equations) and several sections (6 files, up to 5 sections).

Ten candidates were downloaded and passed R0 but were left out: real-world documents from bug reports with third parties' text and people's names, and text copied from web pages. `SOURCES.md` lists them.

Gaps: no table of contents field (the only candidate carries the full text of a UN resolution); no file authored by Word for Microsoft 365 in this spike (see "Opening in Word and LibreOffice"); no document with a confidential region (SR-C1 asks for one, but regions are not imported from Word yet, EXP-104); no strict-conformance file; no macro-enabled file (refused by design).

## Evidence

Run from the repository root.

| Test | What it shows | Result |
|---|---|---|
| `vitest run --project node packages/export-docx/test/roundtrip.test.ts` | R0 on every corpus file: same parts, every part byte-identical, no node regenerated; `validate()` passes with `preserve` in `requires` and the attached assets | 157 pass |
| `packages/export-docx/test/edits.test.ts` | R1 after each scripted edit (5 per file; one that does not apply is recorded as not applicable, with the reason); the edited document passes `validate()`; the regeneration stress test | 468 pass |
| `packages/export-docx/test/layers.test.ts` | ZIP raw copies, data descriptors and limits; XML offsets, refusals and canonical form; grammar; the linear hasher equals `canonicalNodeText` for every table, row, cell, story, body and paragraph of the corpus; a DTD and a macro-enabled file are refused; the 5,000-level file survives | 12 pass |
| `packages/export-docx/test/lenses.test.ts` | The two lens rules on single containers | 3 pass |
| `packages/export-docx/test/measure.test.ts` | Writes `test-results/s11-measurements.json` (sizes, shares, commits, times, trees) | 1 pass |
| `node scripts/export-for-word.ts`, then `scripts/word-open-check.ps1` (from `packages/export-docx`) | Word opens each original and export without a prompt | 492 of 497; the 5 others from a file whose original prompts |

### Per-file results

"n/a" means the edit does not apply to the file: its body has one block only, its text is all inside preserved content, or it has no self-contained atom to move (`test/edits.test.ts` records the reason). "Word" gives the original's result, then how many of its exports opened without a prompt. "Size" is the canonical CDM with preservation divided by the canonical CDM without it. Times are medians of three runs, in milliseconds.

| File | R0 | Type | Split | Delete | Restyle | Move atom | Regenerate all | Word | Size | Import / export ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `docx4j/2010-mcAlternateContent.docx` | pass | pass | pass | n/a | pass | n/a | pass | clean / 5 of 5 | 6.6 | 17 / 4 |
| `docx4j/2016_image_with_text_effects.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 6.7 | 18 / 3 |
| `docx4j/76t52-round-8-control-word365.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.5 | 30 / 8 |
| `docx4j/DrawingML_GraphicData_wps.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 8.3 | 32 / 9 |
| `docx4j/LegacyForms.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.2 | 15 / 3 |
| `docx4j/binding-simple.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.3 | 5 / 1 |
| `docx4j/chart.docx` | pass | n/a | n/a | n/a | n/a | pass | pass | clean / 3 of 3 | 7.7 | 5 / 1 |
| `docx4j/comment-cards.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 3.3 | 10 / 2 |
| `docx4j/cr043-tracked.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.8 | 59 / 18 |
| `docx4j/create-new-bitmap.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 9.0 | 22 / 6 |
| `docx4j/equation-sample.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 8.0 | 6 / 2 |
| `docx4j/hyperlinks-internal.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.1 | 9 / 3 |
| `docx4j/inserted-doc.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 7.3 | 16 / 4 |
| `docx4j/mc-txbx-block-word365.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 10.0 | 14 / 4 |
| `docx4j/review-for-word-word2010.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.0 | 36 / 11 |
| `docx4j/sample-docx.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 3.4 | 34 / 10 |
| `docx4j/sections_multiple.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 3.6 | 10 / 4 |
| `docx4j/tables.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.9 | 77 / 18 |
| `docx4j/textbox.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 7.0 | 4 / 1 |
| `docx4j/textbox_alternates_contrived.docx` | pass | n/a | n/a | n/a | n/a | pass | pass | clean / 3 of 3 | 8.1 | 4 / 1 |
| `docx4j/tracked-changes-equations.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 7.5 | 27 / 9 |
| `docx4j/w14_texteffects.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 5.5 | 3 / 1 |
| `docx4j/waterfall.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 9.0 | 14 / 4 |
| `poi/58618.docx` | pass | pass | pass | n/a | pass | pass | pass | clean / 6 of 6 | 6.8 | 3 / 1 |
| `poi/60316.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.3 | 18 / 7 |
| `poi/61470.docx` | pass | n/a | n/a | pass | n/a | pass | pass | clean / 4 of 4 | 9.8 | 4 / 1 |
| `poi/61745.docx` | pass | n/a | n/a | pass | n/a | pass | pass | clean / 4 of 4 | 7.4 | 4 / 1 |
| `poi/Bug54771a.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 6.9 | 9 / 3 |
| `poi/Bug54849.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 4.7 | 12 / 4 |
| `poi/Bug55142.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.3 | 9 / 2 |
| `poi/Bug60337.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.6 | 8 / 2 |
| `poi/ComplexNumberedLists.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.1 | 5 / 2 |
| `poi/DiffFirstPageHeadFoot.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.8 | 7 / 3 |
| `poi/EmbeddedDocument.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.2 | 3 / 1 |
| `poi/FieldCodes.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 8.0 | 9 / 2 |
| `poi/FldSimple.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 6.7 | 2 / 1 |
| `poi/MultipleBodyBug.docx` | pass | pass | pass | n/a | pass | n/a | pass | clean / 5 of 5 | 10.1 | 18 / 5 |
| `poi/Numbering.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.1 | 6 / 3 |
| `poi/PageSpecificHeadFoot.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.8 | 9 / 4 |
| `poi/Styles.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 7.9 | 6 / 2 |
| `poi/TestDocument.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 4.0 | 6 / 2 |
| `poi/VariousPictures.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.6 | 11 / 2 |
| `poi/WithTabs.docx` | pass | pass | n/a | n/a | pass | n/a | pass | clean / 4 of 4 | 5.9 | 3 / 1 |
| `poi/WordWithAttachments.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.1 | 41 / 12 |
| `poi/bookmarks.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.6 | 3 / 1 |
| `poi/bug65738.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.0 | 20 / 7 |
| `poi/chartex.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.9 | 12 / 3 |
| `poi/checkboxes.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 6.9 | 34 / 9 |
| `poi/comment.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 5.8 | 3 / 1 |
| `poi/deep-table-cell.docx` | pass | pass | pass | n/a | n/a | n/a | pass | prompt / 0 of 4 | 1.2 | 120 / 81 |
| `poi/delins.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 13.4 | 32 / 10 |
| `poi/endnotes.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 4.0 | 4 / 2 |
| `poi/footnotes.docx` | pass | pass | pass | n/a | pass | pass | pass | clean / 6 of 6 | 6.2 | 3 / 1 |
| `poi/headerFooter.docx` | pass | n/a | n/a | n/a | n/a | n/a | pass | clean / 2 of 2 | 4.9 | 4 / 2 |
| `poi/heading123.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.3 | 5 / 2 |
| `poi/sample.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 3.8 | 5 / 2 |
| `poi/shapes-with-text.docx` | pass | n/a | n/a | n/a | n/a | pass | pass | clean / 3 of 3 | 9.3 | 17 / 5 |
| `poi/table-alignment.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 6.2 | 32 / 9 |
| `poi/table_footnotes.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 6.1 | 6 / 2 |
| `poi/testComment.docx` | pass | pass | pass | n/a | pass | n/a | pass | clean / 5 of 5 | 6.4 | 8 / 2 |
| `python-docx/blk-containing-table.docx` | pass | n/a | n/a | pass | n/a | n/a | pass | clean / 3 of 3 | 7.5 | 4 / 1 |
| `python-docx/blk-paras-and-tables.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.8 | 7 / 2 |
| `python-docx/comments-rich-para.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 6.1 | 9 / 4 |
| `python-docx/doc-access-sections.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.4 | 3 / 1 |
| `python-docx/doc-odd-even-hdrs.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 4.7 | 6 / 3 |
| `python-docx/hdr-header-footer.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.6 | 7 / 3 |
| `python-docx/num-having-numbering-part.docx` | pass | pass | pass | n/a | pass | n/a | pass | clean / 5 of 5 | 6.1 | 2 / 1 |
| `python-docx/par-hyperlinks.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.8 | 4 / 2 |
| `python-docx/par-known-styles.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 8.9 | 17 / 6 |
| `python-docx/par-rendered-page-breaks.docx` | pass | pass | pass | pass | pass | pass | pass | clean / 7 of 7 | 5.0 | 3 / 1 |
| `python-docx/run-char-style.docx` | pass | pass | pass | n/a | pass | n/a | pass | clean / 5 of 5 | 4.9 | 2 / 1 |
| `python-docx/sct-section-props.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.1 | 4 / 2 |
| `python-docx/shp-inline-shape-access.docx` | pass | n/a | n/a | pass | n/a | pass | pass | clean / 4 of 4 | 5.3 | 7 / 2 |
| `python-docx/tab-stops.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 5.5 | 3 / 1 |
| `python-docx/tbl-cell-access.docx` | pass | pass | n/a | pass | pass | n/a | pass | clean / 5 of 5 | 4.0 | 11 / 3 |
| `python-docx/tbl-cell-props.docx` | pass | pass | n/a | pass | pass | n/a | pass | clean / 5 of 5 | 3.3 | 5 / 1 |
| `python-docx/tbl-having-tables.docx` | pass | n/a | n/a | pass | n/a | n/a | pass | clean / 3 of 3 | 5.0 | 8 / 2 |
| `python-docx/txt-font-props.docx` | pass | pass | pass | pass | pass | n/a | pass | clean / 6 of 6 | 3.5 | 4 / 2 |

What the edits reached: the delete edit removed blocks holding 3 embedded objects (with their preview pictures and, in one file, an ActiveX control), 2 charts (with their workbooks, colour and style parts), 3 content controls, 3 comment anchors, a footnote reference, a text box and 2 equations; the writer removed the relationships and parts nothing referred to any more, and no export has a relationship pointing at a missing part. The atoms moved were hyperlinks (9), text boxes (5), embedded objects, content controls, charts and footnote references (3 each), equations (2), an endnote reference, a ruby annotation and a picture.

## The R1 tolerance

ADR 0017 leaves the tolerance of R1 (b) open, and SR-M13 asks for a rule two people compute the same way. The prototype's rule (`src/conformance.ts`):

- **Parts.** A part no edit reaches is byte-identical (R1 a). Edits to the body reach the main document part; deleting content may also change the main part's relationships and `[Content_Types].xml` and remove parts nothing refers to any more, and every relationship must still resolve.
- **Blocks.** R1 (b) is checked at block level: body children, table rows, cells and the blocks in cells. Every block the edit does not reach, and every element between blocks, must be canonically equal and in its place. The material before a deleted block moves to the next block that survives.
- **Edited blocks.** An edited paragraph is regenerated, so its runs may be regrouped. It must keep every attribute of the original element, every child of its `w:pPr` (except a property the edit itself changed), the run properties of all its text, its non-text content (atoms) in order, the attributes of its revisions, and its text as the edit made it (R1 c and d). A split's second half must keep the paragraph's properties. Tables, rows and cells that contain an edit must keep their own properties.
- **Canonical XML.** Names in Clark notation, attributes sorted, namespace declarations ignored, character references resolved, `<a/>` equal to `<a></a>`, whitespace-only text ignored where the parent also has element children. Prefixes are ignored because the writer reuses the part's own bindings; exclusive canonicalisation would compare them.
- **Exempt.** `w:proofErr` and `w:lastRenderedPageBreak` inside regenerated paragraphs, and revision-session attributes on regenerated runs (below).

## Measurements

Machine: Intel Core i9-10900KF at 3.70 GHz, 20 logical cores, 128 GiB, Windows 11 Pro 10.0.26300, Node.js 22.18.0. This is the spike machine, not the reference machine of 13 §9. Times are medians of three runs in one warm process (`test/measure.test.ts`).

### Size

| Measure | Corpus (78 files) |
|---|---|
| Packages | 2,795,027 bytes |
| Canonical CDM with preservation / without | 2,158,902 / 367,190 bytes: 5.9 times; median per file 5.8 times |
| Canonical CDM against the main document parts | 1.13 times their uncompressed size |
| Preserved data inside the CDM | 1,722,517 bytes, 80 % of it |
| Nodes carrying preserved data (EXP-116) | 2,195 of 3,216 non-text nodes (68 %); 166 of 1,036 text nodes have a `preserved` mark (16 %) |
| Source maps (stored as assets) | 981,657 bytes; median 0.31 times the package |
| Fragment assets | 411 fragments, 1,044,199 bytes, related parts included |
| Commits: step payloads of 1,000 simulated commits per file (980 one-character insertions with the marks of the text there, 20 splits), 61 files with text | 10,841,655 bytes with preservation, 7,639,437 without: 42 % more; median per file 1.00 times, maximum 5.45 times |

The commits are simulated: steps are built as ProseMirror's `toJSON` writes them, with the real schema, but not applied; only the steps' JSON is counted, because the commit envelope does not change with preservation.

On `bug65649.docx` from Apache POI (474,844 bytes, `document.xml` 12.6 MB, not committed, see `SOURCES.md`): R0 passes; the CDM is 54,050,156 bytes with preservation and 4,619,462 without, so it fails I7 (16 MiB); the source map is 11,760,814 bytes. 67 % of the CDM's characters are namespace URIs in Clark names. Writing `w:` and `w14:` instead of the two commonest URIs gives 29.9 MB. The 37,101 element trees hold 964 distinct values, 2.0 MB in all: with each distinct tree stored once, the document would be about 6.6 MB.

### Time

| | Corpus file, median | 90th percentile | Maximum | `bug65649.docx` |
|---|---|---|---|---|
| Import | 8 ms | 32 ms | 120 ms | 11.9 s |
| Export without edits | 2 ms | 9 ms | 81 ms | 4.6 s |

Hashing every node with `nodeHash` costs time proportional to size times depth, because a table, each row, each cell and each paragraph are canonicalised separately. On the large file the import took 21 to 29 s before the prototype composed container texts from their children's (`src/hash.ts`; the tests check the result equals `canonicalNodeText`).

### On the reference machine (2026-11-15)

[ADR 0037](../adr/0037-reference-machine-and-throttling-profile.md) (proposed, FND-007) has since named the reference machine `reference-1`. It is the machine the spike ran on: the same processor, memory, operating system build and Node.js version, with the power plan "High performance" (checked with `powercfg /getactivescheme`). The measurement was taken again there on 2026-11-15, in the same way: `pnpm exec vitest run --project node packages/export-docx/test/measure.test.ts`, which writes `packages/export-docx/test-results/s11-measurements.json`. Times are the median of three runs per file in one warm process. Four other development worktrees were running builds and tests on the machine at the time, so the times are upper figures, not quiet-machine figures. The CPU throttling rate of ADR 0037 applies to browser pages and does not apply to this Node.js run.

The prototype is no longer the one measured above. It now uses the model changes that this report asked for (registered prefixes, shared trees in `preserved_def`, `origin` on inline atoms, element trees on small markers), so sizes differ from the first table.

| Measure | Corpus (78 files), 2026-11-15 |
|---|---|
| Nodes carrying preserved data | 2,145 of 3,175 non-text nodes (68 %); 154 of 986 text nodes have a `preserved` mark (16 %) |
| Canonical CDM with preservation / without | 889,340 / 393,633 bytes: 2.3 times; median per file 2.4 times, maximum 7.5 times |
| The same without shared trees | 944,909 bytes; sharing made 105 `preserved_def` nodes |
| Preserved data inside the CDM | 430,028 bytes, 48 % of it |
| Source maps | 942,704 bytes; median 0.37 times the package |
| Fragment assets | 197 fragments, 966,895 bytes; 257 small markers keep a tree instead |
| Commits: step payloads of 1,000 simulated commits per file, as above, 62 files with text | 10,786,708 bytes with preservation, 8,010,423 without: 35 % more; median per file 1.00 times, maximum 7.61 times |

| | Corpus file, median | 90th percentile | Maximum | Corpus total |
|---|---|---|---|---|
| Import | 24 ms | 92 ms | 260 ms | 3,110 ms |
| Export without edits | 10 ms | 35 ms | 149 ms | 1,327 ms |

The commits are still simulated step payloads, not a replay through the authority. `bug65649.docx` is not in the repository and was not measured again.

### Element trees against the grammar

The table below is the measurement of 2026-11-06, taken before the model changed.

Every tree the import produced (in the document, or not fitting and replaced by a fallback), by where it is kept. "Fits" counts trees within a depth and a size limit.

| Kept in | Trees | Depth p50 / p99 / max | Bytes p50 / p99 / max | Fits 8, 16 KiB (today) | Fits 12, 16 KiB | Fits 16, 32 KiB |
|---|---|---|---|---|---|---|
| `style_def.preserved` | 966 | 3 / 4 / 5 | 1,118 / 4,547 / 20,763 | 964 | 964 | 966 |
| `paragraph.preserved` | 306 | 4 / 6 / 9 | 514 / 3,246 / 6,179 | 305 | 306 | 306 |
| `table_cell.preserved` | 354 | 3 / 4 / 4 | 340 / 2,950 / 3,340 | 354 | 354 | 354 |
| `preserved` mark | 217 | 2 / 4 / 4 | 175 / 2,396 / 2,396 | 217 | 217 | 217 |
| `page_setup.preserved` | 85 | 2 / 4 / 4 | 1,209 / 4,270 / 4,270 | 85 | 85 | 85 |
| `table.preserved`, `table_row.preserved` | 46, 14 | max 4 | max 3,345 | all | all | all |
| Inline pictures, whole original run | 12 | 9 / 14 / 14 | 3,385 / 3,968 / 3,968 | 0 | 11 | 12 |
| Equations (`m:oMath`), measured only | 11 | 8 / 11 / 11 | 6,674 / 24,069 / 24,069 | 9 | 10 | 11 |
| Field characters and codes, measured only | 90 | max 4 | max 953 | all | all | all |

The one paragraph over depth 8 holds Word 2010 text effects in its paragraph mark (`w:pPr/w:rPr/w14:textFill/w14:gradFill/w14:gsLst/w14:gs/...`); it fell back to a preserved block. The two style definitions over 16 KiB are table styles with conditional formatting; the importer kept them only in `styles.xml`, which is fine until someone edits them.

The self-check kept every original child of the container (instead of the residue only) for 81 of 85 section properties, 294 run-property containers, 31 paragraph-property containers, 42 cell-property containers and 3 table-property containers. For sections it is structural: `page_setup` attributes have non-null defaults, so an element that states a default (`<w:cols w:space="720"/>`) cannot be told apart from an absent one.

What the residues hold: 119 kinds of element across the corpus. The commonest are style metadata (`w:uiPriority`, `w:rsid`, `w:link`, `w:semiHidden`, `w:qFormat`), complex-script and theme variants of run properties (`w:rFonts` hints, `w:szCs`, `w:bCs`, `w:iCs`), cell widths (`w:tcW`, 353), the run properties of paragraph marks, list membership (`w:numPr`, 69) and page geometry. Elements that SR-C2 counts as risky occur too: frames (`w:framePr`, 6), property changes (`w:pPrChange` 5, `w:rPrChange` 20) and paragraph-mark and row revisions (46).

Other counts: 1 paragraph and 4 body tables fell back to preserved blocks (three tables have rows with `w:gridBefore` or `w:gridAfter`, which I6 cannot express, and one has a content control around cells); 3 tabs stayed atoms because their run had properties; 18 of the 427 preserved atoms have a fallback picture (SR-M17: charts, SmartArt and text boxes have none); 108 `w:proofErr` and 23 `w:lastRenderedPageBreak` were in imported paragraphs.

## Opening in Word and LibreOffice

**Word.** `scripts/word-open-check.ps1` drives the installed Word 16.0 build 16.0.20527 (Microsoft 365) through COM: invisible, all alerts on, each file opened read-only, without repair and without adding it to the recent list. A file Word wants to repair, or cannot open, shows a prompt that blocks the open. The script watches the Word process it started for a visible prompt window, records its text through UI Automation, closes it as its close button would, and goes on. Nothing is saved and no Word setting is changed.

Calibration on damaged copies of a corpus file: an attribute value Word cannot parse (`w:before="banana"`) and malformed XML both produced a prompt ("Word experienced an error trying to open the file"); an unknown element in the WordprocessingML namespace and a `w:pPr` after the runs opened without one, so Word tolerates those. With alerts off no prompt can appear at all, so the check runs with alerts on.

Result: 492 of 497 without a prompt. The 5 prompts ("Word found unreadable content ... Do you want to recover the contents of this document?") are the original of `poi/deep-table-cell.docx` and its four exports. Every export of every other file opened cleanly, including those whose deletions left comments without anchors and footnotes without references, and those whose clean-up removed chart, embedding and ActiveX parts.

**LibreOffice** is not installed on the spike machine (`soffice` is not on the path and not in the default install folders), so it was not checked. The criterion stays open for it.

**Word-authored corpus files.** `scripts/make-word-corpus.ps1` was meant to add files authored by this Word (a table of contents, comments with replies, tracked changes, SmartArt, equations, content controls, sections). Word added every feature, but `Document.SaveAs2` then blocked with no visible prompt in any Word or sign-in window; the first probe of the day had saved. The cause was not found without changing Word's settings, so no such file is committed.

## Open questions of ADR 0017

| Question | Settled? | Answer and evidence |
|---|---|---|
| Phasing | By the owner | Phase 2 with import |
| Corpus, licences and the R1 (b) tolerance | Yes, for S11 | `corpus/SOURCES.md`; the tolerance above. CI (EXP-120) can reuse `src/conformance.ts` and `src/edits.ts` |
| Regenerated elements | Yes | Dropped only inside a regenerated paragraph: `w:proofErr`, `w:lastRenderedPageBreak`, and the revision-session attributes of its runs (`w:rsidR`, `w:rsidRPr`, `w:rsidDel` on `w:r`), because runs have no node identity. Kept: the paragraph's own identity values through the source map (`w14:paraId`, `w14:textId`, `w:rsid*`), bookmarks including `_GoBack`, and field results (stale results are Word's to update; SR-M11 asks for a dirty flag, not built). Unedited paragraphs keep everything. Word opened all 77 fully regenerated exports of the files whose originals it opens |
| Comment parts | Partly | Copied byte for byte while no comment changes, with anchors as preserved atoms. Deleting an anchored block leaves its comment without anchors, which Word accepts silently (`docx4j/comment-cards.docx`). Regenerating changed threads from the thread store was not built; SR-M16's proposal (regenerate from the thread store, keep each comment's original XML in the source map while unchanged) fits the evidence |
| Inline atoms without identifiers (SR-M10) | Yes | Not the original element tree: pictures exceed depth 8 in all 12 cases and equations in 2 of 11, and the trees would duplicate what a fragment keeps byte-exact. The prototype gives `image` a `preserved` value with a fragment reference and a hash of `asset`, `width`, `height` and `alt`; while the hash matches, the original run is written back (tested by regenerating every paragraph, and by moving a picture). Equations, fields and footnote references stay preserved atoms here because the prototype has no OMML converter. The model needs a proper attribute for this (below) |
| Page view | No | SPK-013 |

## The second review's findings

- **SR-C1, read restrictions.** Confirmed by construction. The source map holds a hash of every node's canonical JSON, text included, and the identity values of its element; fragments hold the original XML of preserved content, text of text boxes and content controls included; the original package holds everything. The prototype has no read restrictions. The review's proposal stands: these three are server-only assets, and a patched export is only for a requester who sees the whole document. No corpus file has a confidential region yet (EXP-104).
- **SR-C2, who writes preserved data.** Compatible with the prototype: every preserved value, mark and atom it produces comes from import, and the edits move or delete them, never create them. Residues do contain frames, property changes and revisions, and fragments contain embedded objects and ActiveX controls that the writer puts back verbatim; the residue list above is a starting point for the per-position allow-list.
- **SR-M10, inline atoms.** Settled as above.
- **SR-M11, identifiers and dependencies.** The writer keeps original identifiers and gives a revision written twice (a split paragraph) a fresh `w:id` from 900,000 up. A verbatim paragraph is copied only if its section context is unchanged too (the section properties it holds belong to the same, unchanged page setup). Table-of-contents and cross-reference results are not regenerated.
- **SR-M12, lexical values and precedence.** Done: the import self-check keeps the original element whenever the writer would write it differently, and a precedence table drops theme colours, theme fonts, theme fills and character-unit indents and spacing when the value they override is edited (`test/lenses.test.ts`). Font substitution is not done at import here, so the CDM keeps the family the file names.
- **SR-M13, R1 granularity.** Block level, as proposed; the tolerance is above.
- **SR-M14, tracked changes.** Text insertions and deletions become `ins` and `del` marks; the source map keeps each revision's attributes (`w:author`, `w:date`) by suggestion `id`, and a regenerated paragraph writes them back (checked by R1 c). Moves, revisions of non-text content and property changes stay preserved (36 atoms, and residue). The marks' `user` is a label (`word:<author>`), which 03 §5's check would refuse, so SR-M14's exception for commits with origin `import` is needed.
- **SR-M15, content controls.** Preserved atoms here, so imported forms cannot be filled. A data-bound control and its custom XML part stay consistent only because both are copied unchanged.
- **SR-M16, notes and comments.** Footnote, endnote and comment parts are copied unchanged; references are preserved atoms.
- **SR-M17, fallbacks.** 18 of 427 atoms (4 %) have a fallback picture. The PDF of an imported document would show labels for charts, SmartArt and most shapes.
- **SR-M18, active content.** The corpus carries 19 embedded-object parts (9 files), 5 ActiveX controls (1 file), 26 external hyperlinks (9 files) and 5 other external relationships (4 files); no field fetches content (`INCLUDETEXT`, `INCLUDEPICTURE`, `DDE`, `DDEAUTO`, `LINK`). The writer writes all of it back unchanged, as R0 requires.
- **SR-M19, migrations.** The source map records the canonical-form version and the CDM version its hashes were taken under.

The model change of 2026-11-06 (footnote content `paragraph+`) does not affect the prototype, which imports footnote references as preserved atoms; the tests pass after it. Importing footnotes as `footnote` nodes is EXP-102's.

## Changes ADR 0017 needs

1. **The contract.** State R1 at block level with the tolerance above, and list the elements dropped on purpose.
2. **Part 1, source map.** Add what the prototype needed: container gaps (the material between blocks, by byte range, passed on when a block is deleted); the section context of a paragraph that holds section properties; the shape of an original element the CDM cannot record (a table without `w:tblPr`); the revision attributes by suggestion `id`; the canonical-form and CDM versions. Note that the map is about a third of the package's size and holds content hashes (SR-C1).
3. **Part 2, preserved properties.** Add the two lens rules: the import self-check (keep every original child when the compact residue does not reproduce the original) and the write rule with its precedence table. Name the identity-bound attributes (`w:rsid*`, `w14:paraId`, `w14:textId`) and keep markup-compatibility attributes (`mc:Ignorable`, `Requires`) out of trees: their values name prefixes, which Clark notation drops, so the prototype keeps `mc:AlternateContent` in fragments.
4. **Part 3, preserved atoms.** Fragments as small ZIPs: the original XML, the namespace bindings it uses, its relationships, and its related parts copied raw. Run-level atoms keep their run properties inside the fragment, because the CDM puts no marks on atoms. Complex fields cannot be one atom (they span runs and paragraphs), so their characters are separate atoms; moving one breaks the field, and the editor should move a field's atoms as a unit. Zero-width markers inside paragraphs (97 bookmark and 60 comment-anchor atoms) each need a fragment asset today, which is heavy for them.
5. **Size.** Record that Clark notation and repetition dominate the size, and adopt one of the model changes below before `cdm: 1`.
6. **Security.** Adopt SR-C1 and SR-C2 into the decision; the evidence above supports both.

## Changes the model needs (not made; for CDM-051 and the model owner)

1. **Marks on inline atoms.** `validate()` treats marks on any non-text node as node marks. Either allow formatting and suggestion marks on inline leaves (as ProseMirror does), or record in 03 §5 that inline atoms carry no marks and that their run properties and revisions are preserved with them. The prototype does the second.
2. **An origin for inline atoms without identifiers** (SR-M10): an attribute on `image`, `equation`, `field`, `footnote` and `anchor` holding a fragment reference and the hash of the modelled attributes, so that I4 checks the fragment. The prototype puts both in `preserved` under its own namespace, which I4 does not see.
3. **The element-tree grammar.** Depth 12 instead of 8 (covers every property tree seen; the deepest was 9); 32 KiB instead of 16 KiB for `style_def.preserved` (two table styles reached 20.7 KiB); registered short prefixes for the OOXML namespaces, with Clark notation only for others (about 45 % smaller on the large file).
4. **Shared residues.** A definition node (for example `preserved_def` in `defs`) that holds a distinct tree once, referred to by identifier from nodes and marks. On the large file this would cut preserved data from about 49 MB to 2 MB and keep the document under I7. Without it, a large Word document cannot be imported within 16 MiB.
5. **`page_setup` defaults.** Nullable attributes, or none of them defaulted, so that a section's residue need not keep the whole `w:sectPr`.
6. **Import labels in suggestion marks** (SR-M14): 03 §5's `user` check needs the exception for commits with origin `import`.
7. **Small markers.** An optional element tree on `preserved_inline` for content without relationships, instead of a fragment asset per bookmark.

### State of these changes on 2026-11-15

The model definition and 03 now carry changes 1 to 4 and 7, and `cdm: 1` is still a draft:

- change 1: marks apply to inline atoms as to text (03 §5);
- change 2: the attribute `origin` on `image`, `equation`, `field`, `footnote`, `anchor` and `citation` (03 §4.6; `packages/model/src/definition/cdm1.ts`);
- change 3: depth 12, 16 KiB and 32 KiB on `style_def`, registered prefixes (`PRESERVED_DEPTH`, `PRESERVED_BYTES` and `PRESERVED_STYLE_BYTES` in `packages/model/src/definition/shared.ts`; `packages/model/src/validate/validate.test.ts`, "preserved content (CDM-051)");
- change 4: `preserved_def` in `defs`, referred to by `{ "ref": id }`;
- change 7: `tree` on `preserved_inline`.

The prototype imports the corpus into that model: all 78 documents are valid and R0 and R1 still pass (`test/roundtrip.test.ts`, `test/edits.test.ts`, run on 2026-11-15). ADR 0017 (§2 and its section "Changes from spike S11") and the preserved-data row of ADR 0018 state these limits, and the story CDM-051 words its second criterion and its Evidence with them (depth 12, 16 KiB, 32 KiB on `style_def`, registered prefixes, references to `preserved_def`). Nothing of changes 1 to 4 and 7 is left for CDM-051 to take before `cdm: 1` is frozen. Changes 5 and 6 are not CDM-051's; they stay with the second-review items SR-C2 and SR-M14.

## Not covered, and why

- **R2.** The prototype maps a subset; numbering, notes, fields, equations, comments, hyperlinks, content controls and regions are EXP-100 to EXP-105.
- **Editing styles, stories and definitions.** The writer patches the body, headers and footers; it refuses edited styles and new stories with a clear error.
- **Moving preserved content to another part or document.** The writer refuses it until relationship renumbering exists (EXP-119); fragments already carry what it needs.
- **The 1,000 commits** are a simulation of step payloads, not a replay through the authority.
- **LibreOffice**, a table of contents, and Word-authored files, for the reasons above.
- **Hostile input** beyond a DTD, a macro-enabled file, ZIP limits and deep nesting: EXP-110.

## Recommendation

Keep ADR 0017's design and move it from proposed to accepted once the owner decides SR-C1 and SR-C2, with the changes above. Before `cdm: 1` is frozen, CDM-051 should take model changes 1 to 4 (marks on atoms, an origin attribute for inline atoms, the grammar limits and prefixes, shared residues). Build EXP-116 to EXP-120 on the prototype: its R0 and R1 checks, edits and corpus are ready for CI.
