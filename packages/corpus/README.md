# @docedit/corpus

The shared document corpus (story FND-006): one versioned set of CDM documents for every performance, layout and export test, so that results are comparable across spikes and releases.

The package is universal (lib ES2023, no Node.js or browser APIs). `src/index.ts` loads documents in Node.js and in browsers; only `scripts/generate.ts` and the tests use Node.js.

## Documents

| Document | Target | Estimated pages | File | In git | What it covers |
|---|---:|---:|---:|---|---|
| `pages-1` | 1 | 1 | 56 kB | yes | A numbered heading, marks, a link, inline math, a footnote, a bulleted list, a table with a caption and header row, an inline image, a figure with a caption, a header and a footer with page fields |
| `form-fields` | 1 | 1 | 55 kB | yes | The feature `fields`: two role placeholders, form fields of every kind but `attachment` assigned to them, one in a table, a `formValue` field and a rule in the form of 12 §5.1 |
| `pages-20` | 20 | 22 | 503 kB | yes | Front matter with lower-roman page numbers and tables of contents for headings, figures and tables, then a chapter with every special case below once |
| `pages-100` | 100 | 100 | 1.5 MB | no | Chapters with the ordinary mix and one special case each, in rotation |
| `pages-300` | 300 | 300 | 4.3 MB | no | The same, 300 pages |
| `pages-1000` | 1000 | 1000 | 14.4 MB | no | The same, 1,000 pages (5.6 MB canonical, within the 16 MiB of invariant I7) |

The sizes are the ones the budgets name (00 §9, 13 §9): 20 pages for time to interactive and export, 100 for typing latency and memory, 300 for the web view, 1,000 for the page view. `pages-20` holds every special case, so it is estimated at 22 pages rather than 20.

A chapter's ordinary mix: numbered headings (levels 1 to 3), justified prose in styles with `basedOn` chains, footnotes (plain, with a cross-reference, inline math, a link or an image), inline math and images, web and email links, a bulleted list, a numbered list of three levels (a new list on the shared definition in every chapter), a figure with a caption, a `seq` field and a bookmark (some floating), a table with a caption and a header row, a numbered display equation with a label, cross-references to headings, figures, tables and equations, a region (`inherit` and `restricted` in turn) and a paragraph of Chinese, Japanese or Korean.

The special cases: a table of 50 rows (longer than a page) with a repeated header row; a landscape section with a nine-column table; a two-column section started by a continuous break, with a table and a column break; a paragraph of more than 5,000 characters under a heading with a footnote; legal numbering (`legal`, `restartAfter`, `§`) in a restricted region; typography (the TeX special characters, dashes and quotes, repeated spaces, no-break space, soft hyphen, ligatures and kerning pairs, every run mark, tab stops of all four kinds, a page break, direct paragraph formatting); row and column spans; figures, equations, footnotes and images inside cells with borders, shading, margins and fixed row heights; a row taller than a page; lists across a table, with a skipped level, a restart and a second list on the same definition; and terms in Chinese, Japanese and Korean in a table.

Every document defines all 37 built-in styles of ADR 0018, named styles of each kind with `basedOn` chains of three and four styles, four numbering definitions, six page setups, and header and footer stories (with first-page and even-page variants from 20 pages up). The manifest lists, per document, the features it actually uses (`features`), computed from the document.

## Regenerating

```sh
pnpm --filter @docedit/corpus generate
```

The generator is deterministic: it reads no clock and no platform random source. Each document is built from its own seeded streams (`sfc32`, seeded through `splitmix32` from the FNV-1a hash of `docedit-corpus/<name>/<stream>`), so two runs give the same bytes, and the same build in a browser gives the same bytes as in Node.js (`src/corpus.universal.test.ts` checks this in Chromium, Firefox, WebKit and Edge). Generating the whole corpus took 2 to 4 seconds on the development machine (Windows 11, Node.js 22.18), as timed by the script.

It writes into `out/`:

- `<name>.cdm.json` for every document, in exactly the layout Prettier gives JSON with the repository's settings, so `pnpm lint` accepts the files as they are;
- `assets/<uuid>.png`, the tiny images, each with a UUID version 7 asset identifier;
- `manifest.json`;
- `.gitignore`, which keeps `pages-100`, `pages-300` and `pages-1000` out of git. They are generated on demand; `loadDocument` builds them in memory, so tests need no generated files.

The documents kept in the repository are `pages-1`, `form-fields` and `pages-20`, together with the manifest and the images.

## Versions

The corpus version starts at 1. Any change to the generator or to its output takes a new version. The manifest's `fingerprint` is the SHA-256 of its RFC 8785 form without `version`, `fingerprint` and `history`; it covers the canonical hash and the file hash of every document and asset, the page estimates, the features and the licences. When the output changes, the generator prints the new fingerprint and exits with 1, and the tests fail, until a version is added to `CORPUS_HISTORY` in `src/generate/version.ts`:

```ts
{ version: 2, date: '2026-11-20', fingerprint: '<printed by the generator>', change: 'What changed.' },
```

Results are comparable when they ran against the same corpus version. Across versions, compare per document: the same `documentHash` means the same document.

## Using the corpus in a test

```ts
import { corpusLabel, corpusStamp, loadDocument } from '@docedit/corpus';
import { validate } from '@docedit/model/validate';

beforeEach(({ task }) => {
  task.meta.corpus = corpusStamp(); // { corpus: 'docedit-corpus', version, fingerprint }
});

it('types into the 100-page document', async ({ annotate }) => {
  await annotate(corpusLabel(), 'corpus'); // shown next to the result, kept in reports
  const doc = await loadDocument('pages-100');
  validate(doc.envelope, { attachedAssets: doc.attachedAssets });
  // ...
});
```

Every test result that uses the corpus records the corpus version it ran against (FND-006):

- Vitest tests put `corpusStamp()` into `task.meta.corpus` (declare `corpus?: CorpusStamp` on Vitest's `TaskMeta`; `test/corpus.test.ts` shows how), which the JSON reporter keeps, and may add `annotate(corpusLabel(), 'corpus')`;
- benchmark and harness result files (FND-007, S4, S5, S10) store `corpusStamp()` next to their measurements;
- a test that pins a document checks `doc.entry.documentHash` too.

`loadDocument(name)` rebuilds the document with the generator and compares its canonical hash (`documentHash` of `@docedit/model`) with the manifest, so a test never runs against a document that differs from the published corpus. It returns the envelope, the attached assets with their bytes, the manifest entry and the stamp. Tools that need the files read them from the package: `documentFile(name)` and `assetFile(id)` give the paths, which resolve as `@docedit/corpus/out/...`. `serializeDocument(envelope)` gives the exact text of a file.

## Page counts

Every page count is an estimate until the S4 LaTeX compile (SPK-017) measures real ones. The estimate is a line model, recorded in the manifest's `pageEstimate` with its parameters and the reasons for them: 12 words per line and 40 lines per page for 11 pt text on A4 with 2.54 cm margins, scaled for other page setups, columns, indents and font sizes, with tables, figures, equations and tables of contents converted to lines. Both figures are planning figures, not measurements. When S4 reports a count, it goes into `src/generate/measured.ts` with how and where it was measured; the manifest then marks that count as measured, and the corpus takes a new version (the documents and their hashes stay the same).

## Licence

All text and every image in the corpus is original, made for this repository: the English prose is assembled by the generator from word lists and patterns written for it, the Chinese, Japanese and Korean sentences, the fixed passages and the formulas were written for it, and the images are drawn pixel by pixel. No third-party material is included. The manifest records the provenance of every source and its licence, `Apache-2.0`: the project's licence, chosen by the owner on 2026-11-06 (SPK-007).

## Validity

Every document passes `validate()` of `@docedit/model/validate` with its attached assets and an empty set of retired region identifiers. The math gate (I8) is not checked, because it does not exist yet; the formulas use common LaTeX and `amsmath` commands that KaTeX supports, no `%`, `#` or `~`, and `&` only inside `aligned`, `cases`, `gathered` and `pmatrix`, as 09 §6.3 asks. Field references use the target forms of ADR 0018.
