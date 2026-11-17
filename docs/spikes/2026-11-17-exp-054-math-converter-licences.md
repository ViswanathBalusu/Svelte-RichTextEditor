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
