# 0122. Corpus and perf backlog batch: round 1 outcome and open questions

**Status:** proposed (2026-11-13). Written by the corpus-perf developer (packet "corpus-perf", round 1). Not reviewed by the owner.

## Context

Packet "corpus-perf" owns `packages/corpus` and `packages/perf`. Its stories were FND-006, FND-007, CDM-011, CDM-014 (fixtures) and PRO-110 (fixtures). The round checked each remaining unticked criterion against the code that would have to meet it.

## Result

No criterion was ticked in this round. Every open criterion needs code, CI or a run outside the packet:

- **FND-006 criterion 5** (S4, S5, S10 and the export tests use the corpus). S10 already does. S5 and S4 are not checked, and the export tests belong to `packages/export-latex`.
- **FND-007 criterion 5** (results stored per commit, scheduled failure beyond a tolerance). The scheduled job belongs in `.github/`, which the packet may not edit.
- **CDM-011 criteria 3 and 5** (an independent implementation kept in the kit's CI, and the kit's export format). These belong to `packages/model` and `packages/tck`.
- **CDM-014 criterion 4** (the authority replays the failing fixtures). This belongs to the authority, SYN-011 and PRO-110.
- **PRO-110 criterion 5** (`protocol` and the kit run the fixtures). This belongs to `packages/tck` and `packages/protocol`.

The existing `packages/corpus` suite passes (6 files, 56 tests, `pnpm vitest run packages/corpus`). `pnpm exec tsc --noEmit -p packages/corpus/tsconfig.json` passes. The perf package was not type-checked or run in this round, and no browser run was made.

## Changes made

- `docs/stories/FND-foundations.md`, FND-006 Notes: one bullet corrected. It said S10 was not written yet. S10 loads its paragraphs with `loadDocument` and stamps its results with `corpusStamp()`. The bullet now names what is still open.
- `docs/stories/FND-foundations.md`, FND-006 Notes: the S5 sentence now says S5 stamps its results with `corpusStamp()` (`packages/perf/e2e/s5.spec.ts`, which imports `corpusStamp` and `loadDocument` from `@docedit/corpus`). The same sentence records that S4 (SPK-017) does not use the corpus: `services/export-worker/scripts/generate-corpus.ts` writes its own documents.
- Check run: `pnpm vitest run packages/corpus` passed (6 files, 56 tests) on 2026-11-13.

## Open questions

1. **S4 and the shared corpus (FND-006 criterion 5).** Answered as a check: S5 uses the corpus and its stamp. S4 does not. Its generator in `services/export-worker` is outside this packet. Default: FND-006 criterion 5 stays unticked until S4 reads `packages/corpus` (or its documents are replaced by the corpus, as its script comment allows) and the export tests exist. Question for the owner: none; the change belongs to the export-worker owner.
2. **Where the scheduled regression job runs (FND-007 criterion 5).** ADR 0037 leaves the runner open. Default: the job is added by the main session in `.github/`, as the story Notes say. Question: which runner is dedicated, and what is the tolerance policy?

No open question was decided in code during this round.
