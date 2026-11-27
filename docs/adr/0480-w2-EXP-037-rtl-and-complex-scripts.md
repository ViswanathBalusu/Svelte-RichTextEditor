# ADR 0480: Right-to-left paragraphs and complex scripts in the PDF

**Status:** proposed, 2026-11-27 (lane w2; EXP-037, EXP-025 criterion 3). The owner has not reviewed it. Spec 09 §8 names LuaLaTeX and HarfBuzz and does not describe the mapping, so the points below were open. Each takes the choice the story's wording or the engine allows, and says so.

## Context

EXP-037 asks for right-to-left text, shaping of complex scripts, the visual order of mixed text and a display that follows the implicit bidirectional algorithm. Earlier rounds found that `\textdir TRT` alone reverses the letters of Latin words, and that the image had no Arabic, Hebrew or Indic face. Owner decisions 228 and 241 settle the faces (the Noto families, hash-pinned, in the image: CJK, Arabic, Hebrew, Devanagari, Thai).

## Decision

1. **Mechanism: babel with `bidi=basic`.** A document that has a right-to-left paragraph writes `\DEbidi` before `\DEbabel`. babel then reorders every line with the Unicode bidirectional algorithm (its `basic` implementation: weak types, neutrals, numbers), which is the implicit algorithm and nothing else. babel is already in the fixed package list (09 §9.3 item 5); no package is added. `luabidi` (also in TeX Live 2026) only sets the engine's direction registers and does not reorder, so it is not used.
2. **The direction carrier is the `arabic` locale.** babel takes the direction of a paragraph from a locale. `\DEbabel` provides `arabic` (from `ar.ini`, with no digit mapping, no captions used and no font switch) when `\DEbidi` was written, and `\DEdir{1}` selects it for the paragraphs that follow; `\DEdir{0}` selects the main language again. Any right-to-left locale would give the same layout, because the algorithm does not depend on the language. A document in Hebrew or Persian is not set in the `arabic` language: the locale only carries the direction. Hyphenation is off for right-to-left text.
3. **Indents mirror as Word does.** `indentLeft`, `indentFirstLine` and the alignment `start` belong to the start side of the paragraph, the right margin in a right-to-left paragraph; `indentRight` and `end` belong to the end side. LuaTeX swaps `\leftskip` and `\rightskip` in a right-to-left paragraph, so the class needed no change for this. Spec 03 §4.1 names the properties `indentLeft` and `indentRight` and calls the alignments logical; it does not say which side the indents are on in a right-to-left paragraph. The story says mirrored, and Word's `w:ind` is the model.
4. **Complex scripts are set a run at a time, in their own face.** luaotfload's fallback chain takes a glyph at a time from the next face, and a Devanagari syllable shaped that way is wrong (the vowel sign and the conjuncts are not reordered). The converter now sets each run of a script that needs shaping (Arabic, Syriac, Thaana, the Indic scripts, Thai, Lao, Tibetan, Myanmar, Khmer) in the face of the chain that has its first character, with the OpenType script of the run and the HarfBuzz renderer (`\DEscr{k}{run}`, face from `\DEscrfont{k}{file}{script}` in `styles.tex`). The fallback chain stays for everything else and is what the glyph check of EXP-026 reads.
5. **The renderer follows the script.** A document that has such a script is set with the HarfBuzz renderer unless the caller gave `renderer`; other documents keep `node`. Hebrew needs none.
6. **East Asian text breaks between characters** (EXP-025 criterion 3 needed it: a paragraph of Chinese was one box that ran past the margin, and `pdftotext` does not return text outside the page). A glue of no width that can stretch goes between two characters where one is an ideograph, a kana or a CJK or full-width mark (UAX #14 class ID), behind a penalty of 10000 where the rules of kinsoku shori forbid a break (a closing mark, a small kana or the prolonged sound mark at the start of a line, an opening mark at its end). Hangul keeps the breaks at its spaces.

## Limits (not done)

- Tables are not mirrored (column order stays left to right), nor are list labels, headers, footers and footnotes: only paragraphs take `dir`.
- Shading, borders and tab stops of a right-to-left paragraph are placed from the left margin by `docedit.lua`; they are not mirrored.
- The line offsets of EXP-055 are counted in logical order before babel reorders the line; they were not checked against right-to-left text.
- A script run is set in the regular face of its family: bold and italic are not applied to it (the Noto faces of the chain have no other weight).
- Text extraction: `pdftotext` returns Arabic with the presentation forms of the shaped glyphs (U+FE70 to U+FEFF); after NFKC it equals the input (the test says so). A tagged PDF with `ActualText` would not need that; it was not tried.

## Open for the owner

- Whether the `arabic` locale as the carrier of the direction is acceptable, or a document language that is right to left should be the carrier (it would also give that language's hyphenation and captions).
- Which side `indentLeft` is on in a right-to-left paragraph (decision 3).
