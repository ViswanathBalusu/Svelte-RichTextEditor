# ADR 0101: Model backlog batch, round 1 (open points found while working packages/model)

Status: proposed. Date: 2026-11-13. Scope: `packages/model` and the model side of the CDM and FRW stories.

## Context

Round 1 of the model packet worked the remaining model-side criteria of CDM-047 and CDM-050 and looked at the others in CDM-008, CDM-011, CDM-012, CDM-016, CDM-028, FND-005 and FRW-005. Most open criteria need another package, a CI job or an owner decision. Those points are listed here so that the main session can decide them. Nothing below was decided silently: each open point keeps the spec's default or stays unticked.

## Changes made in this round

- CDM-047 criterion 5 ticked. `packages/model/src/definition/supported.test.ts` tests `supportedFeatures()`, `mayOpen()` and `supportedVersions()`.
- CDM-050 criterion 5 ticked. Evidence: `packages/model/src/validate/read.test.ts` and `supported.test.ts`.

## Open points

1. **CDM-016 criterion 4: a missing built-in style is I1.** Not implemented. `validate()` accepts a new document from which `Heading1` was removed (checked on 2026-11-13 with a scratch test, then deleted). Default if the owner agrees: `validate()` reports I1 for every `BUILT_IN_STYLES` identifier that has no `style_def` with `builtIn: true`. Risk: fixtures and the test support document may not carry every built-in style, so the change touches many suites. Decision needed before the change. The story's Notes already record that ADR 0018 (proposed) reads "present in every document" as "available to every document", so the owner chooses between the two readings first. Left unticked.

2. **CDM-008 criterion 4: suggestion marks as node marks only on `paragraph`, `table_row` and `table`.** The schema cannot restrict node marks to some hosts (ProseMirror allows them on any child that permits them). `validate()` enforces it (`node_mark_host`, I1), and `marks.test.ts` covers the refusal. Whether that meets the criterion is ADR 0018's reading (still proposed). The `excludes` of `ins`, `del` and `fmt` are empty in `spec/cdm/cdm-1.prosemirror.json`. Left unticked pending ADR 0018.

3. **CDM-012 criterion 6: a changed non-null identifier is I2 when validated with the previous document.** `validate()` checks identifier changes only when the caller passes `identifierChanges` (`validate.ts` line about "no identifier changes given"); it does not derive them from `previous`, and a change by replacement is an open question (noted in `types.ts`). Default: keep the caller-supplied changes and leave the replacement case open. Left unticked.

4. **CDM-028 criterion 5, second half: a direct `borders` or `cellMargins` on a table overrides the table style in the cascade.** `cascade/resolve.ts` resolves paragraphs and runs only; there is no table resolver. The validation half (I4 for an unknown table style) is tested. Left unticked until CDM-041 gains a table resolver.

5. **FND-005 criterion 5: Zstandard for checkpoints and commit payloads.** Zstandard is service-side (FND-005 Notes), so it belongs to the document service (BE), not to the universal packages. No dependency was added.

6. **CDM-011 criterion 3: an independent non-TypeScript implementation kept in CI.** `packages/model/conformance/canonical.py` reproduces the fixtures (recorded 2026-11-06). The CI job does not exist yet. Left unticked.

7. **CDM-050 criteria 1 to 4 and 6.** They need a version n-1, a migration (CDM-049), a commit stamp (not in the model) or a release process (FND-012).

8. **CDM-042 criterion 1 ("no other code path computes list labels").** Holds for `packages/model`; the LaTeX and DOCX writers (criterion 6) are outside the package. Left unticked.

## Consequences

Ticked criteria: CDM-047 (5) and CDM-050 (5). All other open criteria in the model-side stories stay unticked with the reasons above in their Notes.

## FRW model-side stories reviewed (same round, 2026-11-13)

No FRW criterion was ticked in this round. The open criteria need another package, the editor, a decision, or a corpus run through two packages:

- FRW-001 (3, 4): the `defs` scope check is the authority's (PRM); the content API is PRO.
- FRW-002 (3): the identifier plugin is an editing plugin that FE mounts (CDM-012). (4): the copy's `key` is an open question in the story. (5): redaction must hold on every read path (SYN, EXP, PRO).
- FRW-003 (5, 6): reading at a `seq` and restoring are HIS and the authority's (FRW-029).
- FRW-004: all five criteria need `@docedit/rules` (phase 2); the model holds no entry checks by design (ADR 0030 §6).
- FRW-005 (6): one corpus must run through `model.validate()` and the authority. The authority calls `validateDoc`, so the verdicts agree by construction, but no test runs the corpus through both. That test belongs to the authority package.
- FRW-006 (1, 5): the editor's. (4): the PDF writer's (EXP).
- FRW-011: every criterion is the authority's (PRM, FILL_ATTRIBUTES in `@docedit/model/definition` is the model's input) or the editor's.
- FRW-088 (3): the authority refuses changes by readers, and the editor shows the redaction (FE-141). The model's marker and projection are tested.
- FND-005 (3, Zstandard): service-side (BE), as noted above.

Verification in this round: `pnpm vitest run packages/model` passed 57 files and 1285 tests (Windows 11, Node.js 22.18, 17.5 s, no browsers, no containers). `tsc --noEmit` passed for `tsconfig.json` and `tsconfig.node.json`.

## Update: CDM-011 criterion 3 ticked (2026-11-13, later pass of the model packet)

- Point 6 above is superseded. .github/workflows/ci.yml has a conformance-kit job (line 121 onwards) that runs python3 -I packages/model/conformance/canonical.py spec/cdm/cdm-1.prosemirror.json packages/model/fixtures/canonical/index.json. A local run of the same command on 2026-11-13 reported bytes and SHA-256 equal for all ten cases (exit 0), and src/canonical/fixtures.test.ts passed 5 of 5.
- CDM-011 criterion 3 is ticked on that evidence. The first run of the CI job has not been observed; the Evidence and Notes say so.
- Criterion 5 of CDM-011 (the kit's export format) stays open: the kit (packages/tck, ADR 0042) is not part of this package.
- CDM-049 criteria 1 and 3 were considered and not ticked: the story's Notes already say they are properties of real migrations, and no version 2 exists.
- No other story was changed in this pass.
