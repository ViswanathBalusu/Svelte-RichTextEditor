# Legal note: names, licences, fonts and signature claims, 2026-11-06

**Status:** research note, 2026-11-06, written for story SPK-024; not reviewed by the project owner.

> **This is not legal advice.** It is a research note for the project owner, written by a non-lawyer from primary sources read on 2026-11-06. It says where the project's obligations and risks lie and what to ask. Counsel must review the signing claims and the licence choice before launch.

## 1. Scope and summary

SPK-024 asks for five things: the project's name and trademark care, the licences inside the pinned TeX Live image and of the house class, fonts, e-signature claims, and the project licence. They answer risks 10 (licence problems) and 15 (over-claiming signatures) of 11 §9. The [borrow list](2026-11-06-borrow-list.md) checks the licences of the components the project would borrow; this note does not repeat it.

Recommendations in short:

1. **Name.** Choose a name that contains no Microsoft, DocuSign, Adobe or TeX mark, and clear it before anything is published under it (section 2).
2. **Microsoft.** In marketing, the only reference to a Microsoft product is that the product is compatible with a Microsoft format, for example "compatible with Microsoft Word documents (.docx)" (section 2.2).
3. **TeX Live image.** The image is distributed in self-hosted mode, so it ships with a licence manifest, the GPL licence texts and an offer of source; it holds no AGPL component; nothing in an LPPL package is changed in place (section 3).
4. **House class.** License it under Apache-2.0 like the rest of the project, written from scratch (section 3.5).
5. **Fonts.** Ship original OFL font files with their licences. Never subset a font under its own name if it has a Reserved Font Name or a trademark notice, which covers Noto, STIX Two, Carlito and Liberation (section 4).
6. **Signatures.** Say "simple electronic signature with an audit trail and a tamper-evident seal". Never say "qualified", "legally binding everywhere" or anything similar. Section 5.3 has the word lists for FRW-058.
7. **Project licence.** Apache-2.0, for its express patent licence. MIT and MPL-2.0 are the alternatives (section 6).

## 2. The project's name and trademark care

### 2.1 Choosing the name

Every name in the project is a working placeholder (PRODUCT.md, Brand commitments): `<doc-editor>`, DEP, `dep.v1`, `/.well-known/dep`, CDM, `pm-steps/1`, `de-`, `dep.`, `docedit.cls`, `\DE`, `@docedit/*`, `--de-`. SPK-007 chooses the real ones, and until then nothing is published to a public registry under a working name.

Before the owner adopts a name:

- **Clear it.** Search the trade mark registers of the markets the product will be sold in, at least the EU (EUIPO), the United Kingdom (UKIPO) and the United States (USPTO), or WIPO's Global Brand Database across them, for software and software services. Counsel runs or reviews the search; a search engine is not a clearance.
- **Check the places the name will live:** the npm scope, the GitHub organisation, the domain, the CTAN name of the class, the WebSocket subprotocol token and the well-known URI. A well-known URI can be registered with IANA under RFC 8615.
- **Avoid** names that contain or resemble other companies' marks: Microsoft's (Word, Office, 365), DocuSign, Adobe and Acrobat, TeX (section 3.6), and the names of the editors in the research summary. Also avoid acronyms with a strong existing meaning: DEP already means Data Execution Prevention to many developers. That is a findability problem rather than a legal one.
- **Consider registering** the chosen name. The recommended licence grants no trademark rights (Apache-2.0, section 6), so a registered name stays the project's even though the code is open.

### 2.2 References to Microsoft and other companies

PRODUCT.md already commits the product to its own design, icons, fonts, layout and names, and says marketing may say "compatible with" a Microsoft format. SPK-024 makes that the only permitted reference to Microsoft products.

Microsoft's own trademark and brand guidelines point the same way. They allow truthful statements that a product is compatible with a Microsoft product. They ask that Microsoft's marks be used unaltered, as adjectives before nouns ("Microsoft Word documents"), not as nouns or verbs. They forbid implying affiliation or endorsement, using Microsoft's logos, icons or designs "in any manner", and using Microsoft's brands in the name of a product, business or domain.

| Allowed in marketing | Not allowed in marketing |
|---|---|
| "Compatible with Microsoft Word documents (.docx)." | "Word-like", "a Word alternative", "Word for the web, in your app", "replaces Microsoft 365" |
| "Opens and saves .docx files." (no Microsoft name at all) | Screenshots that imitate, or sit beside, Microsoft's interface; any Microsoft icon or logo |
| | A product, package, domain or account name containing a Microsoft mark |

Two points need counsel:

- **The published specification.** The specification names Word for the web as its feature benchmark (13 §1 and §2, ADR 0014). That is engineering documentation, not marketing, but FND-013 publishes the specification on the documentation site. Counsel should say whether the benchmark wording may stay when published, or should describe capabilities without naming the product.
- **Other companies.** The same care applies to DocuSign (the spec's "in the manner of e-signature products" is the right register), Adobe (say "validates in Adobe Acrobat" only if true, with the mark used properly, or avoid it) and Google. A comparison table that names competitors needs counsel before it is published.

### 2.3 The Word file format

The owner's decision on lossless round trip (ADR 0017) means implementing ECMA-376 and ISO/IEC 29500 closely, including Word's own extensions, which Microsoft documents in [MS-DOCX], [MS-OI29500], [MS-OE376] and [MS-ODRAWXML].

- **Patents.** Microsoft's Open Specification Promise lists Office Open XML 1.0 (ECMA-376), ISO/IEC 29500:2008, 2012 and 2016 and the implementer notes [MS-OE376] and [MS-OI29500], and separately [MS-DOCX] and [MS-ODRAWXML]. It is a personal promise not to assert Microsoft's necessary patent claims against conforming implementations. It does not apply to someone who sues Microsoft over its implementation of the same specification. It covers only the required portions described in detail, and it gives no assurance about third parties' patents. Counsel should confirm that the project's use falls inside it.
- **Copyright in the standard.** Ecma's copyright notice for ECMA-376 allows derivative works that implement the standard's functionality in conforming products, provided the notice is kept. Any table the project generates from the standard's annex, as Eigenpal does for preset shape geometry, carries the Ecma notice. This note read the notice as reproduced by a third party (borrow list §5.3) and did not check the annex's own files.
- **Names.** Call the format "DOCX" or "Word documents (.docx)", inside the "compatible with" sentence of section 2.2.

## 3. Licences inside the pinned TeX Live image, and the house class

### 3.1 What TeX Live itself says

TeX Live has no single licence. Its `LICENSE.TL` says everything in it is believed to be freely redistributable, but that each package carries its own terms, found in the TeX Catalogue, and that the statements inside the packages are the final authority. For redistribution it asks three things:

- mention any changes prominently;
- give a changed distribution a clearly different title, for example "<work>, based on TeX Live YYYY";
- never put one's own copyright on the whole distribution.

09 §9.3 already requires a curated image pinned by digest, with a licence manifest generated from the TeX Catalogue and a source offer; SEC-053 builds it.

### 3.2 Licences of what the house class loads

The class's package list is fixed by spike S4 (SPK-017) and enforced by SEC-053. The table covers what 09 §3 names and the usual support packages, with the licence the TeX Catalogue gives (CTAN API, 2026-11-06).

| Component | Role | Licence |
|---|---|---|
| LuaTeX (includes LuaHBTeX) | Engine | GPL-2.0-or-later |
| luaotfload | Font loader | GPL-2.0 |
| LaTeX kernel (`latex-base`), `l3kernel`, `latex-lab`, `tagpdf` | Kernel and tagging | LPPL-1.3c |
| `fontspec`, `unicode-math` | Fonts | LPPL-1.3c |
| `geometry`, `graphics`, `xcolor`, `lua-ul`, `latex-tools` (with `longtable` 4.28), `amsmath`, `etoolbox`, `iftex` | Page, graphics, tables, math, utilities | LPPL-1.3c |
| `hyperref`, `babel`, `fancyhdr`, `colortbl`, `kvoptions`, `luacode` | Links, languages, headers, tables, options, Lua | LPPL-1.3 |
| `hyph-utf8` | Hyphenation patterns | MIT for the package; each pattern file has its own licence (borrow list §11) |
| `stix2-otf`, `carlito` | Fonts | OFL |
| `noto` | Fonts | LPPL and OFL |
| `lm-math`, `tex-gyre` | Fonts | GUST Font License |
| `caladea` | Font | Apache-2.0 and LPPL (CTAN; the upstream repository now says OFL-1.1) |

Two further points:

- **The base system.** The container's base system (the Linux distribution under TeX Live) has its own licences, many of them GPL or LGPL. They belong in the same manifest and the same source offer.
- **No AGPL.** GPL Ghostscript is licensed under the AGPL-3.0. The worker does not need it, because SVG is converted when an asset is processed, not at compile time (09 §2). Keep it, and any other AGPL component, out of the image, so that the AGPL's clause on modified versions used over a network (section 13) never has to be weighed for the hosted service.

### 3.3 Obligations by deployment mode

| Mode | What is distributed | Obligations |
|---|---|---|
| Hosted | PDFs, `layout.json`, logs. The image is run, not distributed | GPL and LPPL conditions attach to distributing the software, not to running it (LPPL clause 1 says running the work is not restricted). GPL-2.0 section 0 covers a program's output only if its contents are a work based on the program. Fonts embedded in the PDFs follow section 4 |
| Self-hosted | The image itself, to each customer | For every GPL component: the licence text and the complete corresponding source, either with the image or through a written offer valid for at least three years (GPL-2.0, section 3). For LPPL packages: unmodified copies with their notices (LPPL clause 2). The licence manifest. TeX Live's requests: changes mentioned, a distinct title such as "<name> export image, based on TeX Live 2026" |
| The `tex` download (09 §11) | The house class and the generated files of one document | The class under its own licence (section 3.5). The generated `main.tex` and `styles.tex` carry the user's content and macros generated by the converter. The download already carries a notice to compile it with the same restrictions (09 §9.3 rule 7); it could also name the image and class version, so that a customer can reproduce the PDF |

### 3.4 LPPL conditions that matter here

The LPPL 1.3c (clause numbers from the licence text):

- **Clause 2:** a complete, unmodified copy may be distributed. Distributing only part of the work counts as modifying it.
- **Clause 3:** a compiled form of an unmodified work may be distributed if recipients can install it exactly as if they had compiled it from the work.
- **Clause 5:** anyone may modify and compile their own copy.
- **Clause 6:** a person who is not the maintainer may distribute a modified version only if:
  - a replacement component identifies itself as modified;
  - every changed component carries prominent notices of the changes;
  - nothing implies that the original authors support it;
  - the unmodified work, or information sufficient to obtain it, goes with it.
- **Clause 7:** a compiled form of a modified version may be distributed only if the modified version itself goes to every recipient, under clause 6.

Consequences:

1. Never edit an LPPL package file inside the image. Change behaviour through the class's own code and the hooks the kernel provides.
2. Hyphenation patterns compiled into a WebAssembly module, as hypher does, fall under clauses 3, 6 and 7. One file in hypher's set, Catalan, is already a modified version. The simplest compliant form is to ship the exact pattern files, with their notices, next to the compiled module. Counsel confirms before LPPL patterns ship in the editor (borrow list §11).

### 3.5 The house class's own licence

**Recommendation: Apache-2.0.** Write the class from scratch. Copy no code from LPPL classes such as `article.cls`. If some LPPL code is adapted, keep it in a separate file under the LPPL, with its own name and the notices of clause 6.

| Option | For | Against |
|---|---|---|
| Apache-2.0 (recommended) | One licence for the whole project; express patent licence; CTAN lists Apache 2.0 among the licences it accepts; the trademark clause protects the class's name | Unusual for a LaTeX class; does not by itself stop a changed copy keeping the file name |
| LPPL-1.3c | The LaTeX norm; clause 6 makes a changed copy identify itself, which protects users from silently different output | A second licence to explain; conditions on customers who change the class; no express patent licence |
| Both, at the user's choice | Familiar to LaTeX users, permissive for everyone else | Two licences to keep in step |

Whatever the licence, the integration guide should ask anyone who changes the class to rename it, because the class version is part of every cache key and of reproducibility (09 §2, §9.4).

### 3.6 TeX's name

"TeX" is a trademark of the American Mathematical Society, as the front matter of TeX manuals states. This was read in *TeX for the Impatient* on CTAN and not checked against a trade mark register. "Typeset with LaTeX" and "LuaLaTeX" are descriptive and fine. The product and the image should not be named "…TeX".

## 4. Fonts

### 4.1 What the Open Font License allows

The default set contains only fonts whose licences allow bundling and server use (02 §6). All are under the SIL Open Font License 1.1 except KaTeX's fonts, which are MIT. The OFL and its FAQ (version 1.1-update7, November 2023; page updated 12 January 2026) say:

- **Bundling.** OFL fonts may be bundled with any software, including commercial software, but never sold by themselves. Each copy carries the copyright statement and the licence; the FAQ lists the copyright statement, the licence notice and the licence text as the minimum (FAQ 1.3, 1.4, 1.20).
- **Serving fonts.** Fonts may be hosted on a server and sent to clients, provided the full font package, with its licence, is available (FAQ 1.8, 1.9). The editor loads font files from the manifest (02 §6), which is this case.
- **Server-side use.** Nothing in the OFL restricts using a font to render documents on a server, as the LuaLaTeX workers do. The manifest records each font's licence (09 §5).
- **Embedding.** Embedding a font in a document, "either in full or a subset", is allowed, and the modification and redistribution restrictions do not apply to it (FAQ 1.12). The document's own licence does not change (FAQ 1.13). The subsets LuaLaTeX embeds in PDFs are therefore fine.

### 4.2 Reserved Font Names, trademarks and subsetting

- **Reserved names.** A Modified Version may not use a Reserved Font Name without written permission (OFL condition 3). Subsetting a web font counts as modification and "would not normally allow the use of RFNs" (FAQ 2.6). Optimised web fonts are Modified Versions that must be renamed (FAQ 2.5). The only exception requires full functional equivalence, including the same full character inventory, which the FAQ calls technically very difficult (FAQ 2.7, 2.8).
- **Trademarks.** Trademarks are separate from Reserved Font Names: the OFL grants no trademark rights, and trademark notices must stay in derivative fonts (FAQ 3.7). Noto has no Reserved Font Name, but its files say "Noto is a trademark of Google LLC".

Rules for the project:

1. **No subsetting in version 1.** Serve original font files. Whether a WOFF2 conversion counts as modification was not checked for this note; ask counsel before converting.
2. **Rename any subset.** If subsetting becomes necessary later (CJK faces are large; ADR 0016), every subset of a font with a Reserved Font Name or a trademark notice gets a new family name, for example built from the hash alias of 02 §3. Keep its copyright, licence and trademark notices, and never use the original name to identify it to users (FAQ 5.3). Applied to the default set, that is every font except Caladea and the KaTeX fonts.
3. **PDF subsets need no renaming** (section 4.1).
4. **Notices.** Every bundled font's licence text and copyright lines go into the element bundle and the images (FND-011).

### 4.3 The default set

| Font | Licence | Reserved Font Name | Trademark notice | Subset under its own name? |
|---|---|---|---|---|
| Noto Serif, Noto Sans, Noto Sans Mono | OFL-1.1 | None | "Noto is a trademark of Google LLC." | No (trademark) |
| STIX Two Text and Math | OFL-1.1 | "TM Math" | "STIX Fonts and STIX Two are trademarks of The Institute of Electrical and Electronics Engineers, Inc." | No |
| Carlito (substitute for Calibri) | OFL-1.1 | "Carlito" | Not checked | No |
| Caladea (substitute for Cambria) | OFL-1.1 upstream; CTAN lists Apache-2.0 and LPPL | None | Not checked | Check the bundled version's own licence file first |
| Liberation 2.x (substitutes for Arial, Times New Roman, Courier New) | OFL-1.1 | "Liberation" | Red Hat's | No |
| KaTeX fonts (on-screen math) | MIT | Not applicable | Not checked | MIT allows it; keep the notice |

Substitutes need one more kind of care. An imported document names the font it asks for ("Calibri"), and the editor substitutes Carlito (02 §6). The interface may show the requested name and the substitute used. Nothing may suggest the Microsoft font is included, and marketing never names it.

### 4.4 Fonts that arrive with other components

- **PDF.js.** `pdfjs-dist` bundles Liberation fonts under their old 1.x terms: GPL-2.0 with a font-embedding exception, plus Red Hat's condition that modified versions drop its trademark (borrow list §6). The project's own PDFs embed their fonts, so leave `standard_fonts/` out of the distributable, or ship it with its licence.
- **Eigenpal.** If Eigenpal's font packages are ever adopted, their stated licences include the GUST Font License, which needs its own check (borrow list §9.1).

### 4.5 Fonts supplied by tenants

Tenants may add fonts they are licensed to use (02 §6). Commercial font licences can restrict server use, web serving and embedding in PDFs, so the tenant must confirm, in the terms of service and when uploading, that it holds those rights. The fonts stay scoped to that tenant's jobs (09 §5). The manifest's licence field records what the tenant declared; the service does not vouch for it.

## 5. E-signature claims

### 5.1 What the product provides

The product provides a simple electronic signature with an audit trail and a tamper-evident seal applied by the operator, or by the tenant's own key (12 §8.3, ADR 0013). Advanced and qualified signatures are reached later through a `SignatureProvider` adapter (phase 4). Participants are authenticated by the host. The service records the host's assertion and does not vouch for identity (12 §7).

### 5.2 Why the forbidden claims would be wrong

- **European Union.** Under the eIDAS Regulation, an electronic signature "shall not be denied legal effect and admissibility as evidence in legal proceedings" solely because it is electronic or not qualified (Article 25(1)). Only a qualified electronic signature has "the equivalent legal effect of a handwritten signature" (Article 25(2)). So "legally equivalent to a handwritten signature" belongs to qualified signatures alone; the weight of a simple signature is for a court to assess.
  - The wording above was read in the United Kingdom's retained copy of the Regulation, which keeps the original text of those two paragraphs.
  - The current EU text, as amended by Regulation (EU) 2024/1183, could not be fetched for this note (EUR-Lex refused automated access). Counsel checks it and the national rules on form for particular documents.
- **United States.** The ESIGN Act gives electronic signatures and records legal effect, but 15 U.S.C. §7003 excludes:
  - wills, codicils and testamentary trusts;
  - adoption, divorce and other family-law matters;
  - most of the Uniform Commercial Code;
  - court orders, notices and filings;
  - notices of utility shut-off;
  - notices of default, foreclosure or eviction for a primary residence;
  - cancellation of health or life insurance;
  - product recall notices;
  - documents that must accompany hazardous materials.

  ESIGN also has a consumer-consent rule (15 U.S.C. §7001(c)) for information a law requires to be given to consumers in writing; it was not re-read for this note. The ceremony and evidence record address intent, consent and retention (12 §8.3), but they cannot make an excluded document signable.
- **Everywhere else.** The first jurisdictions are undecided (SPK-011). Until they are chosen and reviewed, nothing can be said about them.

"Legally binding everywhere", "valid for any document" and "accepted in every country" are therefore false as general statements.

### 5.3 Wording

This is input for the maintained phrase list of FRW-058, which fails the build on a match in interface strings, documentation, API descriptions, the certificate template and marketing copy.

**Never say**, about the native signature, the seal or the time-stamp:

- "qualified", "QES", "qualified electronic signature", "qualified electronic seal", "qualified time-stamp", "eIDAS-qualified"; the EU trust mark;
- "advanced electronic signature", "AdES";
- "legally binding everywhere", "legally binding in all countries", "valid worldwide", "valid for any document";
- "court-proof", "guaranteed admissible", "always enforceable";
- "equivalent to a handwritten signature", "the same as a wet signature";
- "notarised", "certified signature";
- "identity verified", "verified signer" (identity is asserted by the host);
- "tamper-proof", "cannot be forged" (the seal makes changes evident, not impossible);
- "eIDAS-compliant", "ESIGN-compliant", "UETA-compliant" as blanket claims.

**Say**, subject to counsel:

- "A simple electronic signature with an audit trail and a tamper-evident seal applied by [operator], or by your organisation's own key."
- "Records who signed, when, and how the host application says it authenticated them."
- "Any change to the sealed PDF after sealing can be detected."
- "Time-stamped by [time-stamping authority]."
- "Whether an electronic signature suits a particular document and jurisdiction is a legal question for you. Some documents need another form."
- "Advanced and qualified signatures through [provider]." This one only once the adapter exists, and then using the provider's own description of the level.

### 5.4 The seal

Under eIDAS an electronic seal belongs to a legal person. Here that is the operator or each tenant, which is SPK-011's decision.

- **Not "qualified".** A qualified electronic seal needs, among other things, a qualified certificate for seals from a qualified trust service provider. This note does not check the full requirements; counsel does. Keeping the key in a hardware security module or a cloud key service (12 §8.2) protects the key, but does not make the seal qualified.
- **The time-stamp.** Describe it by the name of the authority that issued it. Whether it may be called "qualified" depends on that authority's status, which counsel checks once S8 (SPK-021) chooses one.

### 5.5 Patents

Risk 10 lists e-signature patents. This note cannot assess patents.

- Apache-2.0's patent licence covers only what contributors contribute; it does nothing about third parties' patents.
- Microsoft's promise covers only the Office Open XML claims of section 2.3.

If counsel advises it, a freedom-to-operate review should precede selling workflows (phase 2).

### 5.6 Process

| Story | Role |
|---|---|
| FRW-058 | Runs the wording check in CI |
| FRW-087 | Records counsel's review of the interface strings, the consent text, the certificate template and the evidence record. Until it is done, sealing and certificates are not announced for production use |
| SPK-011 | Chooses the jurisdictions and the sealing party that counsel reviews against |

## 6. The project licence

### 6.1 Recommendation: Apache-2.0

License the code under the Apache License 2.0: packages, services, the house class and the conformance kit. The reasons:

- **Patent licence.** Each contributor grants an express patent licence for their contributions (section 3). Anyone who sues claiming the work infringes a patent loses that licence.
- **Notices.** Redistribution keeps the licence, notices of changes and the NOTICE file's attributions (section 4). This is light, and it is the mechanism the project's own third-party notices use (FND-011).
- **No trademark licence** (section 6), so the project's name stays protected.
- **Compatibility.** Apache-2.0 code can be included in GPL-3.0 projects, though not the reverse. The FSF has never considered it compatible with GPL-2.0, because of the patent-termination and indemnification terms.
- **Position.** It keeps the permissive licence that PRODUCT.md names as part of the product's position.

### 6.2 Trade-offs

| | Apache-2.0 (recommended) | MIT | MPL-2.0 |
|---|---|---|---|
| Express patent licence | Yes, with termination on patent suits | No; at most an implied licence | Yes |
| Copyleft | None | None | File-level: changed MPL files must be available in source when distributed |
| Burden on embedders | Keep licence, notices and NOTICE | Keep licence and copyright notice | Keep notices; publish changes to MPL files |
| GPL-2.0-only projects can include it | No | Yes | Through MPL's secondary-licence clause, unless marked incompatible |
| Fit with dependencies | Combines with MIT, BSD, ISC (ProseMirror, Svelte and KaTeX are MIT) | Same | Same |
| Effect on the position | Permissive | Permissive | Weak copyleft; some company policies restrict it |
| Choose it if | The default | The owner values brevity and GPL-2.0 compatibility over a patent licence | The owner wants changes to the component's own files returned |

### 6.3 Contributions

Before outside contributions arrive, decide between the Developer Certificate of Origin, which is lighter, and a contributor licence agreement such as the Apache Individual CLA, which lets the project relicense later. Without a contributor agreement, changing the licence later generally needs every contributor's consent. Counsel chooses.

### 6.4 The specification and the protocol

DEP is meant to be implemented by other teams from the specification (R6, spike S6). Apache-2.0's patent licence attaches to the code, so a team that implements the protocol from the prose, without the code, may not be covered by it. Consider publishing the specification under a licence with a patent commitment for implementers. The Open Web Foundation Agreement 1.0 is one: it grants a copyright licence to the specification and a promise not to assert patent claims "infringed by the implementation of the Specification". Counsel chooses.

### 6.5 Notices

The licence gate (FND-011) generates the NOTICE file and the third-party notices for the element bundle and every image, from the borrow list.

## 7. Questions for counsel

1. Clearance of the chosen name in the target markets (section 2.1).
2. Whether the specification's benchmark wording may be published as is (section 2.2), and any comparison with named competitors.
3. Coverage of the project's DOCX work by Microsoft's Open Specification Promise, and Ecma's terms for the ECMA-376 annex (section 2.3).
4. The form of the GPL source offer for the self-hosted image, including the base system (section 3.3).
5. LPPL hyphenation patterns compiled into a WebAssembly module (section 3.4).
6. The house class under Apache-2.0 (section 3.5).
7. The font subsetting rules and trademark notices for Noto, STIX Two and Liberation; WOFF2 conversion (section 4.2).
8. The signing word lists, consent text, certificate of completion, and the seal and time-stamp wording, per chosen jurisdiction (section 5; FRW-087).
9. Patents in e-signature workflows (section 5.5).
10. Apache-2.0 for the code, the contributor terms, and the specification's licence (section 6).
11. Eigenpal's evaluation licence, which assigns disclosed modifications to EigenPal, and the rule that nobody clones that repository (borrow list §9.1).

## 8. Criteria of SPK-024

| Criterion | Where it is met |
|---|---|
| Covers the project's name and ordinary trademark care in marketing; "compatible with" a Microsoft format is the only permitted reference to Microsoft products | Section 2: choosing and clearing the name (2.1); the only permitted Microsoft reference and Microsoft's own guidelines, with allowed and forbidden examples (2.2); the file format (2.3) |
| Covers the licences inside the pinned TeX Live image and the licence of the house class | Section 3: TeX Live's terms (3.1); licences of what the class loads (3.2); obligations per deployment mode (3.3); LPPL conditions (3.4); the class's licence (3.5) |
| Covers fonts: bundling and server use, and that fonts under the OFL with reserved names are not subsetted under their own name (02 §6) | Section 4: bundling, serving, server use and embedding (4.1); Reserved Font Names, trademarks and the subsetting rules (4.2); the default set with names and trademarks (4.3); fonts inside other components and from tenants (4.4, 4.5) |
| Covers e-signature claims: the product never says "qualified", "legally binding everywhere" or similar (12 §8.3) | Section 5: what is provided; why the claims are wrong in the EU and the US; the word lists for FRW-058; the seal; patents; the review process |
| Recommends the project licence, with Apache-2.0 recommended for its patent grant, and states that counsel reviews signing claims before launch | Section 6 recommends Apache-2.0 with the trade-offs against MIT and MPL-2.0. The notice at the top and sections 5.6 and 7 say counsel reviews the signing claims and the licence choice before launch. Not met by this note itself: the counsel review, which is FRW-087's |

## Sources

All consulted on 2026-11-06.

- Microsoft, Trademark and Brand Guidelines: https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks
- Microsoft, Open Specification Promise (published 2006-09-12, revised 2023-02-24): https://learn.microsoft.com/en-us/openspecs/dev_center/ms-devcentlp/1c24c7c8-28b0-4ce1-a47d-95fe1ff504bc
- Ecma International, ECMA-376: https://ecma-international.org/publications-and-standards/standards/ecma-376/; IPR policies: https://ecma-international.org/policies/by-ipr/; software policy: https://ecma-international.org/policies/by-ipr/ecma-international-policy-on-submission-inclusion-and-licensing-of-software. Ecma's ECMA-376 notice as reproduced in the npm package `@docx-editor.dev/core` 2.35.0, `licenses/ECMA-376.md`.
- TeX Live, `LICENSE.TL`: https://tug.org/texlive/LICENSE.TL
- CTAN JSON API, package records: `https://ctan.org/json/2.0/pkg/<name>`; licence list: https://ctan.org/json/2.0/licenses
- LaTeX Project Public License 1.3c: https://www.latex-project.org/lppl/lppl-1-3c.txt
- GNU General Public License version 2: https://www.gnu.org/licenses/old-licenses/gpl-2.0.html
- GPL Ghostscript licence: https://github.com/ArtifexSoftware/ghostpdl (`LICENSE`, `doc/COPYING`)
- *TeX for the Impatient*, front matter, on CTAN: https://ctan.math.washington.edu/tex-archive/info/impatient/book.pdf
- SIL Open Font License 1.1: https://openfontlicense.org/open-font-license-official-text/; OFL FAQ: https://openfontlicense.org/ofl-faq/
- Font licence files and name tables: see the borrow list, section 13 and Sources.
- Regulation (EU) No 910/2014, Article 25, as retained in UK law: https://www.legislation.gov.uk/eur/2014/910/article/25. The consolidated EU text (https://eur-lex.europa.eu/eli/reg/2014/910/oj) could not be fetched.
- 15 U.S.C. §7003: https://www.law.cornell.edu/uscode/text/15/7003; 15 U.S.C. §7001: https://www.law.cornell.edu/uscode/text/15/7001
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0; Apache's GPL compatibility page: https://www.apache.org/licenses/GPL-compatibility.html
- MIT License: https://opensource.org/license/mit; Mozilla Public License 2.0: https://www.mozilla.org/en-US/MPL/2.0/
- Open Web Foundation Agreement 1.0: https://www.openwebfoundation.org/the-agreements/the-owf-1-0-agreements-granted-claims/owfa-1-0
- The specification and backlog: PRODUCT.md (Brand commitments, Capabilities and Constraints); README (working names); 02 §3, §6; 09 §2, §3, §5, §9.3, §9.4, §11; 11 §9; 12 §7, §8; 13 §1, §2; ADR 0013, 0014, 0016, 0017; stories SPK-007, SPK-011, SPK-021, SEC-053, FND-011, FND-013, FRW-058, FRW-087.
