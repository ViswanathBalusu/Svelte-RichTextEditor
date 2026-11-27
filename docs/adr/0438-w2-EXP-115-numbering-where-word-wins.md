# ADR 0438: Numbering where Word and the model disagreed (lane w2, EXP-115)

- Status: proposed
- Date: 2026-11-27
- Story: EXP-115 criterion 2 (owner decision 238 of 2026-11-26)

## Context

The numbering fixtures of `packages/model` ran against the DOCX writer through Microsoft Word, and 19 of the 48 cases printed other labels than the fixture (EXP-115 Notes, 2026-11-18). Owner decision 238 says that where Word and our rule give different labels, Word's labels win and the PDF labels change to match. Some of the 19 were rule conflicts and some were defects of the writer, which printed an error or nothing.

## Decision (proposed; the owner decided that Word wins, not the wording of each rule)

Rule changes in the model (`packages/model/src/numbering/labels.ts`, `format.ts`), each read from the PDF text that Word 16 made for the case, and for the first one from three more probe documents (levels 2, 1, 0 in other orders, 2026-11-27):

1. A level above a counted one that has not been counted yet is counted once, at its `start`. Level 0 then level 2 gives 1.1.1; a first item at level 1 gives 1.1; the next item at level 1 gives 1.2. This also holds for level 0 itself.
2. A template that names a level below its own, or a level the definition lacks, prints no label.
3. Letters and Roman numerals print nothing for 0. A decimal level prints 0.
4. A `numberingRestart` value becomes the level's start for the rest of the list instance, so the next restart of the level begins there (Word keeps the start override).
5. Each numbering definition of a list counts on its own. A second definition under one `listId` has its own counters.
6. Numbered paragraphs and `seq` fields in footnotes count in the footnote story, apart from the body's lists and sequences.
7. A reference to a numbered paragraph prints its label without closing full stops (Word's `REF \w`).

Writer changes (`packages/export-docx/src/writer.ts`), where Word printed an error or nothing:

- The footnote format and restart are written in each `w:sectPr` as well as in the settings; Word ignored the settings alone.
- A numbered equation is `(` `SEQ Equation` `)`, so that Word counts it with `seq` fields of that name. A reference reads the field, without the brackets.
- A reference to a caption or figure number reads the `SEQ` field, with the paragraph's or the user's bookmark round the field, and a plain `REF`. A reference to a footnote bookmark is `NOTEREF`, with the bookmark round the footnote mark in the text.
- A `SEQ` field in a footnote is locked, because Word cannot update it ("Error! Main Document Only.").

## Consequences

- The counter effects of a hidden region (ADR 0019) hold the state the region leaves, not increments: a skipped level and a kept restart value cannot be written as increments. `CounterEffect` has `lists`, `noteLists`, `sequences`, `noteSequences` and `footnotes`. The server still computes them from the full document with `counterEffects`. An effect shows the value of each counter it changed, which is a little more than before for a level that restarts before it is shown.
- Labels of existing documents can change: a skipped level shows 1 where it showed 0, and a list that shared a `listId` over two definitions counts twice.
- `REF \w` of a nested label prints Word's full context (for example 1(a)), which the model does not. Not measured here; the references fixtures use one level.
- LaTeX follows the model, so its labels follow Word.
