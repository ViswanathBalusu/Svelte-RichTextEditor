# ADR 0371: The HTML job and its representation choices (lane w2, EXP-087)

Status: proposed. The owner has not decided these points. EXP-087 criteria 1, 4 and 6 are ticked on the defaults below.

## Context

09 §11 lists `html` as a direct writer in phase 2 and says no more. The writer (`htmlText`, `packages/export-latex/src/html-writer.ts`) existed; no job produced HTML. Three points were open: which output the job stores, how equations appear, and how pictures travel with the HTML.

## Decision proposed

1. **The job.** The export worker accepts `target: html` (`services/export-worker/src/job.ts`). It runs the same content read, projection (EXP-123) and option plan as the other targets, writes the HTML with `htmlText` and stores one file, `output.html`, as `text/html; charset=utf-8`. It uses no font and no sandbox and never compiles. The writer's diagnostics, with those of the option plan, are the job's `diagnostics`. An error diagnostic (such as `pending_suggestions`) fails the job with `unsupported_feature`, as for `pdf`.
2. **Warnings.** A construct HTML cannot express is a `warning` in the job's result: tab stops (`tab_stop_plain`), page and column breaks, form fields, headers and footers, paragraph layout and, from this change, page setups (`page_setup_omitted`, which was `info`).
3. **Equations.** Written as LaTeX source: `code.de-math` inline and `pre.de-math > code` for a display equation, with the diagnostic `equation_as_source`. No MathML is written; rendering needs a converter that does not exist here.
4. **Pictures (built by lane w2, 2026-11-26, on this proposal).** The control plane names, in the job payload, the ready assets of the same document that the readable content uses (`assets`: identifier to SHA-256 and media type; an asset of another document or one not ready is never named). The worker reads each by hash (`deps.assetBytes`, in production `ObjectAssetStore.getFinal`), checks the hash, and passes the ones a page can show (`image/png`, `image/jpeg`, `image/gif`, `image/webp`) to the writer. With no picture the output is `output.html`; with at least one it is one tar archive, `output.tar` (`application/x-tar`), holding `index.html` and the files the `img` elements name, `assets/<asset id><extension>`. A picture the worker cannot read, whose bytes do not match the hash, or whose type a page cannot show (PDF, from an SVG) is written as its alternative text with the warning `image_asset_missing`. The choice of tar over zip follows the `tex` target (the archive writer exists and is reproducible); a browser user would prefer zip. Tar against zip is for the owner. The same wiring (assets in the payload and `assetBytes`) is what the PDF and `tex` targets lack to show pictures (EXP-014 Notes); it is not done here.

## Consequences

- EXP-087 criterion 6 is ticked on the packaging above.
- `page_setup_omitted` is a warning in HTML. Markdown (`markdown-writer.ts`) is unchanged.
- Tests: `services/export-worker/src/exp-087-html.job.test.ts`, `packages/export-latex/src/exp-087-structure.html.test.ts`.
