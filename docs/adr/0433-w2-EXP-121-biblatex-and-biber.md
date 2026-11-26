# ADR 0433: Citations through biblatex and biber (EXP-121)

**Status:** proposed (2026-11-26). Written by lane w2. It applies owner decision 16 and owner decision 126 (`docs/owner-decisions-2026-11-15.md`); the points below that the owner has not answered are marked as proposals.

## Context

EXP-121 asks for a `.bib` file made through typed emitters, biblatex commands for citations, biber in the sandbox and the `.bib` file in the `tex` bundle. ADR 0230 section 1 kept the converter-written bibliography as a default and asked the owner. Decision 16 answered: use a generated `.bib` file and biber, as 09 §3 and §4 say. Decision 126 asked for selectable citation styles, the same in the web view and the PDF, and for an ADR on how they are chosen and stored.

## Decisions

1. **The default route is biblatex.** `ConvertOptions.bibliography` is `biblatex` (default) or `text`. `text` is the converter's earlier route (`citations.ts`), kept as an option and for a citation whose sources are all missing (it prints `(?)`). A document with no source that is cited or listed gets no package, no `.bib` file and no biber run, so its bundle is the same as before.
2. **Two emitters, `bibField` and `bibKey`** (09 §4). A field value is TeX text in the BibTeX syntax. A brace is written as `\textbraceleft{}` or `\textbraceright{}` because BibTeX counts braces whatever precedes them; white space is one space; DOIs and URLs are percent-encoded outside RFC 3986. A key is the source identifier when it is a plain word, otherwise `src<n>`. The attribute table (`attributes.ts`) names them for the attributes of `source_def`. The list of emitters is now ten; `emit.constructors.test.ts` pins it.
3. **Mapping of source kinds to biblatex entry types (proposal).** `article*`, `review*` to `article`; `book`, `classic` to `book`; `chapter` to `incollection`; `paper-conference` to `inproceedings`; `entry*` to `inreference`; `report`, `thesis`, `patent`, `standard`, `webpage`, `post*`, `dataset`, `software`, `manuscript` (as `unpublished`) to the type of the same name; everything else to `misc`. The container title goes to `journaltitle`, `booktitle`, `maintitle` or `titleaddon` by type; the publisher goes to `institution` or `organization` where biblatex wants that. `language` and `extra` are not written (`langid` needs babel names, and `extra` holds CSL variables with no biblatex field). The table is in `bibtex.ts`.
4. **Citation commands.** `normal` is `\parencite`, `narrative` is `\textcite`, `suppressAuthor` is `\parencite*`; several sources use `\parencites` and `\textcites`. A prefix is the pre-note. A locator with its label, then the suffix, is the post-note. All notes go through `text`.
5. **The bibliography node** is `\printbibliography[heading=none,env=DEbib]`. `\defbibenvironment` cannot wrap an entry in `\DEbibentry`, because biblatex prints the entry after the item code, so the environment does what `\DE@par` does once (the block number, the paragraph format) and each item starts a paragraph the same way. The class is not changed, so its version is not. `include: all` adds `\nocite{*}`.
6. **Styles (proposal for decision 126).** The job's `citationStyle` option, else `settings.citationStyle`, else `authorYear`. Five styles: `authorYear`, `numeric`, `alphabetic`, `authorTitle`, `numericComp`. The model's `CITATION_STYLES` still lists two, so `settings.citationStyle` can name only those two until the model adds the others (a CDM change, not made here; the web view's style engine is FE-140). A name the converter does not know gives the warning `citation_style_unknown`. The option is recorded in `manifest.json`, so it changes the bundle hash.
7. **Biber in the sandbox.** `compile.sh` runs `biber --quiet main` when a pass leaves a `main.bcf` that differs from the one biber last read, with the timeout of a pass, and compares `main.bbl` with the other auxiliary files for convergence. A biber exit code of 2 or more fails the job. Each run is a line `biber <rc> <ms>` in `timings.txt`; `compileInSandbox` returns them as `biber` and returns `main.blg` as `biberLog`.
8. **A sandbox change.** Biber is a PAR executable that unpacks 121 MiB (measured with `du` in the image, biber 2.22) on every run into `PAR_GLOBAL_TMPDIR`, which must be writable and must allow execution. A directory unpacked in the image does not work (PAR will not use a read-only one), and the working directory is `noexec`. The sandbox therefore mounts one more tmpfs, `/opt/docedit/par`, 192 MiB, `nosuid`, `nodev`, with execution allowed. This loosens the rule that a job's container executes nothing it wrote: only biber writes there, and a TeX job cannot (paranoid file access). The owner should confirm it (09 §9.3 item 9). Biber's temporary files go to `/work` (`TMPDIR`).
9. **The `tex` target** includes `references.bib` like any bundle file, and the README says to run biber after the first pass.

## Measurements

Taken on 2026-11-26 on the development Windows 11 host, with Podman in its WSL machine and other lanes' jobs running at the same time, one run each, a one-page document with two sources and four citations, tagged PDF on (`exp-121-biblatex.compile.test.ts` and a script with the same document). They are not benchmarks.

| Style | LuaLaTeX passes | Biber runs | Converged | Wall time |
|---|---|---|---|---|
| `authorYear` (`sorting=nyt`) | 3 | 1 | yes | 14 s |
| `numeric` (`sorting=none`) | 4 | 2 | yes | 19 s |

A document without citations still takes two passes and no biber. With citation-order sorting biber runs twice because the second pass adds citation keys to `main.bcf`, and the four passes of the default limit (`DOCEDIT_MAX_PASSES`) are then all used; a document that needs a fifth would end with `converged: false`. Whether to raise the limit for documents with citations is left to the owner.

## Consequences

The converter, the worker and the image change together: the image must be rebuilt (the Containerfile sets `PAR_GLOBAL_TMPDIR` and makes its mount point, `compile.sh` runs biber). A TeX Live upgrade is a class version change (09 §9.4), and this is not one, but the reference PDFs of documents with citations differ from the text route's.
