# 0437. The text of a list level holds literal text, and `lowerGreek` is a level format (EXP-100)

Status: the widening of the text is the owner's (decision 240, 2026-11-26). The format `lowerGreek` and the limits below are proposed (lane w2, 2026-11-27).

## Context

The text of a numbering level took only the placeholders `%1` to `%9` and the punctuation `. ( ) - § space` (03 §4.1). A Word file with "Article %1" or "NEW-%1-FORMAT" lost its words (A2), and `poi/Numbering.docx` showed "-1-" where Word shows "NEW-1-FORMAT". Its Greek list (Word's custom sequence "α, β, γ, ...") became decimal. Owner decision 240 says the label rules are widened, so that such labels match Word on the corpus.

## Decision

1. The text of a level is the placeholders `%1` to `%9` and literal text of any characters except `%`, the control characters (C0, DEL, C1), the line and paragraph separators, the TeX specials `\`, `{` and `}`, and the bidirectional overrides, at most 64 characters (a placeholder counts as two). This is the owner's widening; the exact limits are proposed. The TeX specials and the overrides stay refused because the hostile-string test of the model (CDM-015, `fuzz.test.ts`) requires every patterned grammar to refuse them. A `%` that is not a placeholder is not stored: Word's own `%%` is not read as a percent sign.
2. The level formats gain `lowerGreek`: α to ω (24 letters, no final sigma), then the letter repeated, as `lowerLetter` does (03 §7.1). Proposed. It is the one custom sequence of Word that the corpus holds; the importer reads `w:numFmt w:val="custom"` whose `w:format` starts "α, β, γ" as `lowerGreek`. Any other custom sequence is still read as `decimal` and reported. Word's rule past the 24th letter was not measured.
3. The direct writer writes `lowerGreek` as the same custom format in `mc:AlternateContent`, with `decimal` as the fallback.
4. Not changed: `seq` fields, page numbers and footnotes keep their own format lists (they do not take `lowerGreek`).

## Consequences

- `spec/cdm/cdm-1.schema.json` and its generated types change (the pattern and one enum value); documents that held the old grammar stay valid.
- A text that held only placeholders and punctuation reads and writes as before.
- LaTeX, HTML and Markdown writers print a label through their text emitters, so literal characters are escaped there.
