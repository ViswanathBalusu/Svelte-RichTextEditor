/**
 * Flow blocks to pagination items (02 §9.1, §9.4; FE-077, FE-082): the adapter between the flow
 * (`flow.ts`) and the page pass (`paginate.ts`). Each flow paragraph is broken into lines by the
 * injected line breaker (`ItemProviders.lineBreaker`, FE-076; `firstFitBreaker` in `lines.ts` is
 * the package's own) at its section's column width, and its lines carry CDM offsets
 * inside the block, so the pieces that pagination makes cover the block's range without gap or
 * overlap (FE-078).
 *
 * A paragraph with a page or column `break` reaches this adapter as flow parts with a `pageBreak`
 * or `columnBreak` block between them (`flow.ts`, `paragraphBlocks`): part 0 ends just past the
 * break, and the next part starts there. They become paragraph items with the same block
 * identifier and a break item between them, which `paginate` honours.
 *
 * Limits of this adapter, until the stories that own them are built:
 * - a tab moves to the paragraph's tab stops, or to the default spacing `defaultTabStop` (the
 *   document's `settings.defaultTabStop`) past the last one (FE-081 criterion 3). A numbering
 *   label's tab goes to the hanging indent, which is taken as a left stop (docs/adr/0120, item 48);
 * - an inline image or preserved box is measured as one character, and its height does not raise
 *   its line; a form field's box is the exception, set at exactly its width (FRW-080);
 * - a table is not paginated (FE-083): its identifier is returned in `unplaced`;
 * - paragraphs are broken to the column width of their own section, also after a `continuous`
 *   break, whose page width applies from the next page.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type {
  FlowBlock,
  FlowDocument,
  FlowPage,
  FlowParagraph,
  FlowStories,
  FlowTable,
} from './flow.ts';
import { breakParagraphAt } from './lines.ts';
import type {
  BreakOpportunities,
  BreakRun,
  LineBreaker,
  LineTabStop,
  ParagraphInput,
} from './lines.ts';
import type { TextMeasurer } from './measure.ts';
import type { MathMeasurer } from './math-measure.ts';
import type {
  NoteItem,
  NoteRef,
  PageItem,
  PageSetup,
  ParagraphItem,
  StoryBlock,
  StoryContext,
  StoryFactory,
  StoryVariants,
  TableCellItem,
  TableItem,
  TableRowItem,
} from './paginate.ts';
import type { LayoutFragment, LayoutLine, ParagraphFragment } from './tree.ts';

export type { BreakOpportunities, LineBreaker, LineSpacing, ParagraphInput } from './lines.ts';
export { breakParagraph, firstFitBreaker } from './lines.ts';

/**
 * The injected providers (FE-076): a text measurer, the break opportunities and a line breaker.
 * They are the engine's only inputs besides the flow.
 */
export interface ItemProviders {
  readonly measurer: TextMeasurer;
  readonly breaks: BreakOpportunities;
  readonly lineBreaker: LineBreaker;
  /**
   * Typeset line starts to adopt (FE-100 criterion 1), by block identifier: CDM offsets inside the
   * block. A start is adopted only where it falls on a text position of the paragraph; any other is
   * ignored and the editor's own break stays there. Absent: no line starts are adopted.
   */
  readonly forcedLines?: ReadonlyMap<string, readonly number[]>;
  /**
   * Sizes equations from the screen fonts (FE-064 criterion 4; `math-measure.ts`). Absent, or where
   * it answers `null`, an equation keeps the stand-in size of `flow.ts`.
   */
  readonly math?: MathMeasurer;
}

export interface PageItems {
  readonly items: PageItem[];
  /** Identifiers of blocks this adapter does not place yet (tables, FE-083). */
  readonly unplaced: string[];
}

export interface DocumentItems extends PageItems {
  /** The page setup of the first section. */
  readonly first: PageSetup;
  /**
   * The footnotes that a reference in the body names, broken to the column width of the section
   * where the footnote is first referenced (FE-084). Pass them to `paginate`.
   */
  readonly notes: ReadonlyMap<string, NoteItem>;
}

/** A stretch of the breaker's text and the CDM range it stands for. */
interface Span {
  readonly t0: number;
  readonly t1: number;
  readonly cdm: number;
  readonly size: number;
  /** One text unit per CDM position: document text whose case mapping kept its length. */
  readonly exact: boolean;
}

/** The text the breaker sees for an inline. */
function inlineText(inline: FlowParagraph['inlines'][number]): string {
  switch (inline.kind) {
    case 'text':
      return inline.text;
    case 'tab':
      return '\t';
    case 'lineBreak':
      return '\n';
    case 'box':
      return '￼';
  }
}

/**
 * The breaker's text positions of the typeset line starts `cdmOffsets` (CDM offsets in the block).
 * A CDM position maps to a text position only inside an exact span (one text unit per position) or
 * at the start of any span; a start that maps to no text position, or to the paragraph's first or
 * end position, is dropped. The result is ascending and without repeats.
 */
function textStartsOf(
  cdmOffsets: readonly number[],
  spans: readonly Span[],
  length: number,
): number[] {
  const out = new Set<number>();
  for (const c of cdmOffsets) {
    for (const s of spans) {
      const inside = s.exact ? c >= s.cdm && c < s.cdm + (s.t1 - s.t0) : c === s.cdm;
      if (!inside) continue;
      const t = s.exact ? s.t0 + (c - s.cdm) : s.t0;
      if (t > 0 && t < length) out.add(t);
      break;
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Breaks one flow paragraph into lines at `columnWidth` and returns it as a pagination item. Line
 * offsets are CDM offsets inside the block: the first line starts at the part's `start` and the
 * last ends at its `end`. A line boundary inside an atom or a label (which stand for one or no CDM
 * position) falls after the atom.
 */
export function paragraphItem(
  p: FlowParagraph,
  columnWidth: number,
  providers: ItemProviders,
  defaultTabStop = 0,
): ParagraphItem {
  const runs: BreakRun[] = [];
  const spans: Span[] = [];
  const notes: NoteRef[] = [];
  let t = 0;
  for (const inline of p.inlines) {
    if (inline.kind === 'text' && inline.role === 'noteRef' && inline.ref !== undefined)
      notes.push({ offset: inline.offset, id: inline.ref });
    const text = inlineText(inline);
    if (text.length === 0) continue;
    const math =
      inline.kind === 'text' && inline.role === 'equation' && inline.latex !== undefined
        ? providers.math?.measure(inline.latex, false, inline.font)
        : null;
    runs.push({
      text,
      font: inline.font,
      ...(inline.kind === 'box' && inline.exactWidth ? { width: inline.width } : {}),
      // An equation the math measurer sizes takes that width and height (FE-064 criterion 4).
      ...(math ? { width: math.width, height: math.height } : {}),
    });
    const exact = inline.kind === 'text' && inline.role === 'text' && inline.size === text.length;
    spans.push({ t0: t, t1: t + text.length, cdm: inline.offset, size: inline.size, exact });
    t += text.length;
  }
  const length = t;
  const cdmAt = (pos: number): number => {
    if (pos <= 0) return p.start;
    if (pos >= length) return p.end;
    for (const s of spans) {
      if (pos >= s.t1) continue;
      if (pos === s.t0) return s.cdm;
      return s.exact ? s.cdm + (pos - s.t0) : s.cdm + s.size;
    }
    return p.end;
  };

  // The paragraph's tab stops (FE-081 criterion 3). A numbering label's tab (`toPt`) goes to the
  // hanging indent: it is a left stop here, as the breaker has one stop list for the paragraph.
  const tabStops: LineTabStop[] = p.tabs.map((t) => ({ position: t.position, align: t.align }));
  for (const inline of p.inlines)
    if (inline.kind === 'tab' && inline.toPt !== undefined)
      tabStops.push({ position: inline.toPt, align: 'left' });

  const input: ParagraphInput = {
    blockId: p.id,
    runs,
    markFont: p.markFont,
    ...(p.lang !== undefined ? { language: p.lang } : {}),
    columnWidth,
    indentLeft: p.indentLeft,
    indentRight: p.indentRight,
    indentFirstLine: p.indentFirstLine,
    line: p.line,
    tabStops,
    defaultTabStop,
  };
  // The typeset starts are read only when given, so the engine's providers are the three of FE-076
  // when no reconciliation is switched on.
  const forced = 'forcedLines' in providers ? providers.forcedLines?.get(p.id) : undefined;
  const starts = textStartsOf(forced ?? [], spans, length);
  const broken =
    starts.length === 0
      ? providers.lineBreaker.breakParagraph(input, providers.measurer, providers.breaks)
      : breakParagraphAt(
          input,
          starts,
          providers.lineBreaker,
          providers.measurer,
          providers.breaks,
        );
  const last = broken.lines.length - 1;
  // A paragraph with a field (FE-087) shows text that the CDM range does not hold: the line carries
  // the text it was broken from, so that the painter draws the field's value.
  const hasField = p.inlines.some((i) => i.kind === 'text' && i.role === 'field');
  const shown = runs.map((r) => r.text).join('');
  const lines: LayoutLine[] = broken.lines.map((l, i) => ({
    ...l,
    from: i === 0 ? p.start : cdmAt(l.from),
    to: i === last ? p.end : cdmAt(l.to),
    ...(hasField ? { text: shown.slice(l.from, l.to) } : {}),
  }));
  const fragment: ParagraphFragment = { ...broken, from: p.start, to: p.end, lines };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: p.spaceBefore,
    spaceAfter: p.spaceAfter,
    keepNext: p.keepNext,
    keepLines: p.keepLines,
    pageBreakBefore: p.pageBreakBefore,
    widowControl: p.widowControl,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Converts a flow table into a table item (FE-083): each row is laid out whole, and each cell's
 * paragraphs are broken at the cell's width less its side margins. The table sits in the column as
 * its `align` says. Returns null, so that the table is reported as unplaced, when it holds what the
 * adapter does not place yet: a nested table or box, a block that is not a paragraph, a row span,
 * or a footnote reference in a cell.
 */
export function tableItem(
  t: FlowTable,
  columnWidth: number,
  providers: ItemProviders,
  defaultTabStop = 0,
): TableItem | null {
  const total = t.columnWidths.reduce((sum, w) => sum + w, 0);
  const x =
    t.align === 'center'
      ? (columnWidth - total) / 2
      : t.align === 'right'
        ? columnWidth - total
        : 0;
  const rows: TableRowItem[] = [];
  for (const row of t.rows) {
    const cells: TableCellItem[] = [];
    let column = 0;
    let cellX = 0;
    for (const cell of row.cells) {
      if (cell.rowspan !== 1) return null;
      const span = Math.max(1, cell.colspan);
      const width = t.columnWidths.slice(column, column + span).reduce((sum, w) => sum + w, 0);
      column += span;
      const inner = Math.max(0, width - cell.margins.left - cell.margins.right);
      const paragraphs: ParagraphItem[] = [];
      for (const block of cell.blocks) {
        if (block.kind !== 'paragraph') return null;
        const item = paragraphItem(block, inner, providers, defaultTabStop);
        if (item.notes) return null;
        paragraphs.push(item);
      }
      cells.push({
        cellId: cell.id,
        x: cellX,
        width,
        margins: cell.margins,
        paragraphs,
        ...(cell.start !== undefined ? { from: cell.start } : {}),
        ...(cell.end !== undefined ? { to: cell.end } : {}),
      });
      cellX += width;
    }
    // The row is as tall as its tallest cell with the cell's margins, or as its height rule says.
    const content = Math.max(
      0,
      ...cells.map(
        (c) =>
          c.margins.top +
          c.margins.bottom +
          c.paragraphs.reduce(
            (sum, p) => sum + p.spaceBefore + p.fragment.height + p.spaceAfter,
            0,
          ),
      ),
    );
    const own = row.height ?? 0;
    const height =
      row.heightRule === 'exact'
        ? own
        : row.heightRule === 'atLeast'
          ? Math.max(content, own)
          : content;
    rows.push({
      rowId: row.id,
      header: row.header,
      cantSplit: row.cantSplit,
      height,
      cells,
      ...(row.start !== undefined ? { from: row.start } : {}),
      ...(row.end !== undefined ? { to: row.end } : {}),
    });
  }
  return {
    kind: 'table',
    blockId: t.id,
    x,
    width: total,
    rows,
    ...(t.start !== undefined ? { from: t.start } : {}),
    ...(t.end !== undefined ? { to: t.end } : {}),
  };
}

/** Converts the flow blocks of one section into pagination items, in order. */
export function pageItems(
  blocks: readonly FlowBlock[],
  columnWidth: number,
  providers: ItemProviders,
  defaultTabStop = 0,
): PageItems {
  const items: PageItem[] = [];
  const unplaced: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'paragraph':
        items.push(paragraphItem(b, columnWidth, providers, defaultTabStop));
        break;
      case 'box': {
        // A display equation the math measurer sizes takes that size, as wide as the column at most.
        const math =
          b.what === 'equation' && b.latex !== undefined && b.font
            ? providers.math?.measure(b.latex, true, b.font)
            : null;
        items.push({
          kind: 'box',
          blockId: b.id,
          width: math ? Math.min(math.width, columnWidth) : b.width,
          height: math ? math.height : b.height,
          keepNext: b.keepNext,
          ...(b.start !== undefined ? { from: b.start } : {}),
          ...(b.end !== undefined ? { to: b.end } : {}),
        });
        break;
      }
      case 'pageBreak':
        items.push({ kind: 'pageBreak' });
        break;
      case 'columnBreak':
        items.push({ kind: 'columnBreak' });
        break;
      case 'table': {
        const table = tableItem(b, columnWidth, providers, defaultTabStop);
        if (table) items.push(table);
        else unplaced.push(b.id);
        break;
      }
    }
  }
  return { items, unplaced };
}

/** The width of one text column of a flow page, in points. */
export function flowColumnWidth(page: FlowPage): number {
  const cols = Math.max(1, Math.floor(page.columns));
  return (page.width - page.marginLeft - page.marginRight - page.columnGap * (cols - 1)) / cols;
}

/**
 * A story resolver: the factory for a header or footer story identifier, when there is one. `page`
 * is the flow page of the section that names the story.
 */
export type StoryResolver = (storyId: string, page: FlowPage) => StoryFactory | undefined;

/** A flow paragraph with its `page` and `pageCount` fields showing the values of `context`. */
function withFields(p: FlowParagraph, context: StoryContext): FlowParagraph {
  if (!p.inlines.some((i) => i.kind === 'text' && i.role === 'field')) return p;
  return {
    ...p,
    inlines: p.inlines.map((i) => {
      if (i.kind !== 'text' || i.role !== 'field') return i;
      if (i.ref === 'page') return { ...i, text: context.label };
      if (i.ref === 'pageCount') return { ...i, text: String(context.pageCount) };
      return i;
    }),
  };
}

/**
 * The story resolver of a flow document (FE-076, FE-087): it lays out the document's own header and
 * footer stories (`FlowDocument.stories`) with the injected providers, so that the engine needs no
 * input beyond the flow and the providers. A story's paragraphs are broken to the page's text width
 * (between the left and right margins) and stacked from the story's top, with their spacing; its
 * `page` and `pageCount` fields show the page's label and the document's page count. Boxes are
 * stacked by their size. Tables and breaks inside a story are not laid out (a limit, as for the
 * body: FE-083).
 */
export function flowStoryResolver(doc: FlowDocument, providers: ItemProviders): StoryResolver {
  return (storyId, page) => {
    const blocks = doc.stories.get(storyId);
    if (!blocks) return undefined;
    const width = page.width - page.marginLeft - page.marginRight;
    return (context: StoryContext): StoryBlock => {
      const fragments: LayoutFragment[] = [];
      let y = 0;
      for (const b of blocks) {
        if (b.kind === 'paragraph') {
          const item = paragraphItem(withFields(b, context), width, providers, doc.defaultTabStop);
          y += item.spaceBefore;
          fragments.push({ ...item.fragment, y });
          y += item.fragment.height + item.spaceAfter;
        } else if (b.kind === 'box') {
          fragments.push({
            kind: 'box',
            blockId: b.id,
            ...(b.start !== undefined ? { from: b.start } : {}),
            ...(b.end !== undefined ? { to: b.end } : {}),
            x: 0,
            y,
            width: b.width,
            height: b.height,
          });
          y += b.height;
        }
      }
      return { height: y, fragments };
    };
  };
}

function variantsOf(stories: FlowStories, page: FlowPage, resolve: StoryResolver): StoryVariants {
  const pick = (id: string | null): StoryFactory | undefined =>
    id === null ? undefined : resolve(id, page);
  const def = pick(stories.default);
  const first = pick(stories.first);
  const even = pick(stories.even);
  return {
    ...(def ? { default: def } : {}),
    ...(first ? { first } : {}),
    ...(even ? { even } : {}),
  };
}

/**
 * The page setup of a flow page (03 §4.1). Headers and footers are set only when `resolve` is
 * given; their variants are the three of `page_setup`: default, first and even.
 */
export function pageSetupOf(page: FlowPage, resolve?: StoryResolver): PageSetup {
  return {
    width: page.width,
    height: page.height,
    margins: {
      top: page.marginTop,
      right: page.marginRight,
      bottom: page.marginBottom,
      left: page.marginLeft,
    },
    columns: page.columns,
    columnGap: page.columnGap,
    headerDistance: page.headerDistance,
    footerDistance: page.footerDistance,
    differentFirstPage: page.differentFirstPage,
    differentOddEven: page.differentOddEven,
    ...(page.pageNumberStart === null ? {} : { pageNumberStart: page.pageNumberStart }),
    ...(page.pageNumberFormat === null ? {} : { pageNumberFormat: page.pageNumberFormat }),
    ...(resolve
      ? {
          headers: variantsOf(page.headers, page, resolve),
          footers: variantsOf(page.footers, page, resolve),
        }
      : {}),
  };
}

/**
 * Converts a flow document into the first page setup and the pagination items of every section,
 * with a `sectionBreak` item where each later section starts.
 */
export function documentItems(
  doc: FlowDocument,
  providers: ItemProviders,
  resolve?: StoryResolver,
): DocumentItems {
  const items: PageItem[] = [];
  const unplaced: string[] = [];
  const firstSection = doc.sections[0];
  // `toFlow` always gives one section at least, with the schema's page setup defaults.
  if (!firstSection) throw new Error('A flow document has at least one section.');
  const first = pageSetupOf(firstSection.page, resolve);
  // The column width of the first section that refers to each footnote (FE-084).
  const noteWidth = new Map<string, number>();
  doc.sections.forEach((section, k) => {
    if (k > 0)
      items.push({
        kind: 'sectionBreak',
        start: section.start,
        page: pageSetupOf(section.page, resolve),
      });
    const width = flowColumnWidth(section.page);
    for (const b of section.blocks) {
      if (b.kind !== 'paragraph') continue;
      for (const inline of b.inlines)
        if (
          inline.kind === 'text' &&
          inline.role === 'noteRef' &&
          inline.ref !== undefined &&
          !noteWidth.has(inline.ref)
        )
          noteWidth.set(inline.ref, width);
    }
    const part = pageItems(section.blocks, width, providers, doc.defaultTabStop);
    items.push(...part.items);
    unplaced.push(...part.unplaced);
  });
  const notes = new Map<string, NoteItem>();
  for (const [id, width] of noteWidth) {
    const note = doc.notes.get(id);
    if (!note) continue;
    notes.set(id, {
      id,
      paragraphs: note.blocks.map((p) => paragraphItem(p, width, providers, doc.defaultTabStop)),
    });
  }
  return { first, items, unplaced, notes };
}
