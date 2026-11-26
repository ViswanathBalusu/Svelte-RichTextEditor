# ADR 0007: LaTeX as a generated artefact, compiled by sandboxed LuaLaTeX workers

**Status:** accepted, 2026-11-06, when the project owner confirmed assumptions A3 (one house class) and A4 (LaTeX is an export pipeline, and the CDM document is the stored source of truth). Proposed 2026-09-18.

## Context

Final output is typeset by LaTeX (R5). Two roles were possible: LaTeX as an export target generated from the editor's model, or LaTeX source as the stored truth with the editor as a visual layer (as in Overleaf's visual editor or LyX).

Findings on 2026-09-18:

- Overleaf's visual editor handles a subset of LaTeX and falls back to source code for the rest. Page layout, named styles and tab stops do not survive a round trip through arbitrary LaTeX.
- Fidus Writer (AGPL) is the closest precedent for generating LaTeX from a ProseMirror document: a recursive tree walk with conditional package loading and a separate escaping module.
- Pandoc's document model has no page geometry, headers and footers, tab stops, fonts, colours or revisions.
- LuaLaTeX loads OpenType fonts by file, offers the callbacks needed to report layout, and is the preferred engine of the LaTeX tagged PDF project. Reported cost: about 1.4 seconds for one page, about 23 seconds for 10,000 paragraphs.
- LaTeX is a programming language. Known attacks read files, open sockets and run commands. LuaTeX before 1.17 could run commands even with shell escape disabled (CVE-2023-32700).

## Decision

- The CDM is the source of truth. A project-owned TypeScript converter writes a LaTeX bundle from it, using one house class and macros generated from the document's named styles.
- Bundles are compiled by LuaLaTeX from a pinned TeX Live image, in one sandbox per job, behind a queue.
- The only user-authored TeX that reaches the engine is math, and it passes an allow-list gate.
- The PDF is the authoritative view of the output. The compile reports where pages broke so the editor can pin its page breaks (parity level L1). Emulating TeX in the browser is not attempted.

## Consequences

Good:
- High-quality typesetting and accessible PDF without building a PDF writer.
- One controlled class makes page reconciliation possible.
- The same converter feeds a downloadable LaTeX bundle.

Bad:
- Compiles take seconds, so export is asynchronous and previews are throttled.
- On-screen pages and the PDF differ between compiles; users must be shown which is authoritative.
- A TeX Live upgrade can move line and page breaks and must be treated as a versioned change.
- The project needs TeX and Lua expertise.

## Alternatives considered

| Alternative | Why not |
|---|---|
| LaTeX source as the stored truth | Caps the editing experience at what a visual layer over LaTeX can do |
| Pandoc as the converter | Its model cannot carry what a Word-like document contains |
| Typst | Much faster and embeddable, but not what the project owner chose. The writer interface stays backend-neutral so a Typst writer can be added for previews |
| PDF written directly from the editor's layout tree | Gives exact parity but discards LaTeX, which is the requirement |
| Customer templates in version 1 | Breaks page reconciliation and widens the attack surface |
| TeX in the browser through WebAssembly | Tens of megabytes of engine plus hundreds of data; full recompiles; licence obligations |

## After the first review (2026-09-18)

- The package mapping of the first draft contradicted its own accessible-PDF goal: `titlesec`, `multirow`, `enumitem`, `tabto`, `caption` and `float` do not work with the LaTeX project's tagging support. The house class is built for tagging from the start and avoids them.
- `longtable` never breaks a row across pages and fails in multi-column sections, headers and footnotes, so there are three table writers and the converter splits over-tall rows.
- "One escaper" was not enough. User strings reach TeX as options, URLs, labels, numbering templates, colours and lengths. All output goes through typed emitters, identifiers are generated, and every model attribute has a grammar.
- The math gate also bounds dimensions and removes commands that paint outside their box, and it parses with KaTeX first.
- Auxiliary files are not reused between jobs. They are executed as TeX, so reuse would let one sandbox escape persist.
- Worker outputs are hostile: the PDF viewer is sandboxed, `layout.json` is validated, logs are parsed with bounds.
- A missing glyph fails a final export instead of vanishing silently.
- List labels are literal text from the shared numbering algorithm.
- The published compile timings are lower bounds; the real class with tagging is measured in spike S4.
- Sealing happens in a separate signing service ([ADR 0013](0013-signing-stance.md)).

## Revisit when

Customer templates become a requirement, or preview cost at scale justifies a second, faster writer.

## Sandbox technology

The sandbox of the compile workers is gVisor (owner decision 146, 2026-11-15), recorded in ADR 0434 (`docs/adr/0434-w2-EXP-069-sandbox-technology.md`). The measurements of the alternatives are outstanding.
