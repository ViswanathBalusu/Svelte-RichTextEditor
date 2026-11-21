# ADR 0032: Layout semantics shared by the editor and the writers

**Status:** accepted. Proposed on 2026-11-06 as the recommendation of spike CDM-005 and the decisions behind CDM-041 to CDM-045. The project owner accepted it on 2026-11-15 ([docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)): decision 10 accepts it as proposed, with decision 9 (Word's order: the numbering level's indent overrides the paragraph style's) and decision 11 (a reader of a projection sees the full document's numbers) in place of its first two open questions. Decisions 77 (a header and footer that leave no room) and 78 (a `multiple` line height is rounded to whole twips) were applied here later. 03 §6 and §7 state the rules since 2026-11-20. The owner of the LaTeX class (EXP) has not yet confirmed the review record of the fixtures (ADR 0361; CDM-005, criterion 4).

## Context

03 §6 fixes the order of the formatting cascade, and 03 §7 states the layout rules in one line each. 03 says they "are to be completed with fixtures during phases 0 and 1". ADR 0004 (after the first review) gives numbering, spacing, header growth and tabs one normative definition, because three engines computing them separately will disagree. Review items M-4 and M-12 to M-14 found exactly that.

They already disagree. Spike S7 (`packages/layout/src/flow.ts`) and spike S4 (`packages/export-latex/src/numbering.ts`, `cascade.ts`) each carry a stand-in. They differ on widow control when nothing sets it, on `restartAfter`, on letters and Roman numerals for 0 and for large values, and on contextual spacing. S7's report (§7) asks three questions of this ADR: whether a table style overrides `Normal` in tables, whether numbering indents override style indents, and whether runs of spaces collapse.

Since then, ADR 0019 (read restrictions) lets a reader hold a projection in which a hidden region is a placeholder. Review SR-C3 found that labels computed on a projection differ from those on the full document, and that labels on the full document reveal how many numbered items a hidden region holds. CDM-001 has since given footnotes one paragraph of content (`paragraph+`, one in version 1).

## Decision

`packages/model` holds the one implementation, and every writer prints its results:

| Rule | Functions | Fixtures (`packages/model/fixtures/semantics/`) |
|---|---|---|
| Cascade (03 §6) | `resolveParagraph`, `resolveRun`, `resolveLabelRun` (`src/cascade/resolve.ts`) | `cascade.json` |
| Numbering (03 §7) | `computeLabels`, `counterEffects`, `referenceText` (`src/numbering/labels.ts`) | `numbering-lists.json`, `numbering-sequences.json`, `numbering-footnotes.json`, `numbering-references.json`, `numbering-projections.json` |
| Paragraph spacing | `paragraphGap`, `flowGaps` (`src/spacing/gaps.ts`) | `paragraph-spacing.json` |
| Line spacing | `lineHeight` (`src/spacing/lines.ts`) | `line-spacing.json` |
| Tabs | `nextTabStop`, `placeTab`, `decimalIndex` (`src/spacing/tabs.ts`) | `tabs.json` |
| Header growth | `bodyFrame`, `headerFor`, `footerFor` (`src/spacing/page.ts`) | `header-growth.json` |
| Spaces (S7 question 3) | `spaceRuns` (`src/spacing/whitespace.ts`) | `whitespace.json` |
| Fields (time zone) | `dateFieldText` (`src/numbering/dates.ts`) | `date-fields.json` |

The functions are pure and deterministic and use no Node.js or browser API. Lengths are integers in twips. They read plain JSON or ProseMirror nodes, so the editor need not serialise its document. They never write into the document (03 §1 principle 5). All are exported from `@docedit/model`.

### 1. Cascade (CDM-041)

| Question | Decision |
|---|---|
| Base values (layer 0), which 03 does not give | Paragraphs: `align: start`, indents and spaces 0, `lineSpacing: 1000` under `multiple`, every boolean false except `widowControl: true`, no tabs, borders or shading; `dir` from `settings.dir`. Runs: `fontSize: 220`, every toggle false, `underline: none`, `vertAlign: baseline`, colour and highlight null; `lang` from `settings.lang`; `fontFamily` null, meaning the font registry's default face. Both spikes used 220. Widow control is on, because 02 §9.4 lists widow and orphan control among the pagination rules and TeX penalises widows by default; the spikes disagreed (S4 on, S7 off) |
| Layers 1 and 4 both reach the default paragraph style (S7 question 1) | A style counts once, at the first layer that reaches it. `Normal` is layer 1 and is not applied again in layer 4, so a table style (layer 2) overrides `Normal` for a `Normal` paragraph in a table, and for a style based on `Normal` where that style does not set the property. Otherwise layers 2 and 3 could never override the most common style |
| Numbering indents and paragraph-style indents (S7 question 2) | **Decided by the owner on 2026-11-15 (decision 9, [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)): Word's order.** The numbering level's indent overrides the paragraph style's. The order of 03 §6 is now: defaults, table style, paragraph style chain, numbering level, direct attributes. A ListParagraph style with indentLeft: 720 therefore no longer gives every level the same left indent. The resolver applies the level after the style chain (`resolve.ts`); a direct indent still wins over the level |
| What layer 3 contributes | The level's `indentLeft`, and its `hanging` as a negative `indentFirstLine`. The level's `align` places the label and its `runProps` format the label only (`resolveLabelRun`), so neither is a paragraph property |
| Which numbering applies | `numbering` resolves like a property through layers 1, 2 and 4; a paragraph's own `numbering` (layer 5) replaces it whole |
| Object and list values | `tabs`, `borders`, `shading` and `numbering` are whole values: the last layer that sets one gives all of it. An empty `tabs` list clears the stops a style sets. Stops are sorted by position; at one position the later entry wins |
| Pairs such as `lineSpacing` and `lineRule` | Resolved one by one, like every other property, so concurrent edits to each stay separate (03 §4.1) |
| Toggles | The last layer that sets one wins; a mark without `value` switches on. There is no exclusive-or between a paragraph style and a character style, which Word applies to its toggle properties: the DOCX writer writes explicit values |
| Marks that do not format | `link`, `ins`, `del`, `fmt` and `preserved` are ignored; text with a `fmt` suggestion shows the formatting it suggests |
| Headings | `outlineLevel` comes from the paragraph's own style chain only, not from the default style |
| Broken chains | A missing style, a cycle and a chain of more than ten styles are typed errors (`style_missing`, `style_cycle`, `style_chain_too_long`); resolution always ends. I4 and I5 normally prevent all three |

### 2. Numbering (CDM-042)

| Question | Decision |
|---|---|
| What a list is | A list instance is a `listId`. Each of its nine levels holds a counter that starts at `start - 1`. A paragraph counted at level L adds one to level L, or sets it to its `numberingRestart`. Paragraphs on two definitions with one `listId` share the counters, each formatted by its own definition |
| `restartAfter` | A 0-based level index, like `numbering.level`. Null: the level restarts after any higher level is counted. A value r below the level: it restarts only when a level from 0 to r is counted. A value at or above the level itself: it never restarts. Word's `w:lvlRestart` is 1-based with 0 meaning never (ECMA-376, `lvlRestart`), so the DOCX writer maps r to r + 1 and "never" to 0, and the importer maps back |
| `numberingRestart` | Sets the counter of the paragraph's own level, which its label then shows; deeper levels restart as after any count; higher levels are unchanged. The DOCX writer needs a new list instance with a start override for that level |
| Skipped levels, and templates that name a level not counted yet | A placeholder shows its level's counter, so an uncounted level shows `start - 1`, never below 0: level 0 then level 2 gives "1.0.1", as LaTeX's sectioning counters do. Word's behaviour is to be confirmed by spike S11. A placeholder for a level the definition does not have shows nothing |
| `legal` | Placeholders for levels above the paragraph's own are decimal, whatever their format (03 §4.1: "higher levels"). Word's `w:isLgl` may apply to the level's own number too; to be confirmed by S11 |
| Formats | Letters run a to z, then aa to zz, then aaa (Word's convention). Roman numerals write thousands beyond three as repeated m, so 4000 is "mmmm". Letters and Roman numerals have no zero: 0 is written "0". A bullet level prints its `bulletChar`, or • when that is null, and still counts. `none` prints nothing for its own level |
| Which list instance a style's numbering joins | The `listId` in the style's `numbering`. A style based on a numbered style inherits that numbering and joins the same list, as headings do |
| Copying a list (recommendation for CDM-012 and FE) | A paste maps each `listId` in the pasted content to a fresh one, the same fresh one for every paragraph that had it, so the copy is a new list numbered from its start values; a move keeps the `listId`. Labels depend only on `listId` and document order, so the rule needs nothing from this module |
| Captions (`seq`) | Counted per `name`, in document order through the body: regions, table cells, figure captions and footnotes alike. The field's `format` names a number format, decimal when it names none. A `seq` field without a name counts in no sequence and shows nothing |
| Equations | Numbered equation blocks count in the `Equation` sequence, together with `seq` fields of that name (CDM-030). The label is the number; the equation shows it in parentheses |
| Footnotes | Counted in document order through the body, in `settings.footnoteFormat`. `symbol` cycles * † ‡ §, then doubles them. `footnoteRestart: perPageSection` is read as "per page section" (03 §4.2 calls sections "page sections"): numbering restarts at every section break. A restart per page would need the typesetter, like page numbers (ADR 0018 asked) |
| Footnote content | A footnote's paragraph (CDM-001) is visited at the footnote's place in the text: its numbered paragraphs and `seq` fields count there. No table style applies to it |
| Headers and footers | Each story is numbered on its own. Footnotes in a story get no mark (03 does not say whether they are allowed; see Open questions) |
| References (`ref`) | `node:` prints the target paragraph's list label, else its first `seq` number. `bookmark:` prints the label of the paragraph or figure that holds the bookmark, or the mark of the footnote that holds it. `eq:` prints the equation's number. The label is printed as it stands, punctuation included. A target with no label, a hidden one, a `styleRef` (which needs the page) and a `formValue` give no text (null), and the writer reports it |

**Projections (SR-C3; ADR 0019).** A `hidden_region` placeholder, a `preserved_block` and an `extension_block` contribute nothing of their own. When the caller supplies a *counter effect* for its identifier, the effect is applied at its place. An effect is plain JSON. Per list instance it holds the definition it was first counted with and, per level, either `{ "add": n }` or `{ "set": v }`; per sequence name it holds a count, and for footnotes an `add` or a `set`. Effects compose, so `counterEffects(fullDocument, regionIds)` computes them on the server with the same algorithm. With the effects, a projection shows the full document's numbers. Without them, it numbers only what it holds. Both choices of SR-C3's proposal 2 can therefore be implemented without changing the algorithm; **readers see the full document's numbers, and gaps may show** (owner decision 11 of 2026-11-15, [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)), so the server sends the effects with a projection. An effect reveals, per list instance, how many items of each level the hidden region holds. That is slightly more than the visible labels reveal, because a deeper level that restarts before it is shown changes no visible label. If the count is accepted but that detail is not, the server can drop the components that no visible label after the region reads.

### 3. Paragraph spacing (CDM-043)

| Question | Decision |
|---|---|
| The gap | The larger of the upper paragraph's `spaceAfter` and the lower one's `spaceBefore` (03 §7). Secondary sources say Word 2007 and later do the same, unless the compatibility option "Don't use HTML paragraph auto spacing" is set, which makes them add up ([Word tips](https://wordribbon.tips.net/T009358_Put_Your_Space_Before_or_After.html)) |
| Whose `contextualSpacing` counts | Each paragraph's own, for its own side, as ECMA-376 defines `contextualSpacing`: when two neighbours have the same resolved style, a paragraph with it on drops its space on the side that faces the other. Two paragraphs of one style that both have it have no gap; if only the upper one has it, the lower one's `spaceBefore` remains. S7's prototype used "either"; it should use this rule |
| Same style | The same resolved style: a paragraph with `style` null has the default paragraph style |
| Start and end of a cell, story, footnote or the body | The first paragraph keeps its `spaceBefore` and the last keeps its `spaceAfter`; both count in the container's height (a header's height, CDM-045) |
| Regions and section breaks | Transparent: spacing and contextual spacing run across them as if they were not there. Regions are not visible in output (09 §3.1) |
| Blocks that are not paragraphs | Tables, figures, display equations, tables of contents, extension and preserved blocks and hidden-region placeholders have no spacing of their own, so the gap next to one is the paragraph's own space |
| Footnotes on a page | The paragraphs of consecutive footnotes follow the same rule |
| The top of a page or column | Not fixed here: whether `spaceBefore` is dropped there (TeX discards glue at a break; Word drops it except after an explicit break) belongs to pagination (02 §9.4) and both engines' owners |

### 4. Line spacing (CDM-043)

| Question | Decision |
|---|---|
| `multiple` | `lineSpacing` thousandths of the natural single-spaced height of the tallest run on the line, rounded half up to whole twips. A run's height is its font's line height at its size; the layout engine measures it (02 §9.3) and the class reads the same font files. An inline picture or box counts as a run of its own height. An empty line has the height of the paragraph mark (the paragraph's own run properties) |
| `exact`, `atLeast` | Lengths in twips: `exact` is the line height whatever the runs; `atLeast` is the larger of the length and the tallest run's natural height |
| Where the extra space of a `multiple` line goes | Not fixed here (open question for FE and EXP); line heights, and therefore page breaks, agree without it |

### 5. Tabs (CDM-044)

| Question | Decision |
|---|---|
| Candidates | Positions are twips from the left margin (03 §7). A tab moves to the nearest of: the first of the paragraph's stops to the right of the current position; with a hanging indent, the left indent; the next multiple of `settings.defaultTabStop` to the right of both the current position and the paragraph's last stop. Explicit stops clear the default stops to their left; the hanging-indent stop does not. At one position an explicit stop wins over the hanging-indent stop, and that over a default stop |
| After a list label | The label is followed by a tab (Word's default suffix), resolved by the same rule. A level cannot choose a space or nothing in version 1 (see Open questions) |
| The segment after a tab | The text up to the next tab, line break or paragraph end. A left stop starts it at the stop, a right stop ends it there, a centre stop centres it there (half the width rounded down), and a decimal stop puts its first decimal separator there, or its end when it has none. A segment that does not fit starts at the current position. The leader fills the span from the current position to the segment |
| Decimal separator | A full stop in version 1 (open question) |
| Right-to-left paragraphs | Measured the same way here (open question) |

### 6. Header and footer growth (CDM-045)

| Question | Decision |
|---|---|
| Where the body starts | At the larger of `marginTop` and `headerDistance` plus the header's height |
| Whether a footer grows like a header | Yes, upwards: the body ends at the smaller of `height - marginBottom` and `height - footerDistance` less the footer's height. Word is believed to do the same (to be confirmed in S11); the class must measure its footer box as it measures its header box (09 §3.1) |
| A header and footer that leave no room | The body height is 0. The first page is shipped with an empty body and the body starts on the next page, at the same top, as the LaTeX class does (owner decision 77, docs/owner-decisions-2026-11-15.md; `startsOnPage` in `header-growth.json`, `bodyFrame` in the model, `paginate` in the layout) |
| Which story a page shows | With `differentFirstPage`, the first page of a page section shows `headerFirst`; otherwise, with `differentOddEven`, an even page shows `headerEven`; otherwise `headerDefault`. Footers alike. A null slot means no header on those pages; it does not fall back to another slot. Which page is the first of its section and which pages are even is pagination's. The CDM sets `differentOddEven` per page setup, Word for the whole document (S7 report): the DOCX writer must reconcile them |

### 7. Spaces (S7 question 3)

Spaces are kept in every writer, as 09 §3.2 already says. Each U+0020 is one space wide and stretches under justification (02 §9.3). Leading and trailing spaces of a paragraph are kept, and other space characters are ordinary characters. `spaceRuns` gives, for a paragraph's whole text, which spaces a TeX writer must write explicitly: all but the first of a run between words, and every leading and trailing space.

### 8. Date fields (03 §7, Fields)

`dateFieldText` takes the server's instant and the time zone of the workflow or the export job, with no default, so the client's zone is never used. The `format` picture has the tokens `yyyy`, `yy`, `MM`, `M`, `dd`, `d`, `HH`, `H`, `mm`, `ss`; text in single quotes and every other character is literal; null gives `yyyy-MM-dd`. Month and day names are not supported in version 1, because they need locale data that differs between engines. Zone rules come from the ECMAScript internationalisation API, which every supported engine provides; the fixtures give identical results in Node.js, Chromium, Firefox and WebKit (`pnpm exec vitest run --project browser packages/model`, 2026-11-06).

## Fixtures

One file per rule, language-neutral JSON. Every case has an `id` and a one-line `description`. Every file has a `format` paragraph that says how to build its documents and read its expectations. The documents are valid CDM documents (`model.validate`), except the ones marked `"valid": false`, which test typed errors, and the projections, which contain the projection-only `hidden_region`. The expected values were written by hand from the rules above, not generated by the implementation. `packages/model/src/cascade/semantics-fixtures.universal.test.ts` runs them all in Node.js and in three browser engines, and `semantics-fixtures-list.test.ts` fails if a fixture file is not run. A writer in another package or language reads the files with `@docedit/model/fixtures/semantics/<file>.json` and checks its own output against them.

## Measurements

Every function was timed on the corpus documents `pages-100` (1,462 paragraphs) and `pages-300` (4,195 paragraphs), corpus version 1. Each figure is the median of 10 or 20 runs after 3 warm-up runs. The range covers three runs of the test on 2026-11-06, on an Intel Core i9-10900KF (3.70 GHz) with 128 GB of memory, Windows 11 Pro, Node.js 22.18.0. Other agents' processes were running on the machine at the same time. The command was `pnpm exec vitest run --project node packages/model/src/numbering/corpus.test.ts --silent=false`.

| Work | `pages-100` | `pages-300` |
|---|---:|---:|
| `computeLabels`, JSON document | 1.4 to 2.4 ms | 4.6 to 5.8 ms |
| `computeLabels`, ProseMirror document | 1.5 to 3.3 ms | 5.0 to 9.2 ms |
| `resolveParagraph` for every paragraph, new style table | 2.4 to 3.9 ms | 4.1 to 8.4 ms |
| `resolveParagraph` for every paragraph, warm cache | 1.2 to 1.9 ms | 3.7 to 7.5 ms |
| `flowGaps` for every body, cell, story and footnote | 1.9 to 2.2 ms | 4.5 to 7.9 ms |

The typing budget (13 §9: 16 ms from keystroke to paint at the median on 100 pages) covers the whole pipeline, and these are parts of it. A full recomputation of the labels is cheap enough on 100 pages. On 300 pages the editor should recompute only after a change that can move a label: a numbering, style or definition change, or a numbered paragraph, a `seq` field, a footnote or a region added or removed. If the harness (FND-007) shows that is not enough, the next step is to cache each block's counter effect by node identity, since ProseMirror shares unchanged nodes between versions.

## Consequences

- The layout engine (FE-076, FE-077) and the LaTeX converter (EXP-002, EXP-042) replace their stand-ins with these functions. The changes they will see are widow control on by default, contextual spacing per side, `restartAfter`, uncounted levels as `start - 1`, and the formats of 0 and of large values.
- The LaTeX class prints literal labels and equation numbers (with `\tag`), applies `multiple` per line in its callback (09 §3.1), measures its footer as well as its header, and writes the spaces `spaceRuns` marks as explicit.
- The DOCX writer states the base values in `w:docDefaults`, maps `restartAfter` as above, writes toggles as explicit values, starts a new list instance for `numberingRestart`, reconciles `differentOddEven`, and checks the Word behaviours listed below in S11.
- Read restrictions need nothing more from this module than the effects; where they are computed and sent is SPK-029's and PRO's.

## Open questions

1. ~~Should numbering indents override the paragraph style's indents?~~ Settled by the owner on 2026-11-15 (decision 9): yes, Word's order. 03 §6, `resolve.ts` and the fixture `numbering-level-over-paragraph-style` follow it.
2. ~~Do readers of a projection see the full document's numbers or the projection's own?~~ Settled by the owner on 2026-11-15 (decision 11): the full document's numbers; gaps may show. `computeLabels` with the effects of `counterEffects` does this; ADR 0019 records it.
3. A paragraph cannot switch off the numbering its style gives it (Word's `w:numId` 0): `numbering: null` means inherit. Needs a definition change. A2 imports of unnumbered paragraphs in numbered heading styles need it.
4. A level cannot choose what follows its label (Word's `w:suff`: tab, space or nothing). Needs a definition change for A2 fidelity (S11).
5. Should the decimal separator of decimal tabs follow the language? It is a full stop for now.
6. Should right-to-left paragraphs measure tabs from the right margin?
7. Should `spaceBefore` be dropped at the top of a page or column, and where does the extra space of a `multiple` line go? Both are for the pagination owners (FE, EXP).
8. Should I10 forbid footnotes in headers and footers? They get no mark today.
9. To confirm against Word in S11: skipped levels shown as `start - 1`, `legal` on the level's own number, `restartAfter` beyond the 1-based mapping, header and footer growth, and the toggle and spacing differences above.
10. Month and day names in date pictures need a locale source that every engine shares.
