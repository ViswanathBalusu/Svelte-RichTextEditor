# Spike S4: safe LaTeX compiles that report where lines and pages broke

**Status:** spike result, 2026-11-06, SPK-017; not reviewed.

## Question

Can a generated bundle be compiled safely with a tagging-first class, and report where lines and pages broke? What does a compile of the real class cost (11 §2, S4)?

## Answer

Yes, on the evidence below.

- **The PDFs validate.** The converter writes a bundle from CDM. The house class compiles it into PDFs that veraPDF 1.30.3 accepts as both PDF/UA-2 and PDF/A-4f, at 1, 22 and 99 pages. This held in the Podman sandbox (TeX Live 2026), locally (TeX Live 2025), and with both luaotfload renderers.
- **`layout.json` reports where every block and every page starts.** For each block it gives the page and the vertical position; for each page, the block and the offset it starts with. Line starts are exact to the UTF-16 code unit in the measured corpus. In the 99-page document, 3,073 of 3,074 checked line starts and all 97 checked page starts matched the PDF's own text. The single miss is a text-extraction artefact (section 5).
- **A compile costs seconds, and tagging is the largest cost.** In the Podman sandbox on the test desktop (section 4; not FND-007's reference machine), a 22-page document took 6.35 to 6.94 s per pass with tagging on (medians), and 21.7 s for a final export of three passes.
  - Tagging on costs 2.3 to 5.4 times an untagged pass, and the factor grows with length.
  - Draft tagging saves 13 to 35 percent of a tagged pass.
  - `tagging=off` keeps exactly the same line and page breaks at 36 to 65 percent of the tagged cost, which makes it the setting for previews.
  - Leaving out `\DocumentMetadata` is cheaper still, but it moves breaks (section 4).
- **All 14 sandbox escape tests pass.** Two findings matter for production:
  - paranoid `openin_any` does not stop TeX or Lua from reading absolute paths, so the container is the only read boundary;
  - Podman's default `mounts.conf` puts the host's `/run/secrets` into every container (section 6).
- **The class uses luaotfload's node renderer, and HarfBuzz mode is viable.** HarfBuzz mode (`Renderer=HarfBuzz`) works with tagging, validates, and gave the same pages, line starts and baselines as node mode for all 1,828 blocks of the 99-page document. It costs no more. It changes the extracted text of ligatures to U+FB01 and similar code points (section 7).

## What was built (kept, not throwaway)

| Part | Where |
|---|---|
| Typed emitters (`text`, `pdfString`, `kvValue`, `url`, `dimen`, `color`, `enumLookup`, `generatedId`), a branded `Tex` type, a raw `tex` template and a `lit` helper that accepts only string literals. Writing a plain `string` to the bundle without an emitter is a type error | `packages/export-latex/src/emit.ts` |
| Formatting cascade of 03 §6, as far as the converter needs it | `packages/export-latex/src/cascade.ts` |
| Numbering labels: decimal, letters, roman, bullets, restarts and legal numbering (the shared algorithm is CDM-042) | `packages/export-latex/src/numbering.ts` |
| Math gate stub (details below the table) | `packages/export-latex/src/math-gate.ts` |
| Converter (details below the table) | `packages/export-latex/src/convert.ts`, `bundle.ts` |
| House class `docedit.cls` (prefix `\DE`, version 0.1.0-s4) and its Lua half `docedit.lua`, which decodes hex strings, gives every glyph an offset, walks each page at shipout and enforces the page limit | `packages/export-latex/class/` |
| Worker parts (details below the table) | `services/export-worker/src/` |
| Image definition, entry point, font directory builder, font-cache warm-up | `services/export-worker/Containerfile`, `services/export-worker/image/` |
| Scripts: build the image, export one document, generate the corpus, measure, check `layout.json` against the PDF's text | `services/export-worker/scripts/` |
| Measurement documents of 1, 22 and 99 pages, valid CDM | `services/export-worker/fixtures/s4-corpus/` |
| 60 tests: 35 for the converter, 4 for tar transport, 4 for `layout.json`, 3 end-to-end compiles validated with veraPDF, and 14 sandbox escape tests | `packages/export-latex/src/*.test.ts`, `services/export-worker/src/*.test.ts` |

The **math gate stub** has a small allow-list. It refuses definitions, primitives, `%`, `#`, `~` and `^^`, and allows `&` and `\\` only in allowed environments. It enforces the limits of 4,000 characters and nesting depth 50.

The **converter** handles:

- paragraphs, with one macro per style;
- headings at levels 1 to 9;
- run formatting;
- regions, which leave no trace;
- lists with literal labels;
- `longtable` tables with repeated header rows;
- footnotes, in both CDM shapes;
- links;
- inline and display math;
- a table of contents;
- page setup and page breaks;
- a header and footer with page fields.

It also writes `map.json` (the source map) and `manifest.json` (SHA-256 of every file and of the whole bundle).

The **worker parts** are:

- the Podman command line (`DOCEDIT_CONTAINER_CLI`, default `podman`);
- tar transport in and out;
- the sandbox flags and the readiness check;
- local compiles for comparison;
- the `layout.json` builder with its schema check;
- the veraPDF step and the pipeline.

Out of scope for the spike:

- Shown as visible placeholders with a diagnostic: images and figures, extension and preserved blocks, citations and bibliographies (EXP-121), and equations in table cells.
- Tab stops are approximated.
- Page-setup changes at section breaks and multiple columns are not applied.
- Fields other than `page`, `pageCount` and `date` print their cached text.

## 1. Acceptance criteria of SPK-017

| Criterion | Result | Evidence |
|---|---|---|
| Given a generated bundle, when the sandboxed worker compiles it with a tagging-first class, then the PDF validates with veraPDF | **Met** | veraPDF 1.30.3 (`docker.io/verapdf/cli`, pinned by digest), flavours `ua2` and `4f`, 0 failed checks in every case (passed checks below the table). The same held locally with TeX Live 2025 and in HarfBuzz mode. Run by `node services/export-worker/scripts/measure.ts --validate` (results in `services/export-worker/out/measure/main/results.json`) and by the test `compile.e2e.test.ts` |
| `layout.json` reports block-level page starts, and a report states how precise line-level offsets can be (09 §7.1) | **Met** | Every block has `page` and `y`, and every page has `starts` and `opensWith`. Line starts are exact in the corpus: 3,073 of 3,074 checked in the 99-page document, 653 of 654 in the 22-page one, and all page starts. The miss is an extraction artefact (section 5). Script `check-layout.ts`; tests `layout.test.ts` and `compile.e2e.test.ts` |
| Compile times with tagging on are measured on the shared corpus, including second and third passes | **Partly met** | Measured with tagging `on`, `draft`, `off` and none, passes 1 to 3, at least three runs each, in Podman and locally (section 4). The shared corpus of FND-006 does not exist yet, so the spike generated its own valid CDM documents. `measure.ts --corpus <dir>` reads any directory of `*.cdm.json`, so the corpus will plug in without code changes |
| Sandbox escape tests pass (09 §9.3; 10 §3.4) | **Met** | 14 of 14 pass in `sandbox.escape.test.ts`. They run when `podman info` answers and the image exists, and skip otherwise (section 6) |
| The report records which luaotfload renderer the class uses and whether its HarfBuzz mode is viable, as input to S5 (ADR 0016) | **Met** | Section 7 |

veraPDF checks passed, in the sandbox:

| Document | PDF/UA-2 | PDF/A-4f |
|---|---|---|
| s4-01p | 3,348 | 2,658 |
| s4-20p | 123,632 | 72,375 |
| s4-100p | 573,538 | 343,665 |
| Headings at levels 1 to 9 | 2,817 | 1,668 |

## 2. The class and the standard the PDF claims

`main.tex` starts with:

```
\setrandomseed 20261106\relax
\DocumentMetadata{lang=en-GB, pdfversion=2.0, pdfstandard={ua-2,a-4f}, tagging=on}
```

- **PDF/UA-2.** This is the accessibility standard that LaTeX's tagging code targets in PDF 2.0, and the one 09 §13 names.
- **PDF/A-4f, not PDF/A-4.** The tagging code embeds associated files:
  - `latex-list-css.html` and `latex-align-css.html`, the CSS for lists and alignment;
  - for every formula, `mathml-N.xml` and `tag-AFfileN.tex`, the MathML and the LaTeX source.

  PDF/A-4 allows only PDF/A files to be embedded. The same PDF declared as A-4 failed ISO 19005-4 clause 6.9, test 3, and passed as 4f. With 4f, LaTeX also adds a note file, `pdf-A4f.txt`.
- **`tagging=off` and `draft` drop the UA-2 claim.** The structure tree is then missing or incomplete, and the converter reports this.
- **The fixed random seed.** tagpdf names its user namespace with TeX's random generator, which is seeded from the clock. The fixed seed keeps the PDF byte-identical from run to run (section 4).

**Packages.** The class loads a fixed list, and nothing else loads packages:

- `fontspec`, `amsmath`, `unicode-math`;
- `xcolor` and `luacolor`;
- `geometry`, `lua-ul`, `array`, `longtable`, `colortbl`, `fancyhdr`, `hyperref`.

It loads none of `titlesec`, `multirow`, `enumitem`, `tabto`, `caption` or `float`. `\usepackage` and `\documentclass` are disabled after `\begin{document}`.

**Headings.** The class uses the kernel's sectioning commands. Levels 6 to 9 are new `\@startsection` commands with `\toclevel@` entries. The tagging code names levels −1 to 5 only, and without names for the deeper levels the compile failed at level 6. The class now gives levels 6 to 9 the structure roles of level 5, with `\NewStructureName` and `\AssignStructureRole`. The 9-level document then validates. Two consequences:

- levels 5 to 9 all appear as `H6` in the PDF;
- latex-lab maps `\section` to `H2`, so the CDM's Heading 1 becomes `H2`.

**Lists.** The class uses the kernel's `list` environment with `\item[<literal label>]`, nested by level, so the tagging code gives `L`, `LI`, `Lbl` and `LBody`. With that code loaded, the label needs a box of explicit width, so `\makelabel` is `\hbox to\labelwidth{#1\hfil}`.

**Tables.** `longtable`, with the header rows in both `\endfirsthead` and `\endhead`. `\tagpdfsetup{table/header-rows=...}` marks them.

**Footnotes.** `\footnotemark` plus `\footnotetext`, so that the footnote text carries its own block mark. The converter reads the footnote's content both as inline nodes and as one paragraph (CDM-001; see section 8).

**Paragraphs.** Styles and direct attributes only set registers; `\DE@apply` turns the registers into TeX parameters when the paragraph starts. Emitting the default style, the table style, the numbering level, the style chain and the direct attributes in that order therefore applies the cascade of 03 §6. The larger-of spacing rule of 03 §7 needs both neighbours, so the converter computes each gap.

**Fonts.**

- The class uses Noto Serif, Noto Sans and Noto Sans Mono from TeX Live's `noto` package, and STIX Two Math from `stix2-otf`. All are under the SIL Open Font License 1.1.
- They load by path and hash from a directory that `image/fonts.lua` builds. Every file is named by its SHA-256. The directory also holds `fonts.json`, which records the hashes and each face's line height (win ascent plus win descent: 1,362 thousandths for the Noto faces).
- The files are byte-identical in TeX Live 2025 and 2026.
- `\tracinglostchars=3` makes a missing glyph an error. It caught the bullet `◦` (U+25E6), which is in the CDM grammar's published bullet list but not in Noto Serif.

## 3. The sandbox

Image: `services/export-worker/Containerfile`, built by `node services/export-worker/scripts/build-image.ts` as `localhost/docedit-export-worker:s4` (5.99 GB).

| Item | Value |
|---|---|
| Base image | `docker.io/texlive/texlive:latest@sha256:07e8062637249c4f780ca59f42cc2ed592bc2dc1db4320769406aee3f98aa70e`, recorded 2026-11-06 |
| Base details | That is the index digest; the amd64 manifest is `sha256:97bde4bd80e73a697bcccdd626966a484f528e3f60c773b5c74cd7b8104c42fe`. The image was created on 2026-11-01. Island of TeX publishes no `TL2026` tag while 2026 is current, so the moving `latest` tag is pinned by digest |
| Versions inside | TeX Live 2026, LuaHBTeX 1.24.0, LaTeX 2026-11-01, tagpdf 1.0i (2026-10-29), luaotfload 3.29 |
| Hardening in the image | `shell_escape=f` (the image's default is the restricted `p`), `openin_any=p`, `openout_any=p`. `TEXMFHOME` and `OSFONTDIR` point at nothing. Jobs run as user 10001. The build fails if LuaTeX is older than 1.17 |
| Pre-built caches | luaotfload's font caches for the 11 font files in both renderers, and its names database |
| Validator | `docker.io/verapdf/cli:v1.30.3@sha256:d74b7026c18a0f171e73c153b617fe6520e1511feb24ca98a348b2bb897669fb` |

`podman run` flags for every job (`src/sandbox.ts`):

```
--rm -i --network=none --read-only --read-only-tmpfs=false
--tmpfs=/work:rw,size=256m,mode=1777,nosuid,nodev,noexec
--cap-drop=ALL --security-opt=no-new-privileges --user=10001:10001
--memory=1536m --memory-swap=1536m --cpus=1 --pids-limit=64
--ulimit=nproc=64:64 --ulimit=fsize=209715200:209715200 --ulimit=cpu=120:120 --ulimit=nofile=256:256
--timeout=120 --log-driver=none --no-hosts --hostname=sandbox
```

- **No host path is mounted.**
  - The bundle goes in as a tar on standard input.
  - `image/compile.sh` unpacks it into the tmpfs and runs the passes.
  - Only `main.pdf`, `main.log`, `main.layout` and `timings.txt` come back, as a tar on standard output.
  - The worker reads that output as hostile: it accepts only these names and stops at 200 MiB.
- **Time is limited three times:** `timeout -s KILL` around each pass inside the container, `--timeout` in Podman, and a kill from the worker.
- **Passes run until the references converge.**
  - A job runs at least `DOCEDIT_MIN_PASSES` passes (default 2) and at most `DOCEDIT_MAX_PASSES` (default 4).
  - From the minimum on, it hashes `main.aux`, `main.toc` and `main.out` after each pass, and stops when the hash no longer changes (09 §8).
  - Every pass starts from the job's own files.

**The local machine runs rootful Podman through WSL.** It is the machine `podman-machine-default`, with Podman 6.0.2 and crun 1.28 on kernel 6.18.40.1-microsoft-standard-WSL2. Rootless Podman on Linux is the intended production mode and was not tested.

Flags that behaved differently under Podman:

| Flag or default | What happened | Consequence |
|---|---|---|
| `--memory`, `--cpus`, `--pids-limit`, and Podman's own default pids limit of 2048 | With the systemd cgroup manager, the WSL machine creates containers under `/sys/fs/cgroup/non-systemd/machine.slice`, where no controller is delegated. crun then fails with "controller `pids` is not available", even for a plain `podman run`. The Windows remote client cannot pass `--cgroup-manager` | The worker has a development route, `DOCEDIT_PODMAN_MACHINE=<machine>`. It checks every argument against a strict pattern, then runs `podman machine ssh <machine> podman --cgroup-manager=cgroupfs run ...`. `sandboxReady()` picks this route automatically. All limits then work: `pids.max` 64, `memory.max` 1.5 GiB, `cpu.max` 100000/100000 |
| `--read-only` | Podman also mounts writable tmpfs on `/dev/shm`, `/run`, `/tmp` and `/var/tmp`, unless `--read-only-tmpfs=false` is given | Set to false; the tests show that `/tmp`, `/var/tmp` and `/run` are not writable |
| Default `mounts.conf` | The entry `/usr/share/rhel/secrets:/run/secrets` puts the machine's Red Hat subscription data (`rhsm.conf`, CA certificates) into every container, read-only. No per-run flag drops it | Production workers need an empty `mounts.conf` (EXP-072). Here it held no keys |
| `--timeout` | Specific to Podman; the container ended with exit code 255 when it fired | Used as the second time limit |
| Container log | By default Podman keeps standard output in the container log, which here would be the output tar | `--log-driver=none` |
| `podman build` | Its `RUN` steps ran without the pids error | No workaround needed |

## 4. Measurements

| Setting | Value |
|---|---|
| Machine | Intel Core i9-10900KF at 3.70 GHz (10 cores, 20 logical processors, from `Get-CimInstance Win32_Processor`), 128 GiB, Windows 11 Pro 10.0.26300, Node.js 22.18.0 |
| Podman | The WSL machine above, on the cgroupfs route, each job limited to one CPU |
| Local | LuaHBTeX 1.22.0 (TeX Live 2025) on Windows, not sandboxed, with the image's engine settings except `openin_any=a` (section 8) |
| Documents | Generated by `scripts/generate-corpus.ts`; valid by `@docedit/model/validate`; content below the table |
| Main run | `node services/export-worker/scripts/measure.ts --runs 3 --env podman,local --tagging on,draft,off,none --passes 3 --validate`, on 2026-11-06 |
| Timing | Exactly three passes per run. Pass times are taken around each `lualatex` call: inside the container with `date +%s%N`, locally around the process. "Wall" is the whole job, including container start, bundle transfer and the copy of the names database. Figures are the median of three runs, with the minimum and maximum in brackets. Tagging "none" means no `\DocumentMetadata` at all. Renderer node; line-level layout on |
| Raw results | `results.json`, `summary.md`, the PDFs and their `layout.json` files are in `services/export-worker/out/measure/` on the spike machine. That directory is not under version control; the scripts regenerate it |

Each document has:

- a title, and a table of contents (except s4-01p);
- Heading 1 and 2;
- body paragraphs with bold, italic, underline, strike, colour, highlight, small capitals and a larger size;
- footnotes, a link and inline math;
- numbered and bulleted lists with a second level;
- tables with a repeated header row, display equations and a quote style;
- every third section inside a region;
- a header and a footer with "Page n of m", and the paragraph of special characters.

s4-20p and s4-100p end with a long table of 40 and 160 rows, and a page break.

### 4.1 Podman sandbox, TeX Live 2026 (seconds)

| Document | Pages | Tagging | Pass 1 | Pass 2 | Pass 3 | Wall, 3 passes |
|---|---|---|---|---|---|---|
| s4-01p | 1 | on | 4.50 (3.97–4.83) | 4.12 (3.66–5.24) | 4.81 (3.83–5.15) | 14.41 (13.29–16.82) |
| s4-01p | 1 | draft | 2.91 (2.74–3.91) | 2.80 (2.67–3.00) | 2.68 (2.67–2.96) | 10.03 (9.23–10.92) |
| s4-01p | 1 | off | 2.94 (2.83–4.89) | 3.60 (2.79–5.38) | 5.14 (2.69–5.24) | 12.91 (9.57–16.98) |
| s4-01p | 1 | none | 1.94 (1.83–1.97) | 2.04 (1.75–2.34) | 1.86 (1.76–1.92) | 7.02 (6.94–7.29) |
| s4-20p | 22 | on | 6.85 (5.62–8.66) | 6.35 (5.91–6.53) | 6.94 (6.32–7.08) | 21.66 (18.98–23.43) |
| s4-20p | 22 | draft | 5.44 (5.42–8.26) | 5.79 (5.42–7.78) | 5.57 (5.51–6.11) | 17.90 (17.49–23.40) |
| s4-20p | 22 | off | 3.81 (3.62–3.90) | 3.92 (3.83–5.01) | 3.82 (3.75–5.78) | 12.92 (12.43–15.82) |
| s4-20p | 22 | none | 2.65 (2.39–2.68) | 2.71 (2.43–2.75) | 2.52 (2.48–2.60) | 9.13 (8.83–9.16) |
| s4-100p | 99 | on | 18.95 (18.09–38.72) | 20.91 (16.97–27.30) | 26.24 (19.10–26.77) | 66.38 (56.23–94.92) |
| s4-100p | 99 | draft | 16.49 (16.46–17.15) | 17.16 (15.46–17.47) | 16.43 (15.33–18.34) | 51.66 (48.90–53.88) |
| s4-100p | 99 | off | 6.85 (6.42–10.08) | 7.08 (6.63–7.29) | 7.39 (7.11–8.63) | 23.39 (21.73–26.26) |
| s4-100p | 99 | none | 4.75 (4.67–4.91) | 4.90 (4.75–5.28) | 4.82 (4.69–4.88) | 15.76 (15.49–16.01) |

The spread is real. The machine was otherwise idle, but single runs reached twice the median (38.72 s against 18.95 s for pass 1 at 99 pages). The cause is not known: it may be scheduling between WSL and Windows. Medians are the figures to use.

### 4.2 Local LuaLaTeX, TeX Live 2025 on Windows (seconds)

| Document | Tagging | Pass 1 | Pass 2 | Pass 3 | Wall |
|---|---|---|---|---|---|
| s4-01p | on | 4.19 (4.18–4.27) | 4.22 (4.20–4.25) | 4.29 (4.25–4.52) | 12.76 |
| s4-01p | none | 4.70 (4.47–5.26) | 5.83 (5.33–6.00) | 5.57 (4.71–6.16) | 16.16 |
| s4-20p | on | 7.76 (7.38–7.83) | 7.86 (7.74–8.81) | 7.93 (7.55–10.85) | 23.24 |
| s4-20p | draft | 7.35 (7.17–7.44) | 7.37 (7.35–7.96) | 7.44 (7.33–8.02) | 22.12 |
| s4-20p | off | 5.50 (5.24–5.65) | 5.71 (5.62–6.10) | 5.69 (5.42–5.71) | 16.93 |
| s4-20p | none | 3.92 (3.83–4.55) | 4.53 (3.85–4.72) | 5.84 (3.73–7.05) | 14.49 |
| s4-100p | on | 20.26 (19.47–21.83) | 23.08 (21.74–26.75) | 23.89 (21.88–24.44) | 69.37 |
| s4-100p | draft | 21.45 (19.18–29.83) | 23.76 (22.40–24.51) | 21.41 (20.18–21.59) | 64.39 |
| s4-100p | off | 9.94 (9.75–10.31) | 10.45 (10.10–12.79) | 11.02 (10.87–12.75) | 33.14 |
| s4-100p | none | 6.29 (6.16–6.69) | 6.39 (6.37–7.10) | 6.68 (6.44–6.98) | 19.21 |

For one page, every tagging mode took between about 4.2 and 5.8 s per pass locally. That time is dominated by start-up on Windows and says nothing about tagging. The full local table is in `services/export-worker/out/measure/main/summary.md`. Local compiles are a comparison, not a production path.

### 4.3 Layout reporting and renderer

**Method.** Second runs, interleaved, so that drift spreads over all settings: `measure.ts --tagging on --renderer node,harf --layout off,block,line --interleave`, with 5 runs for s4-01p and s4-20p and 3 runs for s4-100p, in the Podman sandbox. Figures are the sum of the three per-pass medians, in seconds.

| Document | node, layout off | node, block | node, line | harf, off | harf, block | harf, line |
|---|---|---|---|---|---|---|
| s4-01p | 8.49 | 9.13 | 8.76 | 8.75 | 8.87 | 8.70 |
| s4-20p | 19.29 | 18.86 | 18.89 | 19.26 | 19.52 | 19.53 |
| s4-100p | 63.87 | 61.83 | 69.62 | 61.67 | 57.29 | 61.71 |

The differences are inside the run-to-run spread; the ranges are in `out/measure/interleaved-*/summary.md`. The direct measure is the class's own CPU time. With `os.clock()` around its callbacks, the class writes this to the log for each pass:

| Document | Renderer | Offsets | Page walk | Total per pass | Lines reported |
|---|---|---|---|---|---|
| s4-20p | node | 36 ms | 24 ms | 60 ms | 1,070 |
| s4-20p | harf | 20 ms | 16 ms | 36 ms | 1,070 |
| s4-100p | node | 188 ms | 152 ms | 340 ms, about 1.6 % of a 21 s pass | 4,944 |
| s4-100p | harf | 135 ms | 120 ms | 255 ms | 4,944 |

These are single compiles, last pass. Line-level reporting therefore costs about 0.2 s per pass at 99 pages over block level, and block level costs the page walk alone. HarfBuzz mode was no slower than node mode. In separate runs that were not interleaved (`out/measure/harf`), its three-pass medians summed to 18.1 s against 20.1 s for node mode at 22 pages. The interleaved figures above agree within the spread.

### 4.4 What the numbers say

**Tagging.**

- Against no tagging, the tagged pass cost 2.3 times (1 page), 2.6 times (22 pages) and 4.0 times (99 pages) in pass 1, rising to 5.4 times in pass 3 at 99 pages.
- 09 §8's "roughly three times" holds for short documents only. Between 22 and 99 pages, tagging adds about 0.16 s per page and pass; untagged compiles add about 0.03 s.
- Later passes cost more with tagging on: at 99 pages, pass 3 took 26.2 s against 19.0 s for pass 1. In the first pass luamml has no MathML yet (the log says "mathml missing"); from the second pass on, the MathML is embedded.

**Draft and off.**

- Draft tagging saved 35, 21 and 13 percent of the tagged pass 1 at 1, 22 and 99 pages.
- `tagging=off` loads the same code with tagging switched off. It cost 1.4 to 1.5 times an untagged pass, which is 36 to 65 percent of a tagged one.

**Breaks by tagging mode.**

- Compared with `tagging=on`, `draft` and `off` gave identical page starts and line starts for every block of all three documents.
- Without `\DocumentMetadata`, 1 of 407 blocks (22 pages) and 125 of 1,828 blocks (99 pages) started on another page or broke differently. The first difference is in footnote text: the newer footnote code that `\DocumentMetadata` loads sets it differently.

**TeX Live 2025 against 2026.** With tagging on and the same font files, 1,827 of 1,828 blocks were identical. One paragraph broke differently from its fourth line on. A TeX Live upgrade does move breaks, if rarely (EXP-078).

**Byte identity.**

- Two compiles of the same s4-20p bundle in the sandbox gave byte-identical PDFs, once the fixed random seed was in place. This was checked again with the final class. Before the fix, tagpdf's random namespace name made every PDF different.
- Two local compiles differed only in the trailer `/ID`, which LuaTeX derives from the job's path. The local job directories differ; the sandbox's is always `/work/job`, as 09 §9.4 requires.

**Overhead and size.**

- The sandbox adds 1.1 to 2.1 s per job outside the passes (median about 1.25 s). This covers `podman machine ssh`, container creation, bundle transfer, the names-database copy and the output tar.
- Before the names database was copied into the job, luaotfload rebuilt it in the first pass, which then took 9.3 s instead of 2.5 s.
- Conversion from CDM to bundle took at most 70 ms for 99 pages.
- PDF sizes in the sandbox with tagging on were 68 KiB (1 page), 204 KiB (22 pages) and 669 KiB (99 pages). With `off`, they were 56, 136 and 393 KiB.

**Inputs for the unit-cost sheet** (`docs/research/2026-11-06-unit-cost-sheet.md`). Measured on this desktop with one CPU per job; server vCPUs may be slower, which was not measured.

| Assumption | Sheet | Measured |
|---|---|---|
| A13 preview, 20 pages, draft tagging, one pass | 4 vCPU-s | 5.4 s with draft. 3.8 s with `off`, which keeps the final breaks (s4-20p, 22 pages, pass 1) |
| A14 final, 20 pages, tagging on, to convergence | 18 vCPU-s (three passes of 6 s) | 20.1 s for three passes (6.85 + 6.35 + 6.94). s4-20p converges in three passes because of its table of contents |
| A15 overhead per job | 1 vCPU-s | 1.1 to 2.1 s wall per job (median about 1.25 s), not split into CPU time and waiting |
| A20 output size | final 1 MB | 204 KiB (22 pages), 669 KiB (99 pages) |

## 5. `layout.json` and how precise it is

**How the class marks material.** It sets three LuaTeX attributes:

- `DE@attr@block` holds the block number from `map.json`, so no user identifier ever reaches TeX.
- `DE@attr@run` holds the UTF-16 offset where each text run starts.
- `DE@attr@area` holds 1 for body, 2 for footnote, 3 for a repeated table head and 5 for the table frame (rules and row glue).

**How offsets are counted.** In `pre_linebreak_filter` and `hpack_filter`, every glyph and every interword glue gets its own offset in `DE@attr@pos`. The callback is ordered before luaotfload's shaper with `luatexbase.declare_callback_rule`. An explicit discretionary (a soft hyphen) counts one, and so does each inline atom (equation, footnote mark, break, tab, field). Shaping keeps the attribute of a ligature's first character, in node mode and in HarfBuzz mode.

**How a page is read.** A `shipout/before` hook walks the page box and takes vertical positions from box dimensions and `node.effective_glue`. It records:

- the first page and baseline of each block;
- the block and offset each page starts with;
- the first positioned glyph of each line box.

`\DE@noattrs` in the output routine keeps headers and footers out of the report. The Lua code writes `main.layout`, which holds integers only. The worker parses it strictly, joins it with `map.json` and validates the result against `LAYOUT_SCHEMA` (`src/layout.ts`).

**How precision was checked.** `scripts/check-layout.ts` takes every reported page start and line start. The next characters of the block's own text must then begin a line of that page in the output of `pdftotext -raw`. The probe stops at the next reported line start, so a match is exact to the character. A probe of fewer than four characters, or one that starts with an atom, is counted as skipped.

| Document, renderer | Line starts checked | Matched | Page starts checked | Matched |
|---|---|---|---|---|
| s4-20p, node | 654 | 653 | 22 | 22 |
| s4-100p, node | 3,074 | 3,073 | 97 | 97 |
| s4-100p, harf | 3,074 | 2,975 | 97 | 94 |

**The misses are extraction artefacts.**

- The node-mode miss is a paragraph with a larger-size run. pdftotext joined "text" and "in" across the size change into "textin"; the reported offset is the true start of that line.
- The harf-mode misses are words with ligatures (section 7). Their offsets were identical to node mode's.
- The two s4-100p page starts not checked are table-of-contents pages, which have no block text.

**What the precision rests on, and its limits.**

- Offsets are exact to the UTF-16 code unit for text in paragraphs, headings, list items, table cells and footnotes. A line that starts with an inline atom reports the atom's offset.
- Characters that the `text` emitter removes (control characters) shift the offsets inside their run. The next run starts again at its stored offset.
- Hyphenation is off by default. With it on, the method still gives the offset of the first glyph after the break, but that was not tested.
- Only Latin text was tested. In complex scripts, where HarfBuzz reorders glyphs inside a cluster, a line may report the cluster's first character. Not tested.
- Display equations, the table of contents and placeholders have block-level starts only.
- Not reported yet: table rows per page and column breaks (09 §7.1), and form-field rectangles (form fields are not typeset).

**Choices made where 09 §7.1 is silent.**

- **Positions.** `y` is the baseline of the line where the block or line starts, in twentieths of a point from the top edge of the page.
- **`opensWith`** comes from the first block material on the page, in reading order:
  - `text` for body text;
  - `tableHead` for a repeated header row;
  - `footnoteContinuation` when the page has footnote text but no body text;
  - `float`, never, because the class sets no floats.
- **`starts`** skips repeated heads, the table frame and footnotes.
- **`blocks`** also carries `linePages`, the page of each line start, because the lines of one block can fall on several pages.
- **Offsets** exclude list labels and heading numbers. The class prints those; they are not in the block's text.

## 6. Sandbox escape tests

The tests are in `services/export-worker/src/sandbox.escape.test.ts`. The bundles bypass the converter on purpose: 09 §9.3 says to assume that any TeX injection means arbitrary Lua. Most compile `main.tex` with the plain `article` class plus arbitrary Lua from `attack.lua`. Findings go to `services/export-worker/out/escape-results.json`. Run with `pnpm exec vitest run --project node services/export-worker/src/sandbox.escape.test.ts`. All 14 passed.

| Attempt | Result |
|---|---|
| Engine settings | LuaTeX 1.24.0; `shell_escape=f`, `openin_any=p`, `openout_any=p`; uid 10001; `CapEff` 0; `NoNewPrivs` 1 |
| `\write18`, `os.execute`, `io.popen` (CVE-2023-32700) | `os.execute` and `io.popen` return nil, and no marker file appears. `os.spawn` does not exist |
| `os.exec` | Returns nil; the engine is not replaced |
| Reading with TeX | **`\openin` read `/etc/passwd`, `../../etc/passwd` and `/opt/docedit/compile.sh` despite `openin_any=p`** |
| Reading with Lua | Lua reads files too, but only the image's own: the `/etc/passwd` is the image's |
| Host paths and credentials | `/mnt/c`, `/mnt/wsl` and the Podman and Docker sockets are absent. `/root` is unreadable. The environment holds only the job's variables. `/run/secrets` is present (Podman's default, section 3) and held no key files |
| `\input{/etc/passwd}` | The job fails, and the file's content is not in the log |
| Writing with Lua | `io.open` cannot write to `/tmp`, `/var/tmp`, `/run`, `/opt/docedit`, the TeX tree or `/etc`. LuaTeX applies `openout_any=p` to `io.open`, even for an absolute path inside the job, and to `lfs.mkdir` and `lfs.chdir`. Relative writes in the job directory work |
| Writing with TeX | `\openout` to `/tmp` stops the job: "I can't write on file `/tmp/pwned-tex.tex'", then "Emergency stop" |
| Network (CVE-2023-32668) | `require("socket")` fails because the module is absent. `/sys/class/net` shows only `lo`. Bash's `/dev/tcp/1.1.1.1/53` gives "Network is unreachable", and no name resolves |
| Runaway TeX loop (`\def\x{\x}\x`) | Killed at the pass limit, set to 5 s for the test (exit 137); the job ended after 6.4 s |
| Runaway Lua loop | Exit 137; the job ended after 6.1 s |
| Entry point that ignores the time limit (`sleep 300`, 10 s limit) | Podman's `--timeout` ended it, with exit 255, after 11.0 s |
| Fork bomb (shell, 300 background processes) | 63 started, then "Cannot fork"; `pids.max` is 64 |
| Memory bomb (Lua, 1 MiB strings) | Killed at the 1.5 GiB limit: exit 137 after 6.8 s |
| Huge output (300 MiB into `main.log`) | `RLIMIT_FSIZE` stopped the write at 200 MiB (exit 153, SIGXFSZ). The worker received 209,715,200 bytes, within its limit |
| One job leaving a marker for the next | The marker is not visible to the next job, which gets a fresh tmpfs |

The page limit of 2,000 is enforced by the class's Lua code, for converter output only. A hostile bundle bypasses the class, so the hard bounds against it are time and output size.

## 7. luaotfload renderer and HarfBuzz mode (input to S5)

- **Renderer used: node mode.** The class passes `Renderer=Node` to every `fontspec` call, which is luaotfload's default, `mode=node`. The class option `renderer=harf` switches every font to `Renderer=HarfBuzz` (`mode=harf`).
- **HarfBuzz mode is viable with tagging.** It works with LaTeX's tagging code and with the Noto and STIX Two fonts. All three documents validate as PDF/UA-2 and PDF/A-4f in HarfBuzz mode, with exactly as many passed checks as in node mode.
- **Breaks are identical.** At 99 pages, all 1,828 blocks had the same page, the same line starts, the same line pages and the same baselines in both modes. The layout offsets survive HarfBuzz shaping unchanged.
- **Cost:** no slower than node mode (section 4.3). The class's own layout CPU time was lower in HarfBuzz mode: 255 ms against 340 ms per pass at 99 pages.
- **What changes is the extracted text of ligatures.** In HarfBuzz mode, pdftotext extracts "ﬁgure" with U+FB01 where node mode gives "figure": the ToUnicode mapping of the ligature glyph is the precomposed ligature code point, not its components.
  - This breaks the oracle of 09 §4, "the compiled PDF's extracted text equals the input".
  - It would also matter for search, and for screen readers that do not normalise compatibility characters.
  - Fixes to try, neither tested: switch off standard ligatures (`liga`), which Word does not apply by default either; or give such clusters an `/ActualText`.
- **Consequence for S5 and ADR 0016.** A HarfBuzz shaper in the editor and HarfBuzz mode in the class can work from the same font files, and the class can switch modes without breaking tagging or moving breaks in this corpus. Whether line widths agree with the editor's is S5's question. The ligature setting must be the same on both sides.

## 8. Contradictions with the spec, gaps and choices

Contradictions and gaps found:

| Point | Finding | Affects |
|---|---|---|
| 09 §9.3 item 2: "`openin_any` and `openout_any` are set to paranoid" | Paranoid output works for TeX and for Lua. Paranoid input does not restrict `\openin` or Lua reads in LuaTeX 1.24. The image must therefore hold nothing secret, and no host path may be mounted | EXP-068, EXP-072 |
| 09 §3.1 mapping names `lua-ul` and `xcolor` for highlight | `lua-ul`'s `\highLight` also needs `luacolor`. The class loads it, and tagging validated with it | EXP-015, EXP-025 |
| 09 §3.1: "one generated macro per style that sets … spacing, keep-with-next" | The larger-of rule (03 §7) depends on both neighbours, so the converter computes gaps and keep-with-next. Style macros set font, size, leading, alignment, indents and penalties | EXP-013, EXP-020, EXP-021 |
| 09 §4 `url`: "percent-encoding of characters that are special in TeX arguments" | Percent-encoding `#` or `%` changes what a URL means. The spike percent-encodes only what RFC 3986 does not allow, and passes the URL to TeX as hex digits that Lua decodes into inert characters. `pdfString` and `kvValue` use the same hex transport, so no TeX command can survive in them | EXP-043 |
| 09 §2: the bundle lists `docedit.cls` | The class has a Lua half, `docedit.lua`, which is in the bundle and in the manifest | EXP-011, EXP-015 |
| 09 §7.1 | No unit or origin is given for positions. `opensWith`, `footnoteContinuation` and `starts` are not defined for a page that begins with repeated or continued material. It is open whether list labels and heading numbers count in `offset`. The spike's choices are in section 5 | EXP-055, EXP-057, EXP-058 |
| 09 §3.1 and §9.1: draft tagging for previews | Draft saved 13 to 35 percent. `tagging=off` saved 35 to 64 percent and keeps the breaks of the final export. No `\DocumentMetadata` moves breaks | EXP-062, EXP-005 |
| 09 §8: tagging "reported as roughly three times slower" | Measured 2.3 to 5.4 times, growing with length (section 4) | EXP-060 |
| 09 §9.3 item 4: 120 s per job | A 99-page final export with three tagged passes took 56 to 95 s. Longer documents would pass 120 s at that rate; this is an extrapolation, not a measurement | EXP-071, EXP-061 |
| 09 §9.3 item 5: a curated TeX Live 2026, pinned by digest | The official image has no `TL2026` tag while 2026 is current, and its full scheme is 6 GB | EXP-073 |
| 09 §9.4: same bundle, same PDF | tagpdf names its user namespace randomly. The converter now fixes TeX's random seed first, and the sandbox then gives byte-identical PDFs | EXP-076 |
| 03 §4.1: published bullet characters | `◦` (U+25E6) is not in Noto Serif, so with `\tracinglostchars=3` the export fails, as designed. The other listed bullets were not checked. A fallback chain is needed | EXP-026, EXP-047 |
| 03 §4.1: heading levels 1 to 9 | The tagging code names only six sectioning levels below `\part`. The class maps levels 6 to 9 onto level 5's roles, so they appear as `H6`, and Heading 1 appears as `H2` | EXP-022, EXP-112 |
| 03 §6 step 1: "defaults from settings and the default paragraph style" | It does not say whether the default paragraph style applies under every paragraph or only to paragraphs without a style. The spike applies it under every paragraph | EXP-020, CDM-005 |
| luaotfload in a read-only image | Font caches are read from `TEXMFSYSVAR`, but luaotfload looks for its names database only in the writable cache root. The image therefore copies it into the job's tmpfs (`compile.sh`) | EXP-073, EXP-063 |
| `openin_any=p` on Windows | Paranoid input breaks luaotfload locally, because `kpse.find_file` returns nil for files in the TeX tree. Local comparison runs use `a` | Local tooling only |

**The CDM changed during the spike.** CDM-001 turned the content of `footnote` into `paragraph+`, exactly one paragraph in version 1. The model also gained `source_def`, `citation`, `bibliography` and `settings.citationStyle`, and dropped the form-field kind `attachment`.

- The converter reads footnotes in both shapes. The paragraph, when there is one, is the block whose text the offsets count; its kind in `map.json` is `footnoteParagraph`.
- `citation` and `bibliography` print placeholders, with the diagnostic `citation_unsupported` (EXP-121). `source_def` is ignored with the same diagnostic.
- `generate-corpus.ts` follows the model's definition. The fixtures now hold paragraph footnotes, with the same text as the measured ones. In the new shape, s4-20p compiles to a PDF byte-identical to the one from the old shape (SHA-256 beginning `7F49C2BE3B01C0D2`), with identical layout for all 385 blocks outside the footnotes. The measurements therefore apply unchanged.

**Choices made where the spec is silent:**

- A `widowControl` of null means on, as in Word.
- Lists nest by level within one `listId`, and a list ends at the first paragraph that does not belong to it.
- The renderer and the layout granularity are class options, which the converter chooses.
- Fields the spike does not compute print their `cached` text, with a diagnostic.
- The `layout.json` choices are listed in section 5.

## 9. Risks and recommendations for the production stories

| Story | Recommendation |
|---|---|
| EXP-015 house class | Keep the package list, adding `luacolor`. Keep the kernel's list environment with explicit label boxes, and the structure names for heading levels 6 to 9. Re-validate whenever `latex-lab` changes: a new kernel changed how footnotes are set |
| EXP-016 veraPDF in CI | Use the pinned `verapdf/cli` image with the flavours `ua2` and `4f`; `compile.e2e.test.ts` is the seed. A 99-page document has about 570,000 checks; veraPDF finished them in under a minute here (not timed separately) |
| EXP-005, EXP-062 previews | Compile previews with `tagging=off`, not `draft`, so that preview breaks equal final breaks. Never drop `\DocumentMetadata`, which moves breaks |
| EXP-060 latency target | A final export of 22 pages took 21.7 s wall for three passes, against a 10 s target. A one-pass preview with `off` is about 3.8 s plus 1.25 s overhead. The final target needs EXP-063 (engines started ahead, past the preamble) or fewer passes. The preamble and class alone cost about 1.9 s per pass (s4-01p, untagged) |
| EXP-061 convergence | Hashing `main.aux`, `main.toc` and `main.out` works. s4-20p and s4-100p converged in three passes (table of contents), s4-01p in two |
| EXP-055, EXP-057 layout | Line-level reporting costs about 1.6 percent of a pass at 99 pages, so it can ship with block level. Specify units, `opensWith` and table rows per page in 09 §7.1. The schema is `LAYOUT_SCHEMA` in `src/layout.ts` |
| EXP-056 layout check | `check-layout.ts` is a working base. CI needs a Linux text extractor, such as poppler's `pdftotext -raw`; the TeX Live image has none |
| EXP-068 engine hardening | Keep shell escape off and `openout_any=p`; both work. Do not rely on `openin_any=p`. The image build already refuses a LuaTeX older than 1.17 |
| EXP-069 sandbox technology | Podman with crun gave every property tested here, once cgroups were delegated. crun on this machine is built with libkrun (`+LIBKRUN`), so `--runtime=krun` microVMs are an option to compare with gVisor and Firecracker (not tested) |
| EXP-070, EXP-071 single-use sandbox and limits | Use the flag set of section 3. Rootless Podman in production needs cgroup v2 delegation for `cpu`, `memory` and `pids`. The page limit can only be a diagnostic; time and output size are the hard bounds |
| EXP-072 credentials | Ship an empty `mounts.conf` for the workers, so that `/run/secrets` stays empty, and check `/run/.containerenv` |
| EXP-073 image | Keep the digest pin, `fonts.lua`, the warm-up and the names-database copy. Cut the 6 GB full-scheme base down to the class's packages |
| EXP-075 adversarial tests | Keep `sandbox.escape.test.ts`, and run it on the production runtime and on rootless Podman |
| EXP-076 reproducibility | Keep the fixed random seed, `SOURCE_DATE_EPOCH`, `FORCE_SOURCE_DATE` and the fixed job path. Two sandbox compiles of one bundle were byte-identical |
| EXP-078 upgrades | One of 1,828 blocks moved between TeX Live 2025 and 2026, with identical fonts |
| EXP-042 to EXP-046 emitters | The `Tex` brand, `lit` and the raw `tex` template make an unescaped user string a type error. Hex transport removes the escaping rules for PDF strings, options and URLs. A property test (2,000 runs) checks that decoding `text(s)` gives back the cleaned input |
| EXP-026, EXP-047 fonts | Loading by path and hash works. Add a fallback chain before the published bullet list is used |
| EXP-049 to EXP-053 math gate | Only a stub exists. Tagged math embeds MathML and the LaTeX source, which is one reason for PDF/A-4f |
| EXP-111, EXP-112 tagging | Headers and footers did not trouble veraPDF. Heading levels collapse to `H6` below level 5, and Heading 1 is `H2` |
| SPK-018 (S5) | HarfBuzz mode is viable with tagging; align the ligature setting with the editor's |

## 10. Not covered

- Content: images and figures; tab stops; section page-setup changes; columns; fields other than page, page count and date; suggestions and comments; languages through `babel`; fallback fonts; the real math gate and the alternative text of equations; right-to-left and complex scripts; citations.
- Heading levels 6 to 9 on TeX Live 2025.
- Two independent compiles before sealing (EXP-079).
- gVisor or Firecracker, rootless Podman on Linux, server hardware, and compile cost at scale.
