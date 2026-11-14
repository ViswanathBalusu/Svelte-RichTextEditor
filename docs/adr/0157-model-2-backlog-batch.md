# ADR 0157: Model lane 2, backlog batch (CDM-document-model, CDM-025 to CDM-053)

Status: proposed. Owner decisions are not made here; each open point below uses the spec's default and says so.

## Context

Lane model-2 worked the end of the CDM epic (highest story number first). Most of CDM-025 to CDM-053 was already ticked. The open criteria that a package can meet were in CDM-048, CDM-049 and CDM-050. The rest need a room, a gateway, a layout engine, a writer or a CI job in another package.

## Decisions taken in this batch

1. **Migration framework shape (CDM-049).** A migration is a pure function `apply(envelope)` from version n to n+1, with `from` and `to` fixed (`src/migrate/migrations.ts`). The framework copies the input as JSON, so a migration cannot change the caller's document. It checks that the result carries `cdm` equal to `to`. It is not called by `readDocument()`. Default: this follows 03 §11.3 ("pure, tested, no I/O"); the spec does not name a shape.
2. **Attribute shape check (CDM-048 criterion 5).** `attributeShapeChanges()` in `src/definition/evolution.ts` lists top-level attributes gained or lost per node and mark, `ext` excluded. No CI job calls it yet.
3. **Test-only migrations.** No real version 2 exists, so the framework is tested with test-only migrations. No story criterion that needs a real migration is ticked.

## Open points (left open, not decided here)

- **Commit stamp (CDM-050 criterion 2).** The spec asks for an engine identifier and a package identifier in each stamp. The model package does not know the engine's version, and the source of the package identifier is not fixed. Default: not built. The caller will pass the engine identifier, and the package identifier will come from one constant tested against `package.json`. Owner or epic decision needed.
- **Rejection code of a feature-adding commit (CDM-047).** Still open, as in the epic's Open questions.
- **Table override in the cascade (CDM-028 criterion 5, CDM-041).** Built in round 2 as `resolveTableFormat()` in `src/cascade/table-format.ts`, exported from `src/index.ts` and tested in `src/cascade/table-format.test.ts`. Default taken: `borders` and `cellMargins` are whole values, like the paragraph `borders` (CDM-041), so a direct value replaces the style's value and does not merge with it; a table without a style takes only its direct values. The spec (03 §6) does not state this for tables, so this default is proposed for owner confirmation. The paragraph cascade in `resolve.ts` is unchanged. No layout engine or writer calls the new resolver yet; that is CDM-041 criterion 7.

## Consequences

- `packages/model/src/migrate/` and `packages/model/src/definition/evolution.ts` are new files. Their tests are `migrations.test.ts` and `evolution.test.ts`.
- CDM-049 criterion 5 is ticked. Criteria 1 to 4 stay open. CDM-048 criterion 5 stays open until CI calls the check.
