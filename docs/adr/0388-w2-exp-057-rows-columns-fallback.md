# ADR 0388: Table rows per page, column breaks and the block-level fallback in layout.json

Status: proposed (lane w2, 2026-11-18). Story: EXP-057, criteria 2 and 3 (and 5).

## Context

09 §7.1 says that line starts, table rows per page and column breaks are reported when `granularity`
is `line`, and that block-level starts are the minimum. It gives no shape for rows or column breaks,
and no way to say that one block could only be reported at block level. The schema of the worker
(`LAYOUT_SCHEMA`, `services/export-worker/src/layout.ts`) is the published one for EXP-055; the
reader of the page view (`packages/layout/src/layout-json.ts`) has its own interim reading
(ADR 0135, item 7) and is not changed here.

## Decision 1: rows per page, `blocks[tableId].rowPages`

An array with one entry per row of the table, in row order: the page the row starts on, from 1, or
null for a row whose cells hold no material the class reported. A repeated header row is not listed
again. The page of a row is the lowest page of the blocks its cells registered (nested tables
included).

The class is not changed. The converter records, for each table in the body flow, the range of block
numbers each row registered (`tables` of map.json, a new optional member), and the worker joins it
with the `blocks` of the class's report.

## Decision 2: column breaks, `blocks[id].columnBreaks`

An array of indexes into the block's `lineStarts`. Line k is listed when it is on the same page as
line k-1 and higher up the page (its baseline is smaller). A change of page is a page break, not a
column break. Absent when there is none. It needs no change in the class: the raw report already
holds the baseline of each line.

## Decision 3: the fallback, `blocks[id].granularity: "block"`

Under a compile at line level, a block of a text kind (`paragraph`, `heading`, `listItem`,
`cellParagraph`, `storyParagraph`, `footnoteParagraph`) that the class reports with no line gets
`granularity: "block"` and only `page` and `y`. The file's `granularity` stays `line` while at least
one text block has line starts, and is `block` when none has, or when the compile ran at block level.
The page view keeps its own lines for a marked block.

What S4 established (docs/spikes/2026-11-06-s4-latex-compile.md, section 5) is that offsets are exact
for text in paragraphs, headings, list items, table cells and footnotes, and that control characters
the `text` emitter removes shift the offsets inside their run. That second case is not detected: the
converter does not tell the class which blocks it altered. It is open whether it should.

## Open

- The shape of the three additions is a proposal; 09 §7.1 and the published schema are the owner's.
- `packages/layout`'s reader refuses unknown keys, so it would refuse a file with these members
  until it is updated (FE-100's lane).
