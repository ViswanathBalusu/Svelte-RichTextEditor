# ADR 0385: The warnings of an import job, and fonts named through the theme

Status: proposed (lane w2, 2026-11-18). Stories: EXP-106, EXP-107.

## Context

The import job (EXP-098) returns one list, `warnings`, and the protocol leaves its shape open (gap
G74; `ImportJob.warnings` is an array of free objects). The importer keeps three lists: plain
`warnings` strings, the `report` of EXP-107 (kind, action, message, count, blocks) and the `fonts`
of EXP-106. Until now only the plain strings reached the job result, so a host could not show the
report or the font substitutions to the importing user.

A file made by recent Word names its body font only through the theme (`w:asciiTheme="minorHAnsi"`,
`Aptos` in `theme1.xml`). The importer keeps `w:ascii` only, so such a family was never listed: four
corpus files of that kind gave an empty `fonts` list.

## Proposal

1. `jobWarnings(result)` in `@docedit/export-docx` joins the three lists into the job's `warnings`:
   the report lines first, then one `font substitution` line per substituted family, then the plain
   messages. Report lines keep `kind`, `action`, `message`, `count` and `blocks`. A font line has
   `kind: 'font substitution'`, `action: 'approximated'`, `count: 1`, `from`, `to`, `source`
   (`builtin`, `tenant` or `default`), `reflow` and `message`. Every line has `message`, which is
   the text to show. The shape adds keys to free objects; it does not change the protocol.
2. `ImportResult.fonts` is built from the families of the model and from the `w:rFonts` elements of
   the main part, styles, numbering, notes, comments, headers and footers, with theme references
   resolved against the theme of the main part (`src/theme-fonts.ts`). A theme reference wins over
   the literal name, as in Word. East Asian and complex-script slots are not read. The document and
   the source map are not changed: the model still holds what the file names (SR-M12).

## Open

- The record shape and the action `approximated` for a font line are proposals. The protocol
  definition (gap G74) is the owner's.
- The service does not depend on `@docedit/export-docx`; the sandboxed worker of EXP-099 joins them.
  Tests call `jobWarnings` in the importer port.
- Corpus files that carry drawings or preserved fragments fail I4 in the job today, because the
  importer's own assets (`ImportResult.assets`) are not attached to the document by the job. That is
  EXP-098 and EXP-099 territory and is not changed here.
