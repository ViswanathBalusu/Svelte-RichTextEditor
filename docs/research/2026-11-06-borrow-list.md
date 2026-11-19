# Borrow list with licences checked, 2026-11-06

**Status:** research note, 2026-11-06, written for story SPK-026; not reviewed by the project owner.

Roadmap principle 3 says to buy or borrow what is not a differentiator. This note lists the components the project could borrow, with each licence checked at two primary sources. It covers the areas SPK-026 names, the layout cores of spike S7, the WebAssembly candidates of the [Rust and WebAssembly assessment](2026-11-06-rust-wasm-assessment.md) §6, and the DOCX building blocks that [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md) now needs: a preserving importer and a package-patching writer. It is the input to the licence gate (FND-011). It is a research note, not legal advice; the [legal note](2026-11-06-legal-note.md) covers the questions for counsel.

## 1. How the entries were checked

- **Registry.** For npm, `npm view <pkg> license version time.modified repository.url --json`, plus the full registry document for the release date of the latest version, deprecations and dist-tags. For Rust, the crates.io API. For other runtimes, PyPI's JSON API, NuGet's search and catalogue API, and Maven Central's metadata and POM files.
- **Repository.** The licence file at the head of the default branch (fetched from `raw.githubusercontent.com`, or from the project's own forge), read for its text, not only its name. The GitHub REST API supplied creation date, last push, archive status and open issues for the main candidates; for the rest, the repository's commit feed supplied the last commit and the page showed whether it is archived.
- **Version** is the latest release on 2026-11-06, with its release date. "Last commit" is the newest commit on the default branch.
- **Maintenance:** *active* means a release or commit in the last six months; *slow* means the last release is six to 24 months old; *unmaintained* means archived, deprecated, or no release for more than two years.
- **Verdicts:** *adopt* (a dependency candidate); *adopt with care* (permissive, with a condition stated in the row); *evaluate* (a candidate for a spike to decide); *tool only* (build, test or CI, never shipped); *read for ideas only* (copyleft or restrictive terms: study the design, copy no code, never a dependency); *not recommended* (permissive, but a better entry exists or it is unmaintained).
- Everything here is as published on 2026-11-06. Licences change, as Eigenpal's did twice this year (section 9.1), so FND-011 re-checks at the moment a version is pinned.
- Where something could not be verified, the row says "not verified" and why.

## 2. Entries to flag to the owner

| Entry | Flag | What it means for the project |
|---|---|---|
| Eigenpal docx-editor (`@docx-editor.dev/*`) | Unclear provenance; open core; licence changed twice | The repository at the same address was re-created on 2026-07-20 under a new repository identifier; the Internet Archive captured the old one as late as 2026-07-17. Licence MIT in March 2026, Apache-2.0 by June, now Apache-2.0 with four directories under a proprietary evaluation licence that forbids production use and assigns disclosed modifications to EigenPal. Evaluate only the Apache-2.0 core from its npm tarball (section 9.1) |
| `@eigenpal/docx-js-editor` | Registry and repository disagree; deprecated | npm says MIT; the repository it names is now Apache-2.0 plus proprietary parts. Do not use |
| `@manuscripts/track-changes-plugin` | No licence text | Registry and `package.json` say Apache-2.0, but neither the repository nor the npm package contains a licence file. Read only, until a licence file exists |
| `docxtemplater` | Registry and repository disagree; open core | npm says MIT; the repository's licence file says MIT *or* GPL-3.0. Paid modules exist. Read for ideas |
| `harfbuzzjs` | Notice gap | Its MIT licence covers the wrapper. The bundled `harfbuzz.wasm` is HarfBuzz, whose own licence notice is not in the npm package. Add HarfBuzz's notice when bundling it |
| `pdfjs-dist` | Copyleft font inside an Apache-2.0 package | `standard_fonts/` contains Liberation 1.x fonts under GPL-2.0 with a font exception. Leave that directory out of the distributable, or ship it with its licence |
| `hypher` patterns | README and pattern files disagree | The README says only permissively licensed patterns are included; the Slovak file is GPL-2.0-or-later and the Hungarian file is MPL-1.1, GPL-2.0 or LGPL-2.1. Build hypher without those languages |
| `saxes` | Unmaintained | Archived on GitHub; last release 2021 |
| `rustybuzz`, OpenXmlPowerTools, `omml2mathml` | Unmaintained | Archived. Use HarfRust, Clippit, and the outcome of EXP-054 instead |
| `pdf-lib` | Unmaintained | Last release November 2021. A maintained fork exists (`@cantoo/pdf-lib`) |
| `nspell`, `hunspell-asm`, `slimdom-sax-parser`, `hyphenation` (crate) | Unmaintained | No release for more than two years |
| `jszip`, `pizzip`, `node-forge` | Dual-licensed with a GPL option | Usable under the permissive option; record the option chosen |
| `dompurify` | Dual-licensed (MPL-2.0 or Apache-2.0) | Use under Apache-2.0; record it |
| `veraPDF` | Dual-licensed (GPL-3.0+ or MPL-2.0) | CI tool only, under MPL-2.0; never shipped |
| `axe-core` | MPL-2.0 | Test tool only; never shipped |
| Redis 8 | RSALv2, SSPLv1 or AGPLv3 | 01 §7 allows Redis or Valkey. Choose Valkey (BSD-3-Clause), at least for self-hosted distribution |
| SuperDoc, ONLYOFFICE, Fidus Writer, iText, EU DSS, LanguageTool, Hunspell, `mathml2omml`, texmath, Pandoc, LibreOffice | Copyleft | Read for ideas only |
| ProseMirror | Provenance note, not a problem | The repositories moved from GitHub (now archived with a "moved" notice) to the author's own forge, `code.haverbeke.berlin`. Same author, same MIT licence; update repository URLs in tooling |
| `linebreak` | Provenance note | The registry names `devongovett/linebreaker`, which redirects to `foliojs/linebreak` |

## 3. Editing core and collaboration rebase

ProseMirror is the editing core (ADR 0003); the sync engine pins one release exactly (04 §4). The server-side rebase follows `prosemirror-collab-commit` (research summary §5).

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `prosemirror-model` | 1.25.12 (2026-09-21) | MIT · MIT | Active | Marijn Haverbeke; moved to `code.haverbeke.berlin`, GitHub copy archived | Adopt |
| `prosemirror-transform` | 1.12.5 (2026-11-04) | MIT · MIT | Active | As above | Adopt |
| `prosemirror-state` | 1.4.4 (2025-10-23) | MIT · MIT | Active | As above | Adopt |
| `prosemirror-view` | 1.42.9 (2026-10-31) | MIT · MIT | Active | As above | Adopt (web view) |
| `prosemirror-history` | 1.5.1 (2026-09-29) | MIT · MIT | Active | As above | Adopt |
| `prosemirror-collab` | 1.3.1 (2023-05-17) | MIT · MIT | No release since 2023-05; a small module of an active project | As above | Adopt (client rebase reference) |
| `prosemirror-changeset` | 2.4.6 (2026-11-02) | MIT · MIT | Active | As above | Adopt (attribution, 08 §7) |
| `prosemirror-commands`, `-keymap`, `-inputrules`, `-gapcursor`, `-dropcursor`, `-schema-list` | 1.7.2, 1.2.3, 1.5.1, 1.4.1, 1.8.4, 1.6.0 (2025-05 to 2026-10) | MIT · MIT | Active | As above | Adopt |
| `prosemirror-tables` | 1.8.5 (2025-12-24) | MIT · MIT | Active | GitHub `ProseMirror/prosemirror-tables` | Adopt with care: 02 §5.2 replaces its table commands with the project's own for suggestions |
| `@stepwisehq/prosemirror-collab-commit` | 1.0.5 (2025-09-03) | MIT · MIT (licence notes it reuses `prosemirror-collab` code) | Slow: last commit 2025-09-03; 2 open issues | Greg Zapp (StepWise); created 2023-07; published only under this scoped name | Adopt with care: small; expect to fork; spike S3 proves the result |
| `StepWise.ProseMirror` (NuGet) | 0.1.15 (2024-05-07) | MIT · MIT | Slow | Greg Zapp | Evaluate in phase 4, for the authority service in .NET (05 §10) |
| `prosemirror` (PyPI, prosemirror-py) | 0.6.1 (2026-02-21) | BSD-3-Clause · BSD-3-Clause | Active | Fellow Insights Inc. | Evaluate in phase 4 (05 §10) |
| `yjs`, `y-prosemirror` | 13.6.33 (2026-09-23), 1.3.7 (2025-07-03) | MIT · MIT | Active | Kevin Jahns and contributors | Not used by design (ADR 0001) |

## 4. Suggestion marks and attribution

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `@handlewithcare/prosemirror-suggest-changes` | 0.1.8 (2025-11-18) | MIT · MIT | Active: last commit 2026-08-04; 5 open issues; pre-1.0 | Handle with Care Collective; created 2025-03 | Adopt with care: expect to fork for block suggestions and the `fmt` mark (03 §5) |
| `prosemirror-changeset` | see section 3 | | | | Adopt |
| `@manuscripts/track-changes-plugin` | 2.4.0 (2026-06-20) | Apache-2.0 · no licence file in the repository or in the npm package (only `package.json` says Apache-2.0) | Active | Atypon; the older public repository (`manuscripts-quarterback`) stopped at 1.7.2 in 2023 | Read only until a licence file is published |
| Fidus Writer | not checked | not applicable · AGPL-3.0 | Active | Fidus Writer project | Read for ideas only |

## 5. DOCX building blocks for lossless round trip

ADR 0017 makes the DOCX writer a package patcher: it copies unedited parts byte for byte, copies unedited elements verbatim, and writes preserved fragments back. The importer must record where every element came from (the source map). That needs a ZIP layer that can copy entries without touching them, an XML parser that reports source offsets, canonical XML for the R1 comparison, and validation tools for "opens without a repair prompt". R0 promises byte-identical parts, not a byte-identical container (ADR 0017), so recompressing an entry is allowed; copying compressed bytes untouched is faster and safer.

### 5.1 ZIP

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Raw copy | Verdict |
|---|---|---|---|---|---|---|
| `@zip.js/zip.js` | 2.24.0 (2026-10-16) | BSD-3-Clause · BSD-3-Clause | Active; 1 open issue | Gildas Lormeau | Yes: `passThrough` copies an entry's data as read, without decompressing (type definitions at head) | Adopt: best fit for the package-patching writer, browser and Node.js |
| `fflate` | 0.8.3 (2026-05-16) | MIT · MIT | Active | Arjun Barrett | No: `ZipPassThrough` stores uncompressed data, it does not copy deflated bytes | Adopt for reading; Eigenpal uses it |
| `yauzl` | 3.4.0 (2026-06-07) | MIT · MIT | Active | Josh Wolfe | Read side only: low-level reads without decompression | Adopt for the Node.js importer, with the size and ratio limits of EXP-099 |
| `yazl` | 3.3.1 (2024-11-23) | MIT · MIT | Slow (last commit 2026-03) | Josh Wolfe | No | Adopt with care |
| `jszip` | 3.10.2 (2026-09-08) | MIT OR GPL-3.0-or-later · same, dual | Active again; 391 open issues | Stuart Knightley and others | Not checked | Not recommended; if used, under MIT |
| `pizzip` | 3.3.0 (2026-09-21) | MIT OR GPL-3.0 · same, dual | Active | docxtemplater's author; a JSZip fork | Not checked | Not recommended |
| `adm-zip`, `archiver`, `unzipper` | 0.6.1, 8.0.0, 0.12.5 (2026) | MIT · MIT | Active | Various | Not checked | Not needed |
| `zip` (Rust crate) | 9.4.1 (2026-11-06) | MIT · MIT | Active | `zip-rs/zip2` | Yes: `ZipWriter::raw_copy_file` | Evaluate only if import moves to Rust (ADR 0016 rule 4) |
| Go `archive/zip` | standard library | BSD-3-Clause (Go) | Active | Go project | Yes: `Writer.CreateRaw`, `File.OpenRaw` | Reference only |

### 5.2 XML with source positions, canonical XML and validation

| Component | Version (released) | Licence: registry · repository | Maintenance | Positions | Verdict |
|---|---|---|---|---|---|
| `@rgrove/parse-xml` | 5.1.0 (2026-11-01) | ISC · ISC | Active; 1 open issue | Yes: the `includeOffsets` option records start and end offsets, converted to byte offsets in the source | Evaluate first for the source map: an unedited element can be copied by its byte range |
| `htmlparser2` (with `xmlMode`) | 12.0.0 (2026-03-20) | MIT · MIT | Active | Yes: the parser exposes `startIndex` and `endIndex` | Evaluate (streaming) |
| `sax-wasm` | 3.3.0 (2026-10-20) | MIT · MIT | Active | Yes: line and character positions of entities | Evaluate for the import worker (server side, so no policy cost) |
| `@xmldom/xmldom` | 0.9.12 (2026-08-21) | MIT · MIT | Active; 65 open issues | Line and column through a locator, not byte offsets | Adopt with care |
| `sax` | 1.6.1 (2026-07-24) | BlueOak-1.0.0 · BlueOak-1.0.0 | Active | Not checked | Adopt with care: BlueOak-1.0.0 is permissive but must be on the allow-list |
| `saxes` | 6.0.0 (2021-11-07) | ISC · ISC | Unmaintained: archived 2025-12-31 | Yes | Not recommended |
| `fast-xml-parser` | 5.12.0 (2026-11-03) | MIT · MIT | Active | No position option found in its README | Not for the preserving importer; Eigenpal uses it |
| `slimdom` with `slimdom-sax-parser` | 4.3.5 (2024-04-01), 1.5.3 (2022-06-03) | MIT · MIT | Slow; parser unmaintained | Yes (`position: true`) | Not recommended |
| `txml` | 6.0.3 (2026-08-30) | MIT · MIT | Active | Not checked | Not evaluated |
| `fontoxpath` | 3.34.0 (2025-12-24) | MIT · MIT | Active | Not applicable | Tool only: XPath assertions in tests |
| `xml-crypto` | 6.4.0 (2026-10-14) | MIT · MIT | Active | Not applicable | Adopt for tests: inclusive and exclusive canonicalisation, for the R1 (b) comparison as canonical XML |
| `xmllint-wasm` | 5.3.0 (2026-08-05) | MIT · MIT (libxml2 and wrapper) | Active | Not applicable | Tool only: XSD validation in CI |
| `libxml2-wasm` | 0.7.2 (2026-09-07) | MIT · MIT | Active | Not applicable | Tool only: XSD validation |
| `quick-xml`, `roxmltree` (Rust) | 0.42.0 (2026-08-22), 0.21.2 (2026-10-24) | MIT · MIT; MIT OR Apache-2.0 · both files | Active | Not checked | Evaluate only under ADR 0016 rule 4 |
| `xmlparser` (Rust) | 0.13.6 (2023-09-30) | MIT/Apache-2.0 | Slow | Not checked | Not recommended |

### 5.3 OOXML schemas, specifications and validators

| Component | Version | Licence or terms | Maintenance | Verdict |
|---|---|---|---|---|
| ECMA-376 (Office Open XML), with schemas in its electronic annex | Part 1, 5th edition, December 2016; Part 2, 5th edition, December 2021; Part 3, 5th edition, December 2015; Part 4, 5th edition, December 2016 | Ecma's copyright notice allows derivative works "by making use of this specification in standard conformant products", with the notice kept. Read from a third party's reproduction of the notice (`licenses/ECMA-376.md` in `@docx-editor.dev/core`); not verified against the annex itself, and whether Ecma's software policy also covers the schema files is not verified | Published standard | Tool only: validate exports in CI. Any table generated from the annex carries the Ecma notice |
| Microsoft [MS-DOCX], [MS-OI29500], [MS-OE376], [MS-ODRAWXML] | Microsoft Open Specifications | Covered by Microsoft's Open Specification Promise, which also lists ECMA-376 and ISO/IEC 29500:2008, 2012 and 2016 (legal note §2.3) | Maintained by Microsoft | Read: they document Word's extensions and deviations, which a lossless writer must respect |
| Open XML SDK (`DocumentFormat.OpenXml`, .NET) | 3.5.1 (2026-03-18) | MIT · MIT | Active; 133 open issues | Tool only: its validator as a CI oracle for the "no repair prompt" target (SPK-028, EXP-118). Also a reference for keeping unknown content (research summary §4) |
| OOXML-Validator (CLI over the Open XML SDK) | 2.1.6 (2024-12-12) | MIT · MIT | Slow | Tool only |
| LibreOffice | not pinned | MPL-2.0 (`COPYING.MPL`) | Active | Read for ideas only. Opening exported files in the LibreOffice application, as SPK-028 requires, is a test step, not a dependency |

### 5.4 DOCX libraries

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `docx` | 9.15.2 (2026-11-03) | MIT · MIT | Active; 8 open issues | Dolan Miu | Adopt candidate for the direct writer (09 §11). It also has a patcher (`src/patcher`) that modifies an existing package; S11 checks whether parts it does not touch stay byte-identical |
| `@docx-editor.dev/core` (Eigenpal) | 2.35.0 (2026-11-05) | Apache-2.0 · Apache-2.0 for this package | Active | See section 9.1 | Evaluate in S7 and S11, from the npm tarball only |
| `docxtemplater` | 3.71.1 (2026-10-15) | MIT · MIT or GPL-3.0 (dual, in `LICENSE.md`) | Active | Edgar Hipp; paid modules | Read for ideas (template patching that leaves other XML in place) |
| `docx-templates` | 4.15.0 (2025-12-03) | MIT · MIT | Active | Guillermo Grau | Not needed |
| `mammoth` | 1.13.0 (2026-09-26) | BSD-2-Clause · BSD-2-Clause | Active | Michael Williamson | Not for import: lossy HTML, and the file-read vulnerability CVE-2025-11849 (research summary §4) |
| `docx-preview` | 0.4.1 (2026-09-21) | Apache-2.0 · Apache-2.0 | Active; 101 open issues | Volodymyr Baydalka | Read for ideas (DOCX to HTML rendering) |
| `officeparser` | 8.6.0 (2026-11-05) | MIT · MIT | Active | Harsh Ankur | Not needed (text extraction) |
| Clippit (.NET) | 3.9.2 (2026-10-19) | MIT · MIT | Active | Sergey Tihon; maintained fork of Open-Xml-PowerTools | Read for ideas |
| Open-Xml-PowerTools (.NET) | 4.5.3.2 (2017-08-07) | MIT · MIT | Unmaintained: archived | Microsoft (OfficeDev) | Not recommended |
| docx4j (Java) | 17.3.5 (Maven, 2026-10-31) | Apache 2 (POM) · Apache-2.0 (`legals/LICENSE`) | Active | Plutext Pty Ltd | Read for ideas |
| Apache POI (`poi-ooxml`, Java) | 6.0.0 (Maven, 2026-10-22) | Apache-2.0 (POM) · Apache-2.0 (`legal/LICENSE`) | Active | Apache Software Foundation | Read for ideas |
| python-docx | 1.2.0 (2025-06-16) | MIT · MIT | Active; 550 open issues | Steve Canny | Read for ideas |
| `docx-rs` (Rust) | 0.4.22 (2026-07-21) | MIT · MIT | Active | bokuweb | Not evaluated |
| SuperDoc (`superdoc`) | 2.29.0 (2026-11-03) | AGPL-3.0 · AGPL-3.0 | Active | Harbour Enterprises | Read for ideas only |
| ONLYOFFICE DocumentServer and `sdkjs` | not pinned | not applicable · AGPL-3.0 | Active | Ascensio System | Read for ideas only |
| Pandoc | not pinned | not applicable · GPL-2.0-or-later | Active | John MacFarlane | Read for ideas only |

## 6. PDF viewing

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `pdfjs-dist` | 6.5.438 (2026-11-01) | Apache-2.0 · Apache-2.0 | Active; 475 open issues | Mozilla | Adopt |

The package bundles components under other licences, each with its own licence file in the tarball (checked):

| Path in the package | Contents | Licence |
|---|---|---|
| `wasm/openjpeg.wasm` | OpenJPEG decoder | BSD-2-Clause, with Mozilla's wrapper under BSD |
| `wasm/jbig2.wasm` | JBIG2 decoder from PDFium | PDFium's licence file (BSD-3-Clause text and Apache-2.0 text), with Mozilla's wrapper under Apache-2.0 |
| `wasm/qcms_bg.wasm` | colour management | MIT |
| `wasm/quickjs-eval.wasm` | QuickJS, for scripts inside PDFs | MIT. The viewer runs with scripting off (09 §9.3), so this module need not be served |
| `cmaps/` | Adobe character maps | BSD-style |
| `iccs/` | colour profiles | CC0-1.0 |
| `standard_fonts/` | Foxit fonts; Liberation fonts | Foxit: BSD-style (PDFium authors). Liberation: version 1.x terms, GPL-2.0 with a font-embedding exception, plus Red Hat's trademark terms |

The project's own PDFs embed their fonts, so the standard fonts are needed only for third-party PDFs. Leaving `standard_fonts/` out of the distributable removes the only copyleft file; otherwise ship it with its licence.

## 7. Math display, editing and Office math conversion

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `katex` | 0.19.1 (2026-10-23) | MIT · MIT | Active; 386 open issues | Khan Academy and contributors | Adopt (display and the math gate, 09 §6.3). Its fonts: MIT (`KaTeX/katex-fonts` licence file) |
| `mathlive` | 0.111.4 (2026-10-31) | MIT · MIT | Active; 181 open issues | Arno Gourdol (individual) | Adopt (editing). It registers global custom elements (02 §2) |
| `temml` | 0.14.0 (2026-10-08) | MIT · MIT | Active | Ron Kok | Evaluate in EXP-054 (LaTeX to MathML) |
| `mathjax` | 4.1.3 (2026-07-03) | Apache-2.0 · Apache-2.0 | Active | MathJax consortium | Alternative only |
| `omml2mathml` | 1.3.0 (2017-07-07) | Apache-2.0 · Apache-2.0 | Unmaintained: archived | scienceai | Read; fork only if EXP-054 finds nothing better |
| `mathml2omml` | 0.5.0 (2025-03-14) | LGPL-3.0-or-later · LGPL-3.0 | Slow | Fidus Writer | Read for ideas only |
| texmath (Haskell) | not pinned | GPL-2 (Cabal metadata) · GPL-2.0 | Active | John MacFarlane | Read for ideas only. 09 §6.1 allows a GPL converter only as a separate process; whether to run it is EXP-054's decision, not a dependency |
| Microsoft's `MML2OMML.XSL` | not applicable | Not redistributable (09 §6.1); not verified here | | Microsoft | Not usable |

## 8. Spellcheck and proofing

Spelling reaches the editor through the proofing port (13 §6.1). A built-in fallback is UX-043's decision; these are its candidates.

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `nspell` | 2.1.5 (2021-01-17) | MIT · MIT | Unmaintained | Titus Wormer | Adopt with care, only for a fallback |
| `harper.js` | 3.0.0 (2026-10-27) | Apache-2.0 · Apache-2.0 | Active; 1,053 open issues | Automattic | Evaluate (grammar and spelling, Rust compiled to WebAssembly). Languages supported: not checked |
| `spellchecker-wasm` | 0.4.0 (2026-10-18) | MIT · MIT | Active | Justin Wilaby | Evaluate |
| `typo-js` | 1.4.0 (2026-10-14) | BSD-3-Clause · BSD-style (`license.txt`) | Active | Christopher Finke | Evaluate |
| Hunspell | not pinned | not applicable · MPL-1.1, GPL-2.0 or LGPL-2.1 (`license.hunspell`) | Active | László Németh and contributors | Read for ideas only |
| `hunspell-asm` | 4.0.2 (2020-02-01) | MIT · MIT for the wrapper; the compiled Hunspell keeps its own licence | Unmaintained | OJ Kwon | Read for ideas only |
| LanguageTool | not pinned | not applicable · LGPL-2.1-or-later | Active | LanguageTool | Read for ideas only. A host may run its own server behind the proofing port; that is the host's choice, not a dependency |

Dictionaries carry their own licences. Registry values for wooorm's packages (last released 2023-11-03; repository last commit 2024-09-09); each dictionary's own licence file is for UX-043 to read:

| Dictionary | Licence (registry) | Fits a permissive bundle? |
|---|---|---|
| `dictionary-en`, `dictionary-en-gb` | MIT AND BSD | Yes |
| `dictionary-nl` | BSD-3-Clause OR CC-BY-3.0 | Yes, under BSD-3-Clause |
| `dictionary-fr` | MPL-2.0 | Only with a decision: file-level copyleft on the dictionary file |
| `dictionary-pt` | LGPL-3.0 OR MPL-2.0 | Only with a decision (MPL-2.0 option) |
| `dictionary-es` | GPL-3.0 OR LGPL-3.0 OR MPL-1.1 | Only with a decision (MPL-1.1 option) |
| `dictionary-pt-pt` | GPL-2.0 OR LGPL-2.1 OR MPL-1.1 | Only with a decision (MPL-1.1 option) |
| `dictionary-de` | GPL-2.0 OR GPL-3.0 | No |
| `dictionary-it` | GPL-3.0 | No |

## 9. Layout core candidates for spike S7

### 9.1 Eigenpal docx-editor

This is the candidate the research summary named first. Its provenance needs care.

| Item | Finding (2026-11-06) |
|---|---|
| Packages | `@docx-editor.dev/core`, `react`, `vue`, `i18n`, `fonts`, `fonts-cjk`, `docx-to-markdown` (Apache-2.0; the font packages say "Apache-2.0 AND OFL-1.1", one adds the GUST Font License); `@docx-editor.dev/pro`, `editor-api`, `docx-to-pdf` (`LicenseRef-EigenPal-Pro-Evaluation-1.0`). All at 2.35.0, released 2026-11-05; `core` first published 2026-07-16; 57 versions; one npm maintainer |
| Repository licence | `LICENSE` at head starts with a "licence scope notice": Apache-2.0 for the repository, except `packages/editor-api/`, `packages/pro/`, `packages/docx-to-pdf/` and `packages/telemetry/`, which are under the EigenPal Pro Evaluation License 1.0 |
| The evaluation licence | Internal, non-production evaluation only; no distribution; a modification disclosed to anyone is assigned to EigenPal, Inc.; "By copying, modifying, or using the Software, you agree to these terms"; California law |
| Re-creation | The current repository was created 2026-07-20 (GitHub API) and has repository identifier 1306326204. Internet Archive captures of the same URL show identifier 1147585130 on 2026-03-28 (MIT licence, 571 commits), 2026-06-08 (Apache-2.0, 860 commits) and 2026-07-17 (Apache-2.0, 1,163 commits), and a 404 on 2026-07-09. The current repository shows 1,090 commits, fewer than the old one had on 2026-07-17, so its history was rewritten or re-imported. Issues and pull requests before 2026-07-20 are not in it |
| Earlier package | `@eigenpal/docx-js-editor` 0.5.3 (2026-05-31): MIT in the registry, deprecated, pointing at the same repository |
| Republished copies | npm holds many forks under other scopes (for example `@heyirisai/*`, `@onsitesai/*`, `@sqren/*`), several pointing at Eigenpal's repository. Use only `@docx-editor.dev/*` |
| Dependencies of `core` 2.35.0 | `prosemirror-model`, `-state`, `-view`, `-commands`, `-keymap`; `fflate`; `fast-xml-parser`; `harfbuzzjs` 1.6.1 (pinned); `bidi-js`; `emf-converter` 2.0.2 and `utif2` 4.1.0 (licences not checked); optional peers `pdf-lib` and `yjs` |
| Tarball | The `core` tarball contains no files from the four proprietary directories (file list checked). It carries `THIRD_PARTY_NOTICES.md`, HarfBuzz's licence and the Ecma notice |

Verdict: evaluate in S7 from the published `@docx-editor.dev/core` tarball, never from a clone. Cloning copies the proprietary directories, and the evaluation licence says that copying the software means agreeing to its terms; counsel should confirm how far that reaches (legal note §7). Record the exact version forked, its tarball hash and its licence file, because the licence has changed twice in 2026.

### 9.2 Other candidates

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| canvas-editor (`@hufe921/canvas-editor`) | 1.1.0 (2026-11-06) | MIT · MIT | Active; 22 open issues; created 2021-11 | Hufe921 (individual) | Evaluate (canvas painter with its own pagination) |
| Docen (`docen`, `@docen/core`) | 0.7.0 (2026-09-07) | MIT · MIT | Early: created 2025-10; 4 open issues | DemoMacro (individual) | Evaluate on paper |
| `typst-layout` (crate) | 0.15.1 (2026-07-17) | Apache-2.0 · Apache-2.0 | Active; 1,336 open issues in the Typst repository | Typst project | Evaluate on paper: bound to Typst's own document model |
| `parley` (crate) | 0.12.0 (2026-10-09) | Apache-2.0 OR MIT · both files | Active; 121 open issues | Linebender | Evaluate |
| `cosmic-text` (crate) | 0.19.0 (2026-04-22) | MIT OR Apache-2.0 · both files | Active; 126 open issues | System76 | Evaluate |
| `@chenglou/pretext` | 1.0.0 (2026-10-14) | MIT · MIT, plus a BSD-3-Clause text for a part not identified | New: created 2026-03 | Cheng Lou | Read (text measurement and the research notes cited in 02 §9.3) |
| SuperDoc, ONLYOFFICE | see section 5.4 | AGPL-3.0 | | | Read for ideas only |

## 10. WebAssembly and text candidates of the assessment

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| HarfRust (`harfrust`) | 0.15.0 (2026-10-22) | MIT · MIT | Active; 31 open issues | HarfBuzz project; created 2024-07. The README says it is less than 25 % slower than HarfBuzz on most common fonts | Evaluate in S5 and S10 |
| `harfbuzzjs` | 1.6.4 (2026-10-22) | MIT · MIT (harfbuzzjs authors) | Active; 5 open issues | HarfBuzz project | Evaluate in S5 and S10. Add HarfBuzz's own licence notice for `harfbuzz.wasm`; the package lacks it |
| `rustybuzz` | 0.20.1 (2024-11-12) | MIT · MIT | Unmaintained: archived | HarfBuzz project | Not recommended: superseded by HarfRust |
| `read-fonts`, `skrifa` | 0.46.0, 0.49.0 (2026-10-21) | MIT OR Apache-2.0 · both files | Active | Google Fonts (fontations) | Adopt with HarfRust |
| ICU4X (`icu`, `icu_segmenter`, `icu_properties`) | 2.4.0 (2026-10-22) | Unicode-3.0 · Unicode License v3, covering data files and software | Active; 773 open issues | Unicode, Inc. | Evaluate in S10 (dictionary segmentation for Thai, Lao, Khmer, Burmese) |
| `unicode-linebreak` | 0.1.5 (2023-07-25) | Apache-2.0 · Apache-2.0 | Slow: last commit 2023-07 | Axel Forsman (individual) | Adopt with care; which Unicode version it implements: not checked |
| `unicode-segmentation` | 1.13.3 (2026-06-01) | MIT OR Apache-2.0 · both files | Active | unicode-rs | Adopt |
| `unicode-bidi` | 0.3.18 (2024-12-16) | MIT OR Apache-2.0 · both files | Active (commit 2026-09) | Servo | Adopt in phase 4 |
| `hypher` | 0.1.8 (2026-09-17) | MIT OR Apache-2.0 · both files for the code; patterns under their own licences | Active; 13 open issues | Typst project | Adopt with care: `default-features = false` and only the languages of section 11 marked "yes" |
| `hyphenation` (crate) | 0.8.4 (2021-08-19) | Apache-2.0/MIT · both files | Unmaintained | tapeinosyne | Not recommended |
| `linebreak` (npm) | 2.0.0 (2026-11-03) | MIT · MIT | Active | `foliojs/linebreak`; the registry still names the old repository | Adopt for the TypeScript line breaker (02 §9.3) |
| `hyphenopoly` | 6.1.0 (2026-01-01) | MIT · MIT | Active | Mathias Nater | Evaluate. Its pattern files come from the same TeX sources and need the per-language check of section 11 |
| `hyphen` (npm) | 1.14.1 (2026-01-16) | ISC · ISC | Active | Yevhen Tiurin | Evaluate; its patterns not checked |
| `bidi-js` | 1.1.0 (2026-09-06) | MIT · MIT | Active | Jason Johnston | Adopt in phase 4 |
| `fontkit`, `opentype.js` | 2.0.4 (2024-08-09), 2.0.0 (2026-05-06) | MIT · MIT | Active commits | foliojs; opentype.js org | Read: JavaScript shapers do not reproduce HarfBuzz (assessment §3) |
| `wasm-bindgen` | 0.2.130 (2026-10-30) | MIT OR Apache-2.0 · both files | Active | crates.io names `github.com/wasm-bindgen/wasm-bindgen` | Tool only (build) |

## 11. Hyphenation patterns per language

These are the 48 pattern files hypher embeds by default (`typst/hypher`, directory `patterns/`, read at head on 2026-11-06). Most come from the hyph-utf8 project, whose files state their licence in a header. "Choice" means the file offers several licences and the permissive one is taken. LPPL files carry conditions when compiled into a binary, as hypher does (LPPL 1.3c, clauses 3, 6 and 7; legal note §3.4): a compiled form of an unmodified file must be installable as if built from the file, and a compiled form of a changed file may be distributed only together with the changed file, which must state its changes. The simplest way to meet both is to ship the exact pattern files, with their notices, next to the compiled module. Counsel confirms this before LPPL patterns ship. The same patterns are inside the TeX Live image, where the licence manifest covers them (09 §2).

| Language | File | Licence stated in the file | Use? |
|---|---|---|---|
| Afrikaans | `hyph-af.tex` | LPPL 1.3 or later | Yes, with LPPL conditions |
| Albanian | `hyph-sq.tex` | MIT | Yes |
| Assamese | `hyph-as.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Belarusian | `hyph-be.tex` | MIT | Yes |
| Bengali | `hyph-bn.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Bulgarian | `hyph-bg.tex` | Custom permissive (the file notes it "seems equivalent to 3-clause BSD") | Yes, keep the notice |
| Catalan | `hyph-ca.tex` | LPPL 1 or later; modified for hypher, with the change noted | Yes, with LPPL conditions |
| Croatian | `hyph-hr.tex` | LPPL 1 or later, or a permissive "Data Files" licence (choice) | Yes, under the permissive option |
| Czech | `hyph-cs-sojka.tex` | MIT | Yes |
| Danish | `hyph-da.tex` | LPPL 1.3 or later, or MIT (choice) | Yes, under MIT |
| Dutch | `hyph-nl.tex` | LPPL 1 or later | Yes, with LPPL conditions |
| English (US) | `hyph-en-us.tex` | Custom all-permissive: copying and distribution permitted if the notice is kept | Yes, keep the notice |
| English (British) | `hyph-en-gb.tex` | MIT (stated in the file header, with its text) | Yes. Not in hypher; added 2026-11-18 by lane w6 for WASM-009 after reading the file in hyph-utf8 of TeX Live 2025 |
| Estonian | `hyph-et.tex` | MIT or LPPL (choice) | Yes, under MIT |
| Finnish (school) | `hyph-fi-x-school.tex` | MIT | Yes |
| French | `hyph-fr.tex` | MIT | Yes |
| Galician | `hyph-gl.tex` | Unlicense | Yes |
| Georgian | `hyph-ka.tex` | LPPL 1.3 or later | Yes, with LPPL conditions |
| German (1996 spelling) | `hyph-de-1996.tex` | MIT | Yes |
| Greek (monotonic) | `hyph-el-monoton.tex` | LPPL (no version stated) | Yes, with LPPL conditions |
| Gujarati | `hyph-gu.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Hindi | `hyph-hi.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Hungarian | `hyph-hu.tex` | MPL-1.1, GPL-2.0 or LGPL-2.1 (choice) | **No** by default: every option is copyleft at file level or stronger |
| Icelandic | `hyph-is.tex` | LPPL 1.2 or later | Yes, with LPPL conditions |
| Italian | `hyph-it.tex` | LPPL 1.3 or later, or MIT (choice) | Yes, under MIT |
| Kannada | `hyph-kn.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Kurmanji | `hyph-kmr.tex` | LPPL 1.3 | Yes, with LPPL conditions |
| Latin | `hyph-la.tex` | MIT or LPPL (choice) | Yes, under MIT |
| Lithuanian | `hyph-lt.tex` | MIT | Yes |
| Malayalam | `hyph-ml.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Marathi | `hyph-mr.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Mongolian (Cyrillic) | `hyph-mn.tex` | LPPL 1.3 or later, or MIT (choice) | Yes, under MIT |
| Norwegian | `hyph-no.tex` | Custom all-permissive, as for English | Yes, keep the notice |
| Oriya | `hyph-or.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Panjabi | `hyph-pa.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Polish | `hyph-pl.tex` | A choice of licences; MIT is listed first | Yes, under MIT |
| Portuguese | `hyph-pt.tex` | BSD-3-Clause | Yes |
| Russian | `hyph-ru.tex` | LPPL 1.2 or later | Yes, with LPPL conditions |
| Sanskrit | `hyph-sa.tex` | Custom permissive: "You may freely use, copy, modify and/or distribute this file." | Yes, keep the notice |
| Serbian (Cyrillic) | `hyph-sh-cyrl.tex` | LPPL 1 or later | Yes, with LPPL conditions |
| Slovak | `hyph-sk.tex` | GPL 2 or later | **No**: copyleft |
| Slovenian | `hyph-sl.tex` | LPPL 1 or later, or MIT (choice) | Yes, under MIT |
| Spanish | `hyph-es.tex` | MIT | Yes |
| Swedish | `hyph-sv.tex` | LPPL 1.2 or later | Yes, with LPPL conditions |
| Tamil | `hyph-ta.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Telugu | `hyph-te.tex` | MIT, LGPL or GPL (choice) | Yes, under MIT |
| Turkish | `hyph-tr.tex` | LPPL 1 or later | Yes, with LPPL conditions |
| Turkmen | `hyph-tk.tex` | MIT | Yes |
| Ukrainian | `hyph-uk.tex` | LPPL (no version stated) | Yes, with LPPL conditions |

Languages not in hypher (British English, for example) would come from hyph-utf8 directly and need the same check. The CTAN package `hyph-utf8` is listed as MIT, which covers the package's own code, not every pattern file.

## 12. PDF sealing and time-stamps

| Component | Version (released) | Licence: registry · repository | Maintenance | Provenance | Verdict |
|---|---|---|---|---|---|
| `@signpdf/signpdf` and `@signpdf/placeholder-pdf-lib`, `placeholder-plain`, `utils`, `signer-p12` | 4.0.0 (2026-10-19) | MIT · MIT | Active; 21 open issues | vbuch and contributors; replaces the deprecated `node-signpdf` | Evaluate in S8, with a custom signer that calls the key service |
| `pkijs` | 4.0.1 (2026-10-27) | BSD-3-Clause · BSD-3-Clause (copyright GlobalSign) | Active | Peculiar Ventures | Adopt candidate: CMS and RFC 3161 time-stamp structures (README) |
| `asn1js` | 4.0.0 (2026-10-19) | BSD-3-Clause · BSD-3-Clause | Active | Peculiar Ventures | Adopt with `pkijs` |
| `@peculiar/x509` | 3.1.0 (2026-10-27) | MIT · MIT | Active | Peculiar Ventures | Adopt candidate |
| `@cantoo/pdf-lib` | 2.11.1 (2026-09-15) | MIT · MIT | Active | Cantoo; fork of `pdf-lib` | Adopt with care if a PDF writing library is needed |
| `pdf-lib` | 1.17.1 (2021-11-06) | MIT · MIT | Unmaintained: last commit 2024-07; 320 open issues | Andrew Dillon | Not recommended |
| `node-forge` | 1.4.3 (2026-11-04) | BSD-3-Clause OR GPL-2.0 · dual | Active | Digital Bazaar | Not needed; if used, under BSD-3-Clause |
| Key service SDKs: `@azure/keyvault-keys`, `@aws-sdk/client-kms`, `@google-cloud/kms` | 4.10.2 (2026-06-09), 3.1163.0 (2026-11-05), 6.3.0 (2026-10-12) | MIT · MIT; Apache-2.0 · Apache-2.0; Apache-2.0 · Apache-2.0 | Active | Microsoft, Amazon, Google | Adopt the one matching the chosen key service (FRW-052) |
| pyHanko (Python) | 0.38.1 (2026-11-03) | MIT · MIT | Active; 6 open issues | Matthias Valvekens (individual) | Evaluate in S8: README lists PAdES B-B, B-T, B-LT and B-LTA, RFC 3161, PKCS#11 and interrupted signing for remote keys. A Python signing service would add a runtime, which S8 must weigh against ADR 0016's single-language aim |
| Apache PDFBox (Java) | 3.0.8 (Maven, 2026-07-15) | Apache-2.0 · Apache-2.0 | Active | Apache Software Foundation | Read for ideas |
| EU DSS (`dss-pades`, Java) | 6.5.1 (Maven, 2026-10-14) | not read from the POM · LGPL-2.1 | Active | European Commission | Read for ideas only (validation profiles) |
| iText (`sign`, Java) | 9.8.0 (Maven, 2026-09-30) | not read from the POM · AGPL-3.0-or-later or commercial | Active | Apryse | Read for ideas only |
| veraPDF | 1.30.3 (`validation-model`, Maven, 2026-10-08) | not read from the POM · GPL-3.0-or-later OR MPL-2.0 (README and both licence files) | Active | veraPDF consortium | Tool only: CI validation from S4, under the MPL-2.0 option; never shipped |

## 13. Fonts

The rules (bundling, server use, reserved names, trademarks) are in the legal note §4. Licences as checked:

| Font | Licence | Reserved Font Name | Trademark notice in the font | Source checked |
|---|---|---|---|---|
| Noto Serif, Noto Sans, Noto Sans Mono | OFL-1.1 | None | "Noto is a trademark of Google LLC." | `notofonts/latin-greek-cyrillic` `OFL.txt`; name table of Noto Serif |
| Noto Sans Math | OFL-1.1 | None | Not checked | `notofonts/math` `OFL.txt` |
| STIX Two (Text and Math) | OFL-1.1 | "TM Math" | "STIX Fonts and STIX Two are trademarks of The Institute of Electrical and Electronics Engineers, Inc." | `stipub/stixfonts` `OFL.txt`; name table of STIX Two Text |
| Carlito | OFL-1.1 | "Carlito" | Not checked | `googlefonts/carlito` `OFL.txt` |
| Caladea | OFL-1.1 in the upstream repository; CTAN lists Apache-2.0 and LPPL | None | Not checked | `huertatipografica/Caladea` `OFL.txt`; CTAN API. The two sources disagree; take the version actually bundled and its own licence file |
| Liberation 2.x | OFL-1.1 | "Liberation" | Red Hat's trademark | `liberationfonts/liberation-fonts` `LICENSE` |
| KaTeX fonts | MIT | Not applicable | Not checked | `KaTeX/katex-fonts` `LICENSE` |

## 14. Other dependencies the specification names

| Component | Version (released) | Licence: registry · repository | Scope | Verdict |
|---|---|---|---|---|
| `svelte` | 5.57.3 (2026-10-26) | MIT · MIT | Runtime | Adopt |
| `@floating-ui/dom` | 1.8.0 (2026-07-11) | MIT · MIT | Runtime | Adopt |
| `dompurify` | 3.4.17 (2026-10-12) | MPL-2.0 OR Apache-2.0 · Apache-2.0 text, dual | Runtime (paste sanitiser) | Adopt under Apache-2.0 |
| `canonicalize` | 5.1.0 (2026-09-18) | Apache-2.0 · Apache-2.0 | Runtime (RFC 8785) | Evaluate against FND-005's test vectors |
| `uuid` | 14.0.3 (2026-10-10) | MIT · MIT | Runtime | Adopt |
| `ajv` | 8.20.0 (2026-04-24) | MIT · MIT | Runtime | Adopt |
| `pg` | 8.23.1 (2026-09-30) | MIT · MIT | Service | Adopt |
| `vite` | 8.3.6 (2026-11-05) | MIT · MIT | Build | Tool only |
| `playwright` | 1.65.0 (2026-11-05) | Apache-2.0 · Apache-2.0 | Test | Tool only |
| `axe-core`, `@axe-core/playwright` | 4.14.0 (2026-10-05, 2026-10-15) | MPL-2.0 · MPL-2.0 | Test | Tool only; never shipped |
| PostgreSQL | not pinned | PostgreSQL Licence (`COPYRIGHT`) | Service | Adopt |
| Valkey | not pinned | BSD-3-Clause (`COPYING`) | Service, from stage 2 | Adopt |
| Redis 8 and later | not pinned | RSALv2, SSPLv1 or AGPLv3; Redis 7.2 and earlier remain BSD-3-Clause (`LICENSE.txt`) | Service | Not recommended |
| gVisor, Firecracker | not pinned | Apache-2.0 · Apache-2.0 | Sandbox | Adopt (09 §9.3) |
| TeX Live 2026 and LuaLaTeX | pinned image (09 §9.3) | Many licences | Export worker | See the legal note §3; not a code dependency |

## 15. Feeding the licence gate (FND-011)

**Allow-list for runtime and service dependencies:** MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Zlib, BlueOak-1.0.0, Unicode-3.0, PostgreSQL. **For fonts only:** OFL-1.1. **For data only:** CC0-1.0.

**Allowed with a recorded decision:**

- dual-licensed packages, recording the permissive option taken (`jszip`, `pizzip`, `node-forge`, `dompurify`, `docxtemplater`, the Rust crates under "MIT OR Apache-2.0");
- LPPL-licensed pattern files, shipped next to the compiled module with their notices, changes stated (section 11);
- MPL-2.0 tools that are never shipped (`axe-core`, `veraPDF`).

**Denied:** GPL, LGPL, AGPL, SSPL, RSAL, BUSL, the EigenPal Pro Evaluation License and similar evaluation or "source available" terms, CC-BY-SA or other share-alike licences for code, and any package without licence text in its published artefact.

**Per entry the gate needs:**

- name and exact version;
- the SPDX expression from the registry and from the licence file, both stored, with a failure when they disagree;
- the option chosen for dual licences;
- scope: runtime, service, build, test or separate tool;
- the tarball or crate checksum.

**Notices the build must generate:**

- OFL texts and copyright lines for every bundled font;
- HarfBuzz's licence for `harfbuzz.wasm`;
- the licence files inside `pdfjs-dist` for the files actually shipped;
- the Unicode licence for ICU4X data;
- the notice of every hyphenation pattern file included;
- the Ecma notice for any table generated from the ECMA-376 annex.

## 16. Criteria of SPK-026

| Criterion | Where it is met |
|---|---|
| Covers collaboration rebase, suggestion marks, DOCX parsing and writing, PDF viewing, math display and editing, spellcheck, PDF sealing, the layout core candidates of S7, and the WebAssembly candidates (HarfRust, harfbuzzjs, ICU4X, unicode-linebreak, hypher) | Sections 3 (rebase), 4 (suggestions), 5 (DOCX, including the ADR 0017 building blocks), 6 (PDF viewing), 7 (math), 8 (spellcheck), 12 (sealing), 9 (layout cores: Eigenpal, canvas-editor, Docen, Typst's layout crate, Parley, cosmic-text) and 10 (all five named WebAssembly candidates) |
| Each entry records licence, version, maintenance status and provenance | Every table has these columns; section 1 says how each was read. Gaps are marked "not checked" or "not verified" in place, for example the licences of two Eigenpal dependencies and the languages Harper supports |
| Hyphenation patterns listed per language with their own licences | Section 11: all 48 languages hypher embeds, each with the licence stated in its file and a verdict |
| Copyleft projects appear only as "read for ideas", never as dependencies | Every GPL, LGPL, AGPL and dual GPL-only entry has the verdict "read for ideas only" (SuperDoc, ONLYOFFICE, Fidus Writer, Pandoc, LibreOffice, Hunspell, `hunspell-asm`, LanguageTool, `mathml2omml`, texmath, EU DSS, iText). MPL-2.0 appears only for test tools that are never shipped and for dictionaries that need a decision. GPL and MPL pattern files are excluded in section 11 |
| The list feeds the licence gate (FND-011) | Section 15 gives the allow-list, the conditional list, the deny-list, the data per entry and the notices to generate. Section 2 lists the entries to flag |

## Sources

All consulted on 2026-11-06.

- npm registry, via `npm view` and `https://registry.npmjs.org/<package>`, for every npm package named.
- crates.io API, `https://crates.io/api/v1/crates/<crate>`, for every crate named.
- PyPI, `https://pypi.org/pypi/<name>/json` (python-docx, pyhanko, prosemirror, endesive); NuGet, `https://azuresearch-usnc.nuget.org/query` (DocumentFormat.OpenXml, Clippit, StepWise.ProseMirror, OpenXmlPowerTools); Maven Central, `https://repo1.maven.org/maven2/` (docx4j-core, poi-ooxml, pdfbox, dss-pades, validation-model, itext sign).
- GitHub REST API, `https://api.github.com/repos/<owner>/<repo>`, and licence files from `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<file>` for each repository named.
- ProseMirror's forge: `https://code.haverbeke.berlin/prosemirror/` (licence files of the core modules) and the "moved" notice at https://github.com/ProseMirror/prosemirror-model.
- Eigenpal: https://github.com/eigenpal/docx-editor (`LICENSE`, `packages/pro/LICENSE.md`, `packages/core/package.json`); Internet Archive CDX index, `http://web.archive.org/cdx/search/cdx?url=github.com/eigenpal/docx-editor`, and captures of 2026-03-28, 2026-06-08 and 2026-07-17; the npm tarball of `@docx-editor.dev/core` 2.35.0.
- zip.js type definitions: https://github.com/gildas-lormeau/zip.js/blob/HEAD/index.d.ts. yauzl README: https://github.com/thejoshwolfe/yauzl. fflate README: https://github.com/101arrowz/fflate. Rust `zip`: https://docs.rs/zip/latest/zip/write/struct.ZipWriter.html. Go: https://pkg.go.dev/archive/zip.
- `@rgrove/parse-xml` source, `src/lib/Parser.ts`: https://github.com/rgrove/parse-xml. htmlparser2 source, `src/Parser.ts`: https://github.com/fb55/htmlparser2. READMEs of saxes, sax-wasm, @xmldom/xmldom, slimdom-sax-parser, xml-crypto, xmllint-wasm and libxml2-wasm at their GitHub repositories.
- hypher README and pattern files: https://github.com/typst/hypher (`README.md`, `patterns/`).
- pdfjs-dist 6.5.438 tarball, licence files under `wasm/`, `cmaps/`, `iccs/`, `standard_fonts/`.
- harfbuzzjs 1.6.4 tarball; HarfRust README: https://github.com/harfbuzz/harfrust.
- pyHanko README: https://github.com/MatthiasValvekens/pyHanko. PKI.js README: https://github.com/PeculiarVentures/PKI.js. veraPDF README: https://github.com/veraPDF/veraPDF-library.
- ECMA-376 page: https://ecma-international.org/publications-and-standards/standards/ecma-376/; Ecma IPR policies: https://ecma-international.org/policies/by-ipr/.
- Microsoft Open Specification Promise: https://learn.microsoft.com/en-us/openspecs/dev_center/ms-devcentlp/1c24c7c8-28b0-4ce1-a47d-95fe1ff504bc.
- Font licence files: https://github.com/notofonts/latin-greek-cyrillic, https://github.com/notofonts/math, https://github.com/stipub/stixfonts, https://github.com/googlefonts/carlito, https://github.com/huertatipografica/Caladea, https://github.com/liberationfonts/liberation-fonts, https://github.com/KaTeX/katex-fonts; font files from https://github.com/google/fonts (`ofl/notoserif`, `ofl/stixtwotext`) for their name tables.
- CTAN JSON API, `https://ctan.org/json/2.0/pkg/<name>`, for `hyph-utf8`, `caladea` and the font packages.
- Redis licence: https://github.com/redis/redis/blob/unstable/LICENSE.txt. Valkey: https://github.com/valkey-io/valkey/blob/unstable/COPYING.
- The specification: 01 §7, 02 §2, §5.2, §6, §9.3, 03 §5, 04 §4, 05 §10, 08 §7, 09 §2, §6.1, §6.3, §9.3, §11, §12, 13 §6.1; ADR 0001, 0003, 0016, 0017; the research summary of 2026-09-18; the Rust and WebAssembly assessment of 2026-11-06.
