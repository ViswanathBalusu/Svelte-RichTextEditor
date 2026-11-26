# 0435. Whether an entry of `layout.json` carries the field key (FRW-057)

Status: proposed. The owner has not answered. Lane w4, 2026-11-26.

## Context

Criterion 1 of FRW-057 says that `layout.json` holds, for every field, "its identifier, key, page and
rectangle". The published layout schema (09 section 7.1, example at line 171) keys each entry by the
field identifier and gives `page` and `rect` only, and it refuses members it does not list
(`additionalProperties: false`). The export writes exactly that (EXP-058,
`packages/export-latex/src/exp-058-fields.compile.test.ts`). The criterion and the schema disagree.

The signing service already joins the key to the identifier from the document (`appearances.ts` in the
document service); nothing downstream needs the key in the file.

## Options

1. **Reword the criterion** to match the schema: "an entry for every field with its identifier, page
   and rectangle; the key is read from the document by the identifier". No change to 09, the export
   or the converter's `map.json`.
2. Add `key` to each entry. This changes the published schema (09 section 7.1), `LAYOUT_SCHEMA` in the
   export worker, the authority's mirror of it (`layout-file.ts`), the converter's map and the
   export tests, and makes a file written before the change invalid.

## Recommendation

Option 1. It is the smaller change, the schema already says what the story needs, and the key is a
fact of the document, not of the page. This is the spec's default (09 section 7.1).

## What is not decided

This record is a proposal. Decisions 196 to 220 do not cover it. Until the owner answers, criterion 1
of FRW-057 stays unticked, because it asks in words for a member that the schema does not have.
Whichever option is chosen, the tests of EXP-058 (an entry for every field, with page and rectangle)
and of FRW-057 (the signing request joins the key from the document) already pass.
