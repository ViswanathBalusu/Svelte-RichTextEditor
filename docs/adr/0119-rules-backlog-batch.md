# 0119. Rules backlog batch: open questions and blockers from the rules packet

**Status:** proposed (2026-11-13). Written by the rules developer in the backlog batch, round 1, for the stories FRW-014 to FRW-020 of `packages/rules`. Not reviewed by the owner.

## Context

The rules package was checked against its stories. `pnpm vitest run packages/rules` passes 20 test files and 128 tests (Node.js 22.18, Windows 11; the browser engines were not run in this round), and `tsc --noEmit -p packages/rules/tsconfig.json` passes. FRW-014 and FRW-016 are fully ticked earlier. No new criterion was ticked in this round, because every criterion still open depends on something outside `packages/rules`: the authority service (PRO-103 to PRO-107, not in `services/`), the conformance kit (PRO-108), the model's registration point (CDM-013), the save path (FRW-021, FRW-024, FRW-073) or the admission control of 04 §12. Each reason is recorded in the story's Notes, so no story file was edited in this round.

## Open questions and the default taken

1. **Budget for a fill at the limits (FRW-019 criterion 5).** 04 §12 names no number for the evaluation budget. The package counts steps and stops at a given budget with `budget_exceeded`; the authority maps this to `rate_limited` at `RoomInit.ruleBudget`, 100,000 steps by default (ADR 0034, proposed). Default taken: the same default. Question for the owner: is 100,000 steps the admission-control budget, or should 04 §12 name one?

2. **Save-time rejection of a pattern (FRW-018 criterion 1).** The package refuses a pattern outside the subset and names the construct, through `compileRules` and `checkFieldDefinition`. Nothing saves `validation.pattern` or a rule through these functions yet. Default taken: the criterion stays unticked until FRW-021 and FRW-024 call them. Question: should the save path of the document service call the package, or the authority only?

3. **Message for `validation.pattern` (FRW-018 criterion 4).** 12 §3.2 has no message for `validation` and the CDM `validation` object has none. Default taken: none is added to the model until 12 names one (ADR 0030, open item 3).

4. **One build in three hosts (FRW-015 criterion 4; FRW-017 criterion 4; FRW-018 criterion 3; FRW-020 criteria 2 and 3).** The editor's engines (Chromium, Firefox, WebKit and Edge) and Node.js are the only runtimes with fixtures run. Default taken: these criteria stay unticked until PRO-107 and PRO-108 exist. Browser runs were not repeated in this round.

5. **Static checks in the model (FRW-015 criterion 5).** The model keeps its own I15 value check and cannot call `packages/rules`, which depends on the model, until the registration point of CDM-013 exists. Default taken: unchanged. The package's checks agree with `model.validate()` on the fixtures in `packages/rules/test/fields.test.ts`. The three differences recorded in FRW-015 Notes remain (dates before year 0100, the 4 KiB formula limit, and number length in `isDecimalString`); they belong to the model's owner.

6. **Taint defaults for values derived from hidden content (FRW-089; ADR 0019).** Built in `packages/rules/src/hidden.ts`, with `packages/rules/test/hidden.test.ts`. Default taken, the conservative one: (a) a formula or `set` value that reads a hidden field is hidden; (b) a `set` in a rule whose condition reads a hidden field is hidden too (an implicit flow, even when the value is constant); (c) a visibility, enablement, requirement or message effect under a hidden condition is reported as `conditioned` and not hidden, because it reveals one bit. Question for the owner: should (c) hide the controlled field, and should (b) be relaxed? Criterion 2 (numbering across confidential regions) and criterion 3 (redacted copies of the sealed PDF and evidence bundle) of FRW-089 remain owner decisions and are not decided here.

Round 1 addendum: FRW-089 was started in this round because it had no ticked criterion and needed only the rule graph. No criterion was ticked: the redaction marker and server evaluation are outside `packages/rules`.

## Decision requested

No decision is taken in this note for the owner. Items 1, 2 and 6 need an owner or main-session answer before the stories can close.
