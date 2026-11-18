# ADR 0380: Default width of a form field (FRW-080)

**Status:** proposed, 2026-11-17. Written by lane w4. The owner has not chosen the values.

## Context

12 §3.2 says that fields have a fixed width by default, so that filling them does not move line and page breaks, and owner decision 12 of 2026-11-06 chose fixed width (SPK-012). The spec gives the `width` attribute (null by default) but no default value. FRW-080 criterion 3 asks for "a fixed default width declared with the schema".

Before this record, a field with no `width` was laid out, drawn and exported as its value. Filling it moved the text around it, which is what the story forbids.

## Decision (proposed)

A field that states no `width` takes the default width of its kind. The table is `FIELD_DEFAULT_WIDTH` in `packages/model/src/definition/fields.ts`, in twips, and `fieldWidth(kind, width)` reads it. The layout (`packages/layout/src/flow.ts`), the web view (`packages/engine/src/view/form-field-view.ts`) and the PDF export (`packages/export-latex/src/inline.ts`) all call `fieldWidth`, so they cannot differ.

| Kind | Twips | Inches |
|---|---|---|
| text, choice | 2880 | 2 |
| number, initials, formula | 1440 | 1 |
| date, dateSigned | 1800 | 1.25 |
| signature | 3600 | 2.5 |
| checkbox | 288 | 0.2 |

A kind this version does not know takes 2880. The stored `width` attribute stays null when the author gave none: the default is not written into the document, so a later change of the table changes every such field at once, and a document that states a width is unaffected.

The figures are a proposal. They are not measured from anything; they are round sizes in the unit the document already uses. The owner may change any row. Changing the table needs no migration.

## What is not decided

- Whether the default should instead be one value for every kind.
- Whether an author may choose a width in the field's properties panel (FRW-073) and what its range is. The model bounds `width` at 0 to 31680 twips (ULENGTH).
- What the PDF export prints when a value is wider than its box. The class sets the value inside a box of the field's width and reports `field_too_wide` in the log; EXP-033 criterion 6 (the warning with the field's identifier) is not part of this record.

## Consequences

- A field with no `width` is now a box in the layout. The digests of the form-fields document in `packages/layout/src/layout.universal.test.ts` were recorded again (Node.js 22.18; Chromium, Firefox and WebKit give the same digests).
- A signature or initials field with no `width` is now drawn as its picture at the default width in the PDF; before, it printed no picture.
- No dependency was added.
