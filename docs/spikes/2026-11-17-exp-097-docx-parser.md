# Spike EXP-097: which parser the DOCX importer builds on

**Status:** spike result, 2026-11-17, lane w2. The recommendation is proposed; the owner has not decided it ([ADR 0383](../adr/0383-w2-EXP-097-docx-parser.md)). Two of the candidates in the usual lists (docx4j and Apache POI) were compared on paper and not run. Section 6 says why.

## Question

Should the DOCX importer of `packages/export-docx` build on an existing parser (adopt), take one over (fork), or stay what it is (build)? Four things decide it (story EXP-097): licence, maintenance and security history; how much structure each candidate recovers from real Word files; how each behaves on hostile files; and, for a candidate outside Node.js, how it would run in a sandboxed worker.

## Answer

**Build.** Keep the importer of `packages/export-docx` and its own XML reader. No candidate gives the importer what A2 needs (a source map with byte positions, kept parts, and a path back to the original package), and the one that recovers the most structure, the Open XML SDK, is a .NET library that crashed its process on deeply nested XML. mammoth, the candidate the story names, writes lossy HTML, drops tracked changes, and read a local file named by a linked picture in version 1.10.0 (the advisory of CVE-2025-11849; reproduced here). The Open XML SDK stays useful as a second reader for tests (section 5).

## 1. How this was measured

- **When and where:** 2026-11-17, on the maintainer's Windows 11 Pro machine (build 10.0.26300), Intel Core i9-10900KF (20 logical processors), 128 GB. Other agents were running builds and tests on the same machine, so every time below is indicative, not a benchmark.
- **Versions:** Node.js 22.18.0, .NET SDK 10.0.402 with `DocumentFormat.OpenXml` 3.5.1, Python 3.11.9 with `python-docx` 1.2.0, `mammoth` 1.13.0 (latest) and 1.10.0 (before the advisory's fix), the importer at commit `e3ce61f`. The candidates were installed in a scratch directory outside the repository. Nothing was added to the repository's dependencies.
- **Corpus:** the 78 real Word files of S11 (`packages/export-docx/corpus`, listed in `SOURCES.md`: 37 from Apache POI, 23 from docx4j, 18 from python-docx). They come from several generators, but they are test files of those libraries, so they favour the libraries' own shapes. `poi/deep-table-cell.docx` is a fuzzing file with 5,000 nested table cells; it is reported on its own.
- **Hostile set:** eight packages made by `docs/spikes/exp-097/make-hostile.mts`: the seven of `packages/export-docx/test/hostile-corpus.test.ts` (EXP-110 criterion 2) and an eighth, a picture linked to a local file that holds a marker text. A candidate that puts the marker in its output has read a file outside the package.
- **Method:** one child process per file and candidate, `docs/spikes/exp-097/run-eval.mts`. The candidates' probes are `runner-own.mts`, `runner-mammoth.mjs`, `openxml-probe/` and `runner-python-docx.py`. Each prints its result as one line of JSON. Raw results: `docs/spikes/exp-097/results.json`. Licence, maintenance and advisory data: `docs/spikes/exp-097/collect-metadata.ps1` and `metadata.json`, read from the registries, GitHub and the OSV database on 2026-11-17.
- **"Structure recovered"** is counted against the XML of each file (regular expressions on `document.xml`, `comments.xml` and `footnotes.xml`, with `mc:Fallback` branches removed): tables, pictures, tracked-change identifiers, comments, footnotes (not separators) and hyperlinks, and **text recall**, the share of the words of `w:t` (not `w:delText`) in `document.xml` that a candidate's text holds, as a multiset. These are counts, not proof that a structure is usable: they say that the candidate saw it, not that it can write it back.
- Peak memory is the peak working set of the process (resident set for Node.js), so it includes the runtime itself (about 25 MB for Python, about 36 MB for .NET, about 75 MB for Node.js here).

## 2. Licence, maintenance and security history

Data of 2026-11-17. "Advisories" are the entries OSV holds for the package, not a proof that there are no others. No advisory was read beyond its title, fixed version and date.

| Candidate | Runtime | Licence | Latest release (date) | Repository last pushed | Advisories (OSV) |
|---|---|---|---|---|---|
| mammoth 1.13.0 | Node.js | BSD-2-Clause | 2026-09-26 | 2026-10-16, not archived | 1: GHSA-rmjr-87wv-gf87 (CVE-2025-11849), directory traversal, published 2025-10-17, fixed in 1.11.0 |
| `@xmldom/xmldom` 0.9.12 (mammoth's XML parser; the install resolved 0.8.15) | Node.js | MIT | 2026-08-21 | not read | 22; 20 of them published in 2026 (the latest 2026-09-08); some concern serialisation, others parsing (quadratic time and memory, ReDoS). Which of them 0.8.15 still carries was not checked one by one |
| Open XML SDK 3.5.1 | .NET | MIT | 2026-03-18 (GitHub release) | 2026-11-16, not archived | 0 |
| python-docx 1.2.0 | Python | MIT | 2025-06-17 | 2026-08-01, not archived | 2, both of 2016 and 2022 (XML external entities), fixed in 0.8.6 |
| docx4j-core 17.3.6 | JVM | Apache-2.0 (the POM) | 2026-11-08 (Maven Central) | 2026-11-14, not archived | 1: GHSA-gc95-3vw8-vg43, stack overflow from a cyclic `w:basedOn` chain, published 2026-08-17, fixed in 11.5.14 |
| Apache POI poi-ooxml 6.0.0 | JVM | Apache-2.0 | 2026-10-22 (Maven Central) | 2026-11-17, not archived | 1: GHSA-gmg8-593g-7mv3, improper input validation in OOXML parsing, published 2025-04-09, fixed in 5.4.0 |
| Pandoc 3.14 | Haskell binary, a separate process | GPL-2.0 | 2026-11-12 | 2026-11-15, not archived | none listed |
| `@rgrove/parse-xml` 5.2.0 (an XML parser only; it replaces `src/xml.ts`, not the importer) | Node.js | ISC | 2026-11-12 | 2026-11-12, not archived | 0 |

What it says:

- All the libraries are alive. None is abandoned.
- Every licence except Pandoc's is permissive. Pandoc's GPL would bind the product only if it were linked; as a separate process it would not, but the product would then ship and update a Haskell binary for one feature.
- The recurring security shape is the same in the XML layer of every candidate: stack depth (docx4j, the Open XML SDK and mammoth below), entity expansion (python-docx 2022) and file access (mammoth). An importer is attacked at its parser first.
- mammoth's own advisory is the one that touches this story's threat model: a Word file made a server read a local file. It is fixed in 1.11.0, and section 4 reproduces both sides of the fix.

## 3. Structure recovered on the 78 real files

77 files, without `poi/deep-table-cell.docx`; the figure is the share of what the XML holds that the candidate saw, with the count in brackets. "Text" is word recall.

| | Text | Tables | Pictures | Tracked changes | Comments | Footnotes | Hyperlinks |
|---|---|---|---|---|---|---|---|
| Files that hold it (77 files) | 3,601 words | 19 files | 6 | 5 | 8 | 5 | 10 |
| Open XML SDK 3.5.1 | 99.1% (3,567) | 55/55 | 15/15 | 162/162 | 21/21 | 6/6 | 29/29 |
| mammoth 1.13.0 | 97.9% (3,527) | 55/55 | 13/15 | 0/162 | 21/21 | 4/6 | 29/29 |
| mammoth 1.10.0 | 97.5% (3,510) | 55/55 | 13/15 | 0/162 | 21/21 | 4/6 | 29/29 |
| python-docx 1.2.0 | 86.4% (3,112) | 50/55 | 13/15 | 0/162 | 21/21 | 0/6 | 29/29 |
| The importer (build) | 80.2% (2,889) | 46/55 | 14/15 | 42/162 | 0/21 | 0/6 | 0/29 |

How to read the table:

- The Open XML SDK is a typed view of the whole package, so it sees everything that is there. It converts nothing: its counts are what a mapper could read from it, and the mapper (to the CDM) would still be ours to write.
- mammoth converts, and loses what HTML cannot hold: it has no form of a tracked change (inserted text is written as plain text and deleted text is dropped), and the importer's story needs both as suggestion marks (EXP-103). It reads comments only with a style map entry (used here).
- python-docx has no API for tracked changes or footnotes in 1.2.0, and its `paragraph.text` leaves out runs inside `w:ins`.
- **The importer's low figures are its present state, and it is expected to improve.** It keeps hyperlinks, fields, comment anchors, footnote references, content controls and revisions it cannot express as preserved atoms ("preserved, not editable", A2), so they are in the document and in the exported file, but they are not CDM text or marks: hence 0 hyperlinks, 0 comments and 0 footnotes as CDM structures, and the 80.2% of words (the rest are inside preserved atoms). Its job is different from the others': S11 round-trips all 78 files (R0 and R1), which none of the others attempts. Mapping comments, footnotes and hyperlinks to CDM structures belongs to later stories.
- The figures of "tracked changes" count revision identifiers: the importer keeps the 42 it can express as `ins` and `del` marks and preserves the rest (EXP-103 and owner decision 13 on revisions the CDM cannot express).

**The fuzzing file `poi/deep-table-cell.docx`** (5,000 nested cells): the importer imports it in 552 ms (peak 146 MB); mammoth (both versions), the Open XML SDK and python-docx fail on it. mammoth raises `RangeError: Maximum call stack size exceeded`, python-docx `XMLSyntaxError: Excessive depth in document: 256`, and the Open XML SDK's process ends with a stack overflow (exit code 0xC00000FD).

**Time:** parse time of one file, in a fresh process, median over the 77 files: python-docx 8.6 ms, mammoth 103 ms, importer 125 ms, Open XML SDK 370 ms (a cold .NET runtime in each process). The maximum was 1.8 s for the importer (on the largest files), 0.9 s for the Open XML SDK. The importer is in the same range as the others and does more work (it builds the source map and hashes the nodes).

## 4. Behaviour on hostile files

Each cell is the outcome in one process: "refused" (an error that names the reason), "read" (no error), "failed" (an error from the runtime, caught), "killed" (the process ended without a result). Time is the wall time of the process, and the peak working set follows.

| Hostile file | Importer | mammoth 1.13.0 | Open XML SDK | python-docx |
|---|---|---|---|---|
| h1 a 40 MB entry of zeros that compresses to a few kilobytes (zip bomb) | refused: compression ratio; 0.4 s, 89 MB | read; 0.4 s, 79 MB | read; 0.4 s, 50 MB | read; 27 MB |
| h2 a document type declaration with nested entities | refused: type declarations are refused; 0.5 s, 92 MB | failed: entity not found (xmldom); 0.4 s, 72 MB | refused: DTD prohibited; 0.3 s, 36 MB | read; 0.4 s, 27 MB |
| h3 a VBA project in the package | refused: macro-enabled files; 0.4 s | read | read | read |
| h4 an external hyperlink relationship | read, 0.6 s | read | read | read |
| h5 an embedded package as an object | read, 0.5 s | read | read | read |
| h6 20,000 nested `w:ins` elements | read; 1.1 s, 139 MB | failed: stack overflow (caught); 0.5 s | **killed: stack overflow, uncatchable** | failed: depth 256 |
| h7 a table of 200 rows and 50 cells | read; 0.7 s, 138 MB | read; 1.1 s, **217 MB** | read; 0.6 s, 64 MB | read; 1.4 s, 33 MB |
| h8 a picture linked to a local file | read, the marker is not in the output | read, not in the output | read | read |

Notes:

- **Zip bomb:** the three libraries did not inflate the entry because they never read that part. A part they do read (a 40 MB `document.xml`) was not tested. The importer refuses on the ratio before it inflates anything (EXP-099).
- **Document type declarations:** python-docx read the file. Whether it expanded the entities was not measured, so no claim is made either way. mammoth's failure is a failure of its parser (xmldom 0.8.15), not a refusal made for security.
- **h8, the advisory:** a picture whose relationship is external and points at a local file. With mammoth 1.10.0 the marker text of the file appeared, base64-encoded, in the picture's data URI: **the library read a file outside the package**. With mammoth 1.13.0 it did not. That is the behaviour of CVE-2025-11849 and of its fix, reproduced on this machine. For the importer, the Open XML SDK and python-docx the result is not a proof: their probes read no picture bytes, so the test shows only that they did not fail. Whether they resolve a linked picture was not tested.
- **h4 and network access:** whether any candidate made a network request was observed only for the importer (EXP-110 stubs `fetch`, `XMLHttpRequest` and `WebSocket`). The target of h4 does not resolve (`.invalid`), so a request would have failed silently. This run does not show that the others make none.
- **Stack depth is the shape that separates the candidates.** Three of four failed on a 20,000-level nest, and one of them, the SDK, takes its process down with an error no handler can catch. The importer survived both h6 and the 5,000 nested cells of the fuzzing file. A second runtime would therefore have to run in its own process, and the host would have to treat "no result" as a refusal.
- **Memory:** mammoth is the heaviest on the large table (217 MB against 138 MB for the importer), the SDK the lightest. None of these figures is a spec target (there is none for import); EXP-110 still wants the importer's memory bounded and measured.

## 5. What it means for a candidate in another runtime

Only the Open XML SDK is a candidate that fits the product's needs on structure and is not Node.js. It would run like this, and it carries these costs:

- **How it would run:** as a container, started per job with `podman run --network=none --read-only`, reading the uploaded file from a volume or standard input and writing JSON (or an archive) to standard output. This is how the export worker already runs LuaLaTeX (`services/export-worker/src/sandbox*.ts`, `services/asset-worker/src/sandbox-podman.ts`). The container image would carry the .NET runtime and the program, and the job would end with the process: a stack overflow like h6 is then a failed job, not a dead service.
- **What it means for the reference service:** the service is Node.js and the importer is a universal package (no Node.js or browser APIs; `packages/export-docx/src` is checked by `.dependency-cruiser.cjs`), so today the importer can run anywhere TypeScript runs, in the service, in a worker, or in a test. A .NET reader adds a second runtime to build, scan, patch, ship and keep in step with the first, and the importer's source map (byte positions of start tags, gaps between children) cannot come out of the SDK, whose objects carry no source positions. The preservation layer of ADR 0017 needs those positions to patch parts without rewriting them.
- **The production backend:** the owner prefers Rust (decision 1 of 2026-11-15). A .NET importer would be a third runtime in that picture; the TypeScript importer would run in the Node.js reference service as it does now, and its port to Rust would be a port of a library with a conformance corpus (S11), not of a binding.
- **Where it would still help:** as a second reader in tests, which is what `packages/export-docx/test/parser-eval.test.ts` already does with `@rgrove/parse-xml` for the XML layer. The probe in `docs/spikes/exp-097/openxml-probe/` sees every table, picture, tracked-change identifier, comment, footnote and hyperlink that the XML holds in 77 of 78 files (section 3), and could be the base of such a check. It is not a dependency of the repository.

## 6. What was not done

- **docx4j and Apache POI were not run.** The machine has no Maven or Gradle, and putting about a dozen jars on a class path by hand means downloading files from outside a package manager. Both are Apache-2.0, alive, and each has one advisory (above); both would need a JVM in the worker, with the costs of section 5 and an extra one, since docx4j reads through JAXB. A run of them would complete criterion 2 of the story; it is the work that remains.
- Pandoc and LibreOffice were not run. They are converters, not readers that keep the original, which puts them outside the question; S11 already used LibreOffice 26.8.3.1 as a check that exported files open.
- The structure counts come from regular expressions over the XML, so a file that the regular expressions misjudge shifts a count by one or two. The file-level results are in `results.json` for anyone who wants to check one.
- The importer was measured as it is at this commit, and it improves with the stories that follow (comments, footnotes, hyperlinks); the competitors were measured at their latest versions.
- The corpus is small and from three libraries' test suites. The success rate of the importer on real files from other sources is EXP-110 criterion 1.

## 7. Recommendation

**Build, as now.** Keep `packages/export-docx`'s importer and its own XML reader, and spend the effort on the mapping stories (comments, footnotes, hyperlinks, fields). Reasons, in the order of weight:

1. A2 needs the source map and the kept parts. No candidate offers byte positions; mammoth and python-docx throw away what they cannot map, which A2 forbids.
2. The importer is the only candidate that survived the whole hostile set, including the 5,000-cell file and 20,000-level nest, and it refuses the cases a policy should refuse (zip bombs, document type declarations, macros) with a named reason.
3. mammoth's advisory is the kind of fault this threat model fears (a Word file makes the server read a file), it is reproduced, and its XML parser has 22 advisories; the library also cannot express tracked changes.
4. The Open XML SDK is the best reader of the four on structure, and it is MIT and maintained, but it is a second runtime, it has no source positions, and an uncatchable stack overflow takes its process down.

Not decided here, and the owner's: whether to add the Open XML SDK as a test-only second reader (section 5), and whether a run of docx4j and POI is worth the cost of a Maven installation. The recommendation is in [ADR 0383](../adr/0383-w2-EXP-097-docx-parser.md).

## How to repeat it

```
pwsh -NoProfile -File docs/spikes/exp-097/collect-metadata.ps1
node docs/spikes/exp-097/make-hostile.mts <hostile dir> <marker file>
dotnet build docs/spikes/exp-097/openxml-probe -c Release -o <probe dir>
node docs/spikes/exp-097/run-eval.mts --hostile <hostile dir> --tools <dir with mammoth@1.13.0> \
  --tools-old <dir with mammoth@1.10.0> --python <python with python-docx 1.2.0> \
  --probe <probe dir>/Probe.dll --marker <the text of the marker file>
```
