# ADR 0429: Comment ranges in the DOCX writer (lane w2, EXP-093)

Status: proposed. Owner decision 102 (2026-11-15) settles the anchor: the exact range of text the thread is on. The input shape below is the lane's reading and is not confirmed.

## Context

ADR 0228 decision 4 left threads on a text range unwritten: the export input had no offsets inside a paragraph, and the choice between an offset in characters, a position in the model and block anchors only was the owner's. Decision 102 chose the exact range.

## Decision proposed

1. `CommentThread` of `packages/export-docx/src/writer-comments.ts` takes two optional members, `from` and `to`: positions in the inline content of the paragraph named by `block`, counted as ProseMirror counts them inside a text block (one for each UTF-16 unit of text, one for each atom such as a tab, a break, a field or a picture). They are the `parentOffset` of the range's ends, so the caller (the control plane, which maps ranges to the exported `seq`, SYN-032) gives them without a second counting rule.
2. With a valid range (`0 <= from <= to`, whole numbers) the writer writes `commentRangeStart` at `from` and `commentRangeEnd` and the reference at `to`, splitting a run where a marker falls inside it. A `to` past the end of the paragraph is cut to it: a range that runs on into the next paragraph is anchored to the end of the paragraph where it starts (Word allows a range across paragraphs; this writer does not write one). Without `from` and `to`, or with an invalid pair, the thread covers the whole paragraph, as before.
3. A hyperlink around a marker is written as two hyperlinks, and an open tracked insertion or deletion is closed before the marker and opened again after it.

## Not decided

- A range across paragraphs.
- Whether the control plane gives `from` and `to` to a `docx` job: there is no `docx` target in the export worker yet (EXP-090 Notes).

## Consequences

- EXP-093 criterion 4 is ticked at the writer, as criteria 1, 3 and 5 are: `packages/export-docx/test/exp-093-ranges.test.ts`.
