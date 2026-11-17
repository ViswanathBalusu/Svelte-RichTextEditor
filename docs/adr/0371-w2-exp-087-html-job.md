# ADR 0371: The HTML job and its representation choices (lane w2, EXP-087)

Status: proposed. The owner has not decided these points. EXP-087 criteria 1 and 4 are ticked on the defaults below; criterion 6 is not.

## Context

09 §11 lists `html` as a direct writer in phase 2 and says no more. The writer (`htmlText`, `packages/export-latex/src/html-writer.ts`) existed; no job produced HTML. Three points were open: which output the job stores, how equations appear, and how pictures travel with the HTML.

## Decision proposed

1. **The job.** The export worker accepts `target: html` (`services/export-worker/src/job.ts`). It runs the same content read, projection (EXP-123) and option plan as the other targets, writes the HTML with `htmlText` and stores one file, `output.html`, as `text/html; charset=utf-8`. It uses no font and no sandbox and never compiles. The writer's diagnostics, with those of the option plan, are the job's `diagnostics`. An error diagnostic (such as `pending_suggestions`) fails the job with `unsupported_feature`, as for `pdf`.
2. **Warnings.** A construct HTML cannot express is a `warning` in the job's result: tab stops (`tab_stop_plain`), page and column breaks, form fields, headers and footers, paragraph layout and, from this change, page setups (`page_setup_omitted`, which was `info`).
3. **Equations.** Written as LaTeX source: `code.de-math` inline and `pre.de-math > code` for a display equation, with the diagnostic `equation_as_source`. No MathML is written; rendering needs a converter that does not exist here.
4. **Pictures (not built).** The worker reads no picture bytes today (`assets: {}` in every target), so the writer writes the alternative text with `image_asset_missing`. Once the worker can read assets, the proposed packaging is one `output.html` when there is no picture, and otherwise one tar archive (`output.tar`, the writer of `tar.ts`) holding `index.html` and `assets/<name>`, with the paths the writer already gives (`assets/<asset id>`). The choice of tar over zip follows the `tex` target; a browser user would prefer zip. This is for the owner.

## Consequences

- EXP-087 criterion 6 stays unticked until the worker reads assets and the archive is written.
- `page_setup_omitted` is a warning in HTML. Markdown (`markdown-writer.ts`) is unchanged.
- Tests: `services/export-worker/src/exp-087-html.job.test.ts`, `packages/export-latex/src/exp-087-structure.html.test.ts`.
