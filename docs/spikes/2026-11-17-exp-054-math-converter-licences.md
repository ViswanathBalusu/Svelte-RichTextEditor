# EXP-054: converters between LaTeX and Office math, licence comparison

Status: partial report, lane w2, 2026-11-17. It answers the licence criterion of EXP-054. It does not answer the measurement criteria (the share converted correctly, wrongly and not at all), and it makes no recommendation yet. Nothing here was run.

## What this is based on

- 09 §6.1: the stylesheet of Microsoft is not redistributable, and a GPL converter is acceptable only as a separate process.
- `docs/research/2026-11-06-borrow-list.md`, section on the third-party inventory: the licence, version and verdict of each package, read from the package metadata on 2026-11-06. The entry for Microsoft's `MML2OMML.XSL` there says "not verified here".
- 09, the item on the image's packages: the image already ships LuaTeX under the GPL, with a licence manifest and a source offer.

The direction of each candidate is what its own description says. No converter was installed or run for this report.

## Candidates

| Candidate | Direction | Licence | Allowed use for this project | Verdict of the borrow list |
|---|---|---|---|---|
| Microsoft `MML2OMML.XSL` | MathML to Office math | Not redistributable (09 §6.1); the licence text was not read | Cannot be shipped in the image or in a package. Could only be used where the operator already holds an Office licence, which the service cannot assume. | Not usable |
| texmath (Haskell, the converter of Pandoc) | LaTeX, MathML and Office math, both ways | GPL-2.0 (Cabal metadata) | Only as a separate process: the worker image would carry its own executable, called with files or standard input and output, and nothing links it. Shipping the executable carries the source offer that the image already makes for LuaTeX. | Read for ideas only |
| `temml` 0.14.0 | LaTeX to MathML | MIT | May be bundled, with the licence notice. | Evaluate in EXP-054 |
| `mathjax` 4.1.3 | LaTeX to MathML (and others) | Apache-2.0 | May be bundled, with the licence and notice files. | Alternative only |
| `omml2mathml` 1.3.0 | Office math to MathML | Apache-2.0 | May be bundled. The repository is archived; the last release is from 2017-07-07. | Read; fork only if EXP-054 finds nothing better |
| `mathml2omml` 0.5.0 | MathML to Office math | LGPL-3.0-or-later | The project's rule keeps copyleft packages as "read for ideas only". A separate process would follow the GPL route above. | Read for ideas only |

## What the licences leave

- LaTeX to MathML has two permissive candidates (`temml`, `mathjax`).
- Office math to MathML has one permissive candidate (`omml2mathml`), archived since 2017.
- MathML to Office math has no permissive candidate in this list. The two that do it are Microsoft's stylesheet (not redistributable) and `mathml2omml` (LGPL). The GPL texmath does it in one step from LaTeX.
- So the export direction to DOCX (LaTeX to Office math) needs either texmath as a separate process, or a converter of our own for MathML to Office math, or the image fallback for every equation.

## Not done, and what it needs

- The corpus of equations from real Word files and from the allow-list of 09 §6.3, run in both directions through each converter. Needs the converters installed (texmath in a container image, the npm packages) and Word files with equations. None is in this repository: the corpus package holds no Office math sample, and Podman has no texmath image in its local store. Pulling one is a download that needs the owner's say.
- The recommendation: the converter, the process boundary, where it runs, and how an equation that cannot be converted becomes an image whose alternative text is its LaTeX source (how that image is drawn is open in 09, Open questions).
- The end of the time box, with one converter named or the statement that none fits.

## Recommendation (lane w2, 2026-11-27, from decision 234)

Decision 234 of `docs/owner-decisions-2026-11-26.md` settles the choice: we build our own converter between LaTeX and Office math. texmath is not used, and no GPL code enters the project. The owner took this against the recommended option. So this spike does not pick one of the candidates above. It recommends the in-house converter and does not run the others.

- **The converter.** One converter of our own, written in TypeScript in `packages/export-docx` (a universal package: pure functions, no Node.js or browser APIs). It reads LaTeX of the allow-list of 09 §6.3 into a tree shaped like MathML (the intermediate form of 09 §6.1) and writes Office math from it; a second function reads Office math into the same tree and writes LaTeX. It converts only what the allow-list and the Office math elements it knows allow. Anything else is "not converted", never a guess. No candidate of the table is a dependency: `temml`, `mathjax` and `omml2mathml` stay unused, because a converter of our own has to cover both directions anyway and the permissive packages cover one direction each.
- **The process boundary.** None. The converter is our code under our licence, so the rule about a GPL converter running as a separate process (09 §6.1, EXP-096 criterion 2) has nothing to apply to. Its input is untrusted, so it takes bounded input (a limit on length, nesting depth and node count, set in EXP-096 and EXP-105) and builds XML only through the writer's escaping. It never calls a TeX engine and never reads a file.
- **Where it runs.** On the server, in the export worker's own process, at the DOCX writer (LaTeX to Office math, after the gate of EXP-049) and at the DOCX importer (Office math to LaTeX, before the converted LaTeX goes through the gate). It does not run inside the TeX sandbox, which holds only the LaTeX export, and it does not run in the browser.
- **An equation that cannot be converted.** The writer or importer treats a refusal of the converter as it treats a refusal of the gate. On export the equation becomes a picture in the Word file with the LaTeX source as its alternative text (`descr` on the drawing's `wp:docPr`). On import the original Office math is kept as preserved content with an image fallback (09 §6.1, A2). The picture itself comes from a renderer that hands the writer image bytes, size and type for a LaTeX source; the writer does not draw. Proposed, not decided: render it with a standalone compile in the existing sandbox, because the gate and the engine's limits are already there. How the image is drawn is still open in 09, Open questions, and is not decided by this report. Until a renderer exists the writer keeps the placeholder text of EXP-051.
- **What is not shown.** Nothing here is a measurement. The share of equations converted correctly, wrongly or not at all (criterion 2) is for the converter to show once EXP-096 and EXP-105 have built it, against a corpus of allow-list equations and Office math taken from Word files. This repository still holds no Office math sample.

The time box ends with the recommendation above: build the in-house converter. No other candidate is recommended.
