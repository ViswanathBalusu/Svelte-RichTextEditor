# ADR 0142: export-latex lane 4, backlog batch (round 1)

Status: proposed. Date: 2026-11-13. Scope: EXP-export.md, phase 2 LaTeX-side stories, worked from the end of the slice (EXP-113, EXP-086, EXP-085).

## Context

The lane takes stories that the package can meet on its own. Criteria that need a LuaLaTeX compile, a veraPDF run, the export service or the editor stay unticked, with the reason in the story's Notes.

## Decisions taken in this batch (spec defaults; none is an owner decision)

1. **Count of pictures without alternative text (EXP-113).** The count is one per occurrence, so a block with two pictures without alternative text counts twice, and its identifier appears twice. The spec says only that the job reports each picture with its block identifier. The report is read from the job's diagnostics, so the job and the preflight agree by construction (`packages/export-latex/src/alt-report.ts`).
2. **The canonical JSON keeps only `cdm`, `requires` and `doc` (EXP-086).** This is the existing behaviour of `canonicalEnvelope` in `@docedit/model`. It was not changed here; the tests of `packages/export-latex/src/cdm-writer.test.ts` now check it.
3. **Equation text alternative and licence manifest in the archive (EXP-085).** Not decided. The archive names the class licence and does not carry the package licence manifest; that manifest is in the export worker image (EXP-073). Owner or spec decision still open (09 §11, §2).

## Open questions this batch does not decide

- Whether a `final` export with `pdfStandard` `ua-2` must fail when pictures lack alternative text (EXP-113; 09 §13).
- Whether the job result object carries the count of pictures without alternative text, which the export service builds (EXP-113 criterion 2).
- How the compile of the `tex` archive is verified in CI (EXP-085 criterion 5; 09 §11).

## Consequences

Stories EXP-113, EXP-086 and EXP-085 are partly ticked. The unticked criteria are listed in each story's Notes.

## Round 2 (lane export-latex-4, 2026-11-13)

Scope: EXP-081, EXP-082 and EXP-083 (suggestions in output). The conversion of suggestions is in `packages/export-latex/src/suggestions.ts`, with the markup in `src/inline.ts`.

4. **Colours of suggestion markup (EXP-083).** Insertions `#1F5FAD` (blue, underlined), deletions `#B3261E` (red, struck through). The spec asks for colour and a non-colour cue but gives no values. These are a proposed default, not an owner decision; the owner or the design (PRODUCT.md accessibility) should confirm or replace them. The colour cue and the underline or strike-through cue are both kept, so the two differ without colour.
5. **Markup covers text runs only (EXP-083).** A paragraph, table row or table with a suggestion is printed unmarked, and atoms (images, fields, equations) with a suggestion are printed unmarked. Criterion 3 of EXP-083 (blocks marked as inserted or deleted) is not built. Spec default: no block marking is decided here; a class macro or a Lua pass would be needed.
6. **Pagination note (EXP-083 criterion 5).** The job gives one info diagnostic, `markup_pagination`, when the document has suggestions in markup mode. It is not emitted for `accept`, `reject`, or a document without suggestions.
7. **`fmt` suggestions under `reject` (EXP-081 criterion 2).** Conflict, not decided. `suggestions.ts` (ADR 0032 §1) shows a `fmt` suggestion's formatting in both modes, while EXP-081 criterion 2 says `fmt` reverts to its recorded `before` values under `reject`. The code is not changed here; the owner or the spec must say which one holds. EXP-081 criterion 1 also covers `fmt` under `accept`, which is unverified, so it stays unticked.
8. **Which targets the pending-suggestions refusal covers (EXP-082).** Open question (09 §10) left as it is. The converter reports `pending_suggestions` for every target, and the service decides whether to refuse; this package does not refuse a request.
