# Working in this repository

A document editor delivered as one web component, `<doc-editor>`, with a backend reached only through a written protocol (DEP). The specification is `docs/spec` (00 to 13), the decisions are `docs/adr`, the backlog is `docs/stories` (the format and the definition of done are in `docs/stories/README.md`), and the product record is `PRODUCT.md`. Every name (`<doc-editor>`, DEP, CDM, `@docedit/*`, `de-`, `--de-`) is a working placeholder.

## Settled by the owner (2026-11-06)

- A1: no offline-first editing; the server-authoritative commit log stands (ADR 0001).
- A2: Word files must round-trip without loss (ADR 0017, preservation layer; proposed design).
- A3: one house LaTeX class. A4: LaTeX is an export pipeline; the CDM document is the source of truth.
- Containers: use **Podman**, never Docker (`Containerfile`, `podman build`, `podman run`, `podman compose`). Make the CLI overridable with `DOCEDIT_CONTAINER_CLI`, defaulting to `podman`.

## Layout and rules

- pnpm workspace: `packages/*`, `services/*`, `apps/*`; machine-readable artifacts in `spec/` (generated, never hand-edited). Package layout follows 01 §6.
- TypeScript 6, strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums, no namespaces, no parameter properties). Relative imports end in `.ts`. Each package's `exports` point at `src/*.ts`; Node.js 22.18 runs `.ts` directly.
- Universal packages (`model`, `authority`, `rules`, `layout`, `protocol`, `backend-mock`, `backend-dep`, `export-latex`, `export-docx`, `corpus`, `history`) use lib ES2023 with no ambient types: no Node.js or browser APIs (FND-004; `.dependency-cruiser.cjs` checks their source, tests and `test/` helpers excepted). Only WebCrypto and TextEncoder, through `@docedit/model`'s platform helpers.
- `ui` never imports `prosemirror-*`; services never import `ui`, `element` or `painter` (`.dependency-cruiser.cjs`).
- Tests: `src/**/*.test.ts` or `test/**/*.test.ts` run in Node.js (`pnpm test`); `*.universal.test.ts` also run in Chromium, Firefox and WebKit (`pnpm test:browsers`; `DOCEDIT_BROWSERS=msedge` for Edge). Property tests use fast-check.
- Commands: `pnpm check` (lint, type-check, boundaries, tests, build), `pnpm generate`, `pnpm lint`, `pnpm format`, `pnpm deps:check`, `pnpm stories:check`.
- In PowerShell, put pnpm on the path first: `$env:Path = "$(npm prefix -g);$env:Path"`. The Bash profile prints a harmless `fnm` error; prefer PowerShell.

## Working in parallel

- Install dependencies only through `pwsh -NoProfile -File scripts/pnpm-locked.ps1 add --filter <package> <name>@<exact version>` (it serialises installs). Never run a bare `pnpm install` or `pnpm add` while other agents may be working.
- Do not edit root configuration (`package.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.dependency-cruiser.cjs`, `.github/`) or another agent's package; ask the main session instead.
- Never commit, push or create branches.

## Stories

- When an acceptance criterion is met and tested, tick it (`- [x]`) in its epic file and add or extend an `**Evidence:**` line under the criteria naming the tests and files. Edit story files only with exact, local edits (never rewrite a whole epic file), and only your own stories.
- A criterion that depends on something not built yet stays unticked; say why in the story's Notes.
- Never decide an open question silently. A decision the spec leaves open goes in a proposed ADR (`docs/adr/00NN-*.md`) or in the story's Notes, and is listed in your report. Owner decisions are the owner's: use the spec's default and say so.
- After editing stories, run `pwsh -NoProfile -File docs/stories/tools/check-stories.ps1` and `pwsh -NoProfile -File docs/stories/tools/progress.ps1`.

## Style

Docs and comments in plain British English (licence, behaviour, colour), short sentences, no marketing language. Never invent numbers: every figure in the spec is a target, and a measurement says how and where it was taken.
