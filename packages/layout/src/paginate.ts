/**
 * Pagination (02 §9.4; FE-082, FE-085, FE-086, FE-087): paragraph fragments and boxes, already
 * broken into lines and sized, are placed on pages in document order. Explicit page breaks,
 * `pageBreakBefore`, `keepNext` chains, `keepLines` and widow control are applied in that priority
 * order (02 §9.4). Section breaks start a section with its own page setup (FE-086). Headers and
 * footers take space from the body (FE-087), and columns flow the body text (FE-085).
 *
 * Coordinates are points from the page's top-left corner. A paragraph fragment's `y` is the top of
 * its first line on the page; its lines' `x` and `y` are relative to the fragment (the convention of
 * `lines.ts`, rebased to the piece that lands on the page). A block whose lines spread over pages
 * gives one fragment per page, and the pieces cover its CDM range without gap or overlap (FE-078).
 *
 * Decisions, recorded in docs/adr/0120-layout-backlog-batch.md (proposed):
 * - `spaceBefore` is applied at the top of a page too; the spec does not say to suppress it.
 * - A line taller than the page body, or a box taller than it, is placed alone and reported in
 *   `overflowed`; the spec does not say what happens.
 * - A `pageBreak` on an empty page does nothing, so a break at the top of a page makes no blank page.
 * - A `continuous` section break keeps the current page with its own page setup; the new setup
 *   applies from the next page (decision 7). The exception is the column count: a `continuous`
 *   break changes the columns of the current page at once, as Word does, and content after it
 *   starts below the tallest column.
 * - `evenPage` and `oddPage` test the displayed page number and insert blank pages as needed.
 * - Headers and footers are laid out per page from the story that the page variant names: the
 *   `first` story on a section's first page under `differentFirstPage`, the `even` story on even
 *   pages under `differentOddEven`, and the `default` story on every other page, odd pages
 *   included (03 §4.1 has no odd story). A missing `first` or `even` story leaves its pages bare.
 *   Their height pushes the body in, down to the header distance. The story factory gets the page
 *   number and the document's page count; a count that changes the stories is iterated, and when it
 *   does not settle within `MAX_COUNT_PASSES` the result says so (`pageCountSettled`).
 * - Columns: a column fills before the next one starts; a `columnBreak` starts the next column.
 *   A `pageBreakBefore` starts a new page. A run of columns starts at the document's start or at a
 *   section break; a `continuous` break mid-page starts every column of the new run below the
 *   tallest column of the earlier one. A multi-column run that a `continuous` break ends is
 *   balanced on its last page, wherever it starts: the lowest column bottom at which the rest of the
 *   run holds on the page is used. Earlier pages of a long run are filled column by column.
 * - Footnotes (FE-084): the footnotes a page's references name form its bottom area, which takes
 *   space from the body. While a page fills, each body line (and box) is accepted only when the
 *   area that the page would then need still fits below it (`noteAreaAccepts` in `notes.ts`); the
 *   area is worked out again for every candidate line, so the body and the area agree when the
 *   page is finished, and a line that does not leave room moves on with its reference. The areas
 *   are then set below each page's body (`placeNotes`). A footnote that does not fit continues on
 *   the next page, and a footnote left over after the last page gets a page of its own. Column
 *   balancing trials do not see footnotes (a limit).
 * - Floating objects are not placed here, and tables are not built (FE-083).
 * - Typeset page starts (FE-100; 02 §9.7), when `pins` is given: an adopted start begins a page,
 *   and that page holds everything up to the next typeset start, below its body if need be. The
 *   overflow is the depth of the page's lowest body fragment below the body; footnote areas are not
 *   counted in it, and a held page does not leave room for its footnotes (a limit). A start inside a
 *   paragraph splits it at that line. A start whose block or line is not among the items is not
 *   adopted (`Reconciliation.unmatched`).
 *
 * Termination: every step either places at least one line or box, starts a new column or page, or
 * advances to the next item, and an empty column at the top of a page always accepts one line (a
 * column whose run starts mid-page passes what does not fit to the next column or page), so the
 * loop ends for any input. A balancing trial is a pass of its own that stops at its first page
 * turn, with no balancing inside it. The page-count iteration is bounded by `MAX_COUNT_PASSES`.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import { formatNumber } from './flow.ts';
import {
  fillNoteArea,
  freshNotePieces,
  noteAreaAccepts,
  placeNotes,
  type NotePiece,
} from './notes.ts';
import {
  rangeOf,
  type NoteItem,
  type NoteRef,
  type PageFrame,
  type PageMargins,
  type PaginatedPage,
  type ParagraphItem,
  type TableCellItem,
  type TableRowItem,
} from './page-items.ts';
import { judgePins, type PagePin, type PinJudgement } from './reconcile.ts';
import { splitRowAt } from './row-split.ts';
import { splitRowAtLine } from './row-line-split.ts';
import {
  freezeTree,
  type LayoutCell,
  type LayoutFragment,
  type LayoutLine,
  type LayoutRow,
  type TableFragment,
  pageRange,
} from './tree.ts';

// The shared item and page types live in page-items.ts, so that notes.ts and row-split.ts do not
// import this module (no import cycle). They are re-exported here under their old path.
export type {
  NoteItem,
  NoteRef,
  PageFrame,
  PageMargins,
  PaginatedPage,
  ParagraphItem,
  TableCellItem,
  TableRowItem,
} from './page-items.ts';

/** What a header or footer story says about one page. Fragments are relative to the story's corner. */
export interface StoryContext {
  /** The page's number in its section's numbering. */
  readonly number: number;
  /** The number as text, in the section's `pageNumberFormat` (the `page` field of FE-087). */
  readonly label: string;
  /** The number of pages in the document (the `pageCount` field of FE-087). */
  readonly pageCount: number;
}

export interface StoryBlock {
  /** The height the story takes, in points. */
  readonly height: number;
  readonly fragments: readonly LayoutFragment[];
}

export type StoryFactory = (context: StoryContext) => StoryBlock;

/**
 * The stories of one kind (header or footer) of a section, by page variant. These are the three of
 * `page_setup` in 03 §4.1 (`headerDefault`, `headerFirst`, `headerEven` and the footer ones): there
 * is no odd variant, and odd pages take the default story.
 */
export interface StoryVariants {
  readonly default?: StoryFactory;
  readonly first?: StoryFactory;
  readonly even?: StoryFactory;
}

/** A page setup (FE-086): size and margins in points, and the numbering of the section's pages. */
export interface PageSetup {
  readonly width: number;
  readonly height: number;
  readonly margins: PageMargins;
  /** The number of the section's first page. Without it, numbering continues from the last page. */
  readonly pageNumberStart?: number;
  /** A `formatNumber` format (`decimal` when absent). */
  readonly pageNumberFormat?: string;
  /** Columns in the body (FE-085). Defaults to 1. */
  readonly columns?: number;
  /** Space between columns, in points. Defaults to 0. */
  readonly columnGap?: number;
  /** Distance of the header from the top edge, in points. Defaults to 0. */
  readonly headerDistance?: number;
  /** Distance of the footer from the bottom edge, in points. Defaults to 0. */
  readonly footerDistance?: number;
  /** Headers by page variant (FE-087). */
  readonly headers?: StoryVariants;
  /** Footers by page variant (FE-087). */
  readonly footers?: StoryVariants;
  /** The first page of the section takes the `first` variant. */
  readonly differentFirstPage?: boolean;
  /** Even pages take the `even` variant; odd pages keep the `default` one. */
  readonly differentOddEven?: boolean;
}

/** Options of `paginate` beyond the items and the first page setup. */
export interface PaginateOptions {
  /** The footnotes that the items' references name. Without them no footnote area is laid out. */
  readonly notes?: ReadonlyMap<string, NoteItem>;
  /** Typeset page starts to adopt (FE-100; 02 §9.7). Without them the editor's own breaks are used. */
  readonly pins?: PinOptions;
}

/**
 * Page starts of the typeset result to adopt (FE-100; 02 §9.7), as `adoptablePins` gives them
 * (reconcile.ts), with the tolerance a pinned page may overflow by.
 */
export interface PinOptions {
  /** The page starts, in page order. A start is a block start or, inside a paragraph, a line start. */
  readonly pages: readonly PagePin[];
  /**
   * How far, in points, the content between a pinned start and the next typeset start may run below
   * the page body before the pin is dropped. 02 §9.7 says "small" and gives no value, so there is no
   * default: the caller passes the tenant's setting.
   */
  readonly tolerance: number;
}

/** What reconciliation did with the pins (FE-100 criteria 2 and 3). */
export interface Reconciliation {
  /** The judgement of each pin found in the items, in page order (reconcile.ts `judgePins`). */
  readonly judgements: readonly PinJudgement[];
  /** Pins whose block or line start is not among the items: not adopted, and not judged. */
  readonly unmatched: readonly PagePin[];
  /** Indexes of the pages laid out without their dropped pin: estimated until the next compile. */
  readonly estimated: readonly number[];
}

/** A block laid out by its size and never split: a figure or a display equation. */
export interface BoxItem {
  readonly kind: 'box';
  readonly blockId: string;
  readonly width: number;
  readonly height: number;
  readonly keepNext: boolean;
  /** The block's CDM range (FE-078 criterion 2). */
  readonly from?: number;
  readonly to?: number;
}

export interface PageBreakItem {
  readonly kind: 'pageBreak';
}

/** Starts the next column (FE-085); at the last column of a page it starts a new page. */
export interface ColumnBreakItem {
  readonly kind: 'columnBreak';
}

/** Starts a section. `page` is the setup of the section that starts here. */
export interface SectionBreakItem {
  readonly kind: 'sectionBreak';
  readonly start: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage';
  readonly page: PageSetup;
}

/** A table laid out by its rows (FE-083). `x` is the table's left edge from the column's left edge. */
export interface TableItem {
  readonly kind: 'table';
  readonly blockId: string;
  readonly x: number;
  readonly width: number;
  readonly rows: readonly TableRowItem[];
  /** The table's CDM range (FE-078 criterion 2). */
  readonly from?: number;
  readonly to?: number;
}

export type PageItem =
  ParagraphItem | BoxItem | TableItem | PageBreakItem | ColumnBreakItem | SectionBreakItem;

export interface Pagination {
  readonly pages: readonly PaginatedPage[];
  /** What happened to the pins, when pins were given (FE-100). */
  readonly reconciliation?: Reconciliation;
  /** Block identifiers placed taller than a page body (see the decisions above). */
  readonly overflowed: readonly string[];
  /**
   * False when the stories and the page count did not agree within `MAX_COUNT_PASSES` passes. The
   * pages are then those of the last pass, and a story may show a count other than `pages.length`.
   * The footnote areas agree with the body in every pass (see the decisions above).
   */
  readonly pageCountSettled: boolean;
}

const EPS = 1e-6;
/** Passes of the page-count iteration (FE-087) before it is reported as unsettled. */
export const MAX_COUNT_PASSES = 8;
/** Stop of the bisection that balances a run of columns (FE-085), in points. */
const BALANCE_TOLERANCE = 1e-3;

/** Geometry of one page: its body insets, its columns and its header and footer fragments. */
interface Geo {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  /** The body height between the insets. */
  readonly body: number;
  readonly cols: number;
  readonly colW: number;
  readonly gap: number;
  readonly header: readonly LayoutFragment[];
  readonly footer: readonly LayoutFragment[];
  /** The bottom inset: the footer and the margin (the footnote area sits inside the body). */
  readonly bottomFree: number;
}

interface OpenPage {
  setup: PageSetup;
  section: number;
  /** Index of the page among all pages of the pass. */
  index: number;
  /** Index of the page within its section. */
  sectionPage: number;
  number: number;
  fragments: LayoutFragment[];
  geo: Geo;
  column: number;
  /** Height used in each column. */
  colUsed: number[];
  /** Fragments placed in each column. */
  colFrags: number[];
  /**
   * Where the current run of columns starts, below the body top: 0 at the top of a page, and the
   * height of the tallest column when a `continuous` break changes the columns mid-page.
   */
  runTop: number;
  /** A balanced column bottom for this page, below the body top, or null for the body height. */
  cap: number | null;
  /** The lowest bottom of the fragments placed on the page, below the body top (FE-084). */
  bottom: number;
}

/** The footnotes of a main pass (FE-084). */
interface PassNotes {
  readonly refs: ReadonlyMap<string, readonly NoteRef[]>;
  readonly notes: ReadonlyMap<string, NoteItem>;
}

interface PassOptions {
  readonly count: number;
  /** Insets used instead of the stories' (balancing runs only). */
  readonly fixed?: { readonly top: number; readonly bottom: number };
  /** A column bottom for every page of the pass (balancing runs only). */
  readonly capAll?: number;
  /** Where the run starts on the first page of the pass (balancing runs only). */
  readonly startAt?: number;
  /** Throw `ONE_PAGE_EXCEEDED` instead of turning a page (balancing runs only). */
  readonly onePage?: boolean;
  /** Whether runs of columns are balanced. Off inside a balancing pass. */
  readonly balance: boolean;
  /** The footnotes whose areas take space from the body (FE-084). Absent in a balancing pass. */
  readonly notes?: PassNotes;
  /** The pins found in the items, by `pinKey` (FE-100). Absent in a balancing pass. */
  readonly pins?: PassPins;
}

/** A pin where it applies: its index among the pins found, and whether it is adopted (kept). */
interface PinAt {
  readonly index: number;
  readonly kept: boolean;
}

type PassPins = ReadonlyMap<string, PinAt>;

const pinKey = (blockId: string, offset: number): string => `${blockId}\u0000${offset}`;

/** Thrown by a balancing pass whose run does not hold on one page. */
const ONE_PAGE_EXCEEDED = new Error('The run of columns does not hold on one page.');

interface Pass {
  readonly pages: PaginatedPage[];
  readonly frames: PageFrame[];
  readonly overflowed: string[];
  /** Whether any story factory was called: only then can the page count change the layout. */
  readonly usedStories: boolean;
  /** The page index where the content of each pin starts, by pin index (FE-100). */
  readonly pinPages: ReadonlyMap<number, number>;
  /** How far, in points, each page's body content runs below its body (FE-100); 0 when it fits. */
  readonly pageOverflow: readonly number[];
}

/**
 * The paragraph fragments of a table cell at page position `x` (the cell's left edge) and `top`
 * (the row's top), stacked with their spacing and the cell's left and top margins (FE-083).
 */
function cellFragments(cell: TableCellItem, x: number, top: number): LayoutFragment[] {
  const out: LayoutFragment[] = [];
  let y = top + cell.margins.top;
  for (const p of cell.paragraphs) {
    y += p.spaceBefore;
    const f = p.fragment;
    out.push({
      kind: 'paragraph',
      blockId: f.blockId,
      from: f.from,
      to: f.to,
      x: x + cell.margins.left,
      y,
      width: f.width,
      height: f.height,
      lines: f.lines,
    });
    y += f.height + p.spaceAfter;
  }
  return out;
}

const shift = (f: LayoutFragment, dx: number, dy: number): LayoutFragment =>
  ({ ...f, x: f.x + dx, y: f.y + dy }) as LayoutFragment;

const columnCount = (s: PageSetup): number => Math.max(1, Math.floor(s.columns ?? 1));

/** The column width of a page with `cols` columns and gap `gap` (FE-085). */
const columnWidth = (s: PageSetup, cols: number, gap: number): number =>
  (s.width - s.margins.left - s.margins.right - gap * (cols - 1)) / cols;

/** The story a page variant names, or undefined when the page has none (FE-087). */
function storyFor(
  variants: StoryVariants | undefined,
  s: PageSetup,
  number: number,
  sectionPage: number,
): StoryFactory | undefined {
  if (!variants) return undefined;
  // A missing `first` or `even` story leaves its pages without one (ADR 0120, item 13).
  if (s.differentFirstPage && sectionPage === 0) return variants.first;
  if (s.differentOddEven && number % 2 === 0) return variants.even;
  return variants.default;
}

/** Geometry of a page for a setup, with its header and footer laid out for the page (FE-087). */
function makeGeo(
  s: PageSetup,
  number: number,
  sectionPage: number,
  opts: PassOptions,
  stats: { usedStories: boolean },
): Geo {
  const cols = columnCount(s);
  const gap = s.columnGap ?? 0;
  const m = s.margins;
  const colW = columnWidth(s, cols, gap);
  if (opts.fixed) {
    return {
      top: opts.fixed.top,
      bottom: opts.fixed.bottom,
      left: m.left,
      body: s.height - opts.fixed.top - opts.fixed.bottom,
      cols,
      colW,
      gap,
      header: [],
      footer: [],
      bottomFree: opts.fixed.bottom,
    };
  }
  const hd = s.headerDistance ?? 0;
  const fd = s.footerDistance ?? 0;
  const label = formatNumber(number, s.pageNumberFormat ?? 'decimal');
  const context: StoryContext = { number, label, pageCount: opts.count };

  let top = m.top;
  let header: LayoutFragment[] = [];
  const headerFactory = storyFor(s.headers, s, number, sectionPage);
  if (headerFactory) {
    stats.usedStories = true;
    const block = headerFactory(context);
    top = Math.max(m.top, hd + block.height);
    header = block.fragments.map((f) => shift(f, m.left, hd));
  }

  let bottomFree = m.bottom;
  let footer: LayoutFragment[] = [];
  const footerFactory = storyFor(s.footers, s, number, sectionPage);
  if (footerFactory) {
    stats.usedStories = true;
    const block = footerFactory(context);
    bottomFree = Math.max(m.bottom, fd + block.height);
    const y0 = s.height - fd - block.height;
    footer = block.fragments.map((f) => shift(f, m.left, y0));
  }

  return {
    top,
    bottom: bottomFree,
    left: m.left,
    body: s.height - top - bottomFree,
    cols,
    colW,
    gap,
    header,
    footer,
    bottomFree,
  };
}

/** The footnote references of each block, by block identifier, from the paragraph items. */
function referencesOf(items: readonly PageItem[]): Map<string, NoteRef[]> {
  const refs = new Map<string, NoteRef[]>();
  for (const item of items) {
    if (item.kind !== 'paragraph' || !item.notes || item.notes.length === 0) continue;
    const list = refs.get(item.fragment.blockId) ?? [];
    list.push(...item.notes);
    refs.set(item.fragment.blockId, list);
  }
  return refs;
}

/**
 * Places the items on pages. `first` is the page setup of the first section; a later section takes
 * its setup from its `sectionBreak` item. Footnotes come from `options.notes` (FE-084). Pure: the
 * same input gives the same pages.
 *
 * The pass is repeated while the page count that the stories see changes; `MAX_COUNT_PASSES` bounds
 * the repetitions. Footnote areas are settled inside each pass, page by page (FE-084): every
 * candidate body line works the page's area out again, so the pass needs no repetition for them.
 */
export function paginate(
  items: readonly PageItem[],
  first: PageSetup,
  options: PaginateOptions = {},
): Pagination {
  if (options.pins) return reconciled(items, first, options, options.pins);
  const s = settle(items, first, options);
  return freezeTree({ pages: s.pages, overflowed: s.overflowed, pageCountSettled: s.settled });
}

/** The pins whose place is among the items: a paragraph line start, or a box's start (offset 0). */
function matchPins(
  items: readonly PageItem[],
  pins: readonly PagePin[],
): { matched: PagePin[]; unmatched: PagePin[] } {
  const starts = new Set<string>();
  for (const item of items) {
    if (item.kind === 'paragraph')
      for (const line of item.fragment.lines) starts.add(pinKey(item.fragment.blockId, line.from));
    else if (item.kind === 'box') starts.add(pinKey(item.blockId, 0));
  }
  const matched: PagePin[] = [];
  const unmatched: PagePin[] = [];
  const seen = new Set<string>();
  for (const pin of pins) {
    const key = pinKey(pin.blockId, pin.offset);
    if (starts.has(key) && !seen.has(key)) matched.push(pin);
    else unmatched.push(pin);
    seen.add(key);
  }
  return { matched, unmatched };
}

/**
 * Pagination with typeset page starts (FE-100; 02 §9.7). A first pass adopts every pin: each starts
 * a page, and the content up to the next typeset start stays on that page even where it runs below
 * the body. The overflow of each pinned page is measured on that layout. `judgePins` keeps a pin
 * whose page overflows by no more than the tolerance and drops the others; a second pass then lays
 * the document out with the kept pins only, and the pages that held a dropped pin's content are
 * marked as estimated. Explicit breaks inside a pinned range are still honoured.
 */
function reconciled(
  items: readonly PageItem[],
  first: PageSetup,
  options: PaginateOptions,
  pins: PinOptions,
): Pagination {
  const { matched, unmatched } = matchPins(items, pins.pages);
  const passPins = (kept: (i: number) => boolean): PassPins =>
    new Map(matched.map((p, index) => [pinKey(p.blockId, p.offset), { index, kept: kept(index) }]));
  const trial = settle(
    items,
    first,
    options,
    passPins(() => true),
  );
  const overflow = matched.map((_, i) => {
    const page = trial.pass.pinPages.get(i);
    return page === undefined ? 0 : (trial.pass.pageOverflow[page] ?? 0);
  });
  const judgements = judgePins(matched, overflow, pins.tolerance);
  const dropped = (i: number): boolean => judgements[i]?.decision === 'dropped';
  const final = judgements.some((_, i) => dropped(i))
    ? settle(
        items,
        first,
        options,
        passPins((i) => !dropped(i)),
      )
    : trial;
  const estimated = new Set<number>();
  judgements.forEach((_, i) => {
    if (!dropped(i)) return;
    const start = final.pass.pinPages.get(i);
    if (start === undefined) return;
    const next = final.pass.pinPages.get(i + 1) ?? start + 1;
    for (let p = start; p < Math.max(start + 1, next); p++) estimated.add(p);
  });
  const pages = final.pages.map((p) =>
    estimated.has(p.index) ? { ...p, estimated: true as const } : p,
  );
  return freezeTree({
    pages,
    overflowed: final.overflowed,
    pageCountSettled: final.settled,
    reconciliation: { judgements, unmatched, estimated: [...estimated].sort((a, b) => a - b) },
  });
}

/** The pages of the last pass of `settle`, with that pass. */
interface Settled {
  readonly pages: PaginatedPage[];
  readonly overflowed: string[];
  readonly settled: boolean;
  readonly pass: Pass;
}

/** The page-count iteration of `paginate` (see its comment), with the pins of a reconciliation. */
function settle(
  items: readonly PageItem[],
  first: PageSetup,
  options: PaginateOptions,
  pins?: PassPins,
): Settled {
  const notes = options.notes ?? new Map<string, NoteItem>();
  const refs = notes.size > 0 ? referencesOf(items) : new Map<string, NoteRef[]>();
  const passNotes: Pick<PassOptions, 'notes'> = notes.size > 0 ? { notes: { refs, notes } } : {};
  const passPins: Pick<PassOptions, 'pins'> = pins ? { pins } : {};
  let count = 0;
  for (let attempt = 1; ; attempt++) {
    const pass = layoutPass(items, first, { count, balance: true, ...passNotes, ...passPins });
    const placed =
      notes.size > 0
        ? placeNotes(pass.pages, pass.frames, refs, notes)
        : { pages: pass.pages, areas: [] as number[] };
    // Each area fits below its page's body by construction. Only a line placed alone at the top of
    // an empty page, with a first footnote line that does not fit below it, can make an area
    // larger than that space; its block is reported as overflowing.
    const overflowed = [...pass.overflowed];
    placed.areas.forEach((a, i) => {
      if (a <= (pass.frames[i]?.area ?? 0) + EPS) return;
      const head = pass.pages[i]?.fragments[0];
      if (head && !overflowed.includes(head.blockId)) overflowed.push(head.blockId);
    });
    const settled = !pass.usedStories || placed.pages.length === count;
    if (settled || attempt >= MAX_COUNT_PASSES) {
      return { pages: [...placed.pages], overflowed, settled, pass };
    }
    count = placed.pages.length;
  }
}

/** One placement pass over the items, with the page count the stories are given. */
function layoutPass(items: readonly PageItem[], first: PageSetup, opts: PassOptions): Pass {
  const pages: PaginatedPage[] = [];
  const frames: PageFrame[] = [];
  const overflowed: string[] = [];
  const stats = { usedStories: false };
  let section = 0;
  let sectionPages = 0;
  let sectionSetup = first;
  let nextNumber = first.pageNumberStart ?? 1;
  let pendingStart: number | null = null;
  let chainTerminal = -1;
  let opened = 0;
  /** The run of columns being placed, when a `continuous` break ends it so that it is balanced. */
  let run: { readonly end: number } | null = null;
  /** Set when such a run starts and on each new page of it: the next placement balances first. */
  let checkBalance = false;
  /** Footnote text carried on to the current page, and the footnotes its references name (FE-084). */
  let noteCarry: NotePiece[] = [];
  let noteFresh: NotePiece[] = [];
  const notesPlaced = new Set<string>();
  /**
   * Pins (FE-100): while `holding`, the current page started at an adopted pin and the next typeset
   * start is not reached, so the page is not turned for want of room. `pendingPin` is the pin whose
   * content the next fragment starts.
   */
  let holding = false;
  let pendingPin: number | null = null;
  const pinPages = new Map<number, number>();
  const pageOverflow: number[] = [];

  const newPage = (): OpenPage => {
    const number = pendingStart ?? nextNumber;
    pendingStart = null;
    nextNumber = number + 1;
    const sectionPage = sectionPages++;
    const cols = columnCount(sectionSetup);
    const runTop = opened++ === 0 ? (opts.startAt ?? 0) : 0;
    const index = pages.length;
    return {
      setup: sectionSetup,
      section,
      index,
      sectionPage,
      number,
      fragments: [],
      geo: makeGeo(sectionSetup, number, sectionPage, opts, stats),
      column: 0,
      colUsed: Array.from({ length: cols }, () => runTop),
      colFrags: Array.from({ length: cols }, () => 0),
      runTop,
      cap: opts.capAll ?? null,
      bottom: 0,
    };
  };
  let cur: OpenPage = newPage();

  const finish = (): void => {
    const setup = cur.setup;
    const format = setup.pageNumberFormat ?? 'decimal';
    // The footnote area takes the space below the page's body (FE-084).
    const full = cur.geo.body;
    const area = Math.max(0, full - cur.bottom);
    frames.push({ full, area, bottomFree: cur.geo.bottomFree, format });
    pageOverflow.push(cur.bottom - full > EPS ? cur.bottom - full : 0);
    if (opts.notes) {
      // What does not fit is carried on, as `placeNotes` will carry it.
      noteCarry = fillNoteArea([...noteCarry, ...noteFresh], area).rest;
      noteFresh = [];
    }
    pages.push({
      index: pages.length,
      ...pageRange(cur.fragments),
      section: cur.section,
      width: setup.width,
      height: setup.height,
      number: cur.number,
      label: formatNumber(cur.number, format),
      orientation: setup.width > setup.height ? 'landscape' : 'portrait',
      margins: setup.margins,
      fragments: cur.fragments,
      header: [...cur.geo.header],
      footer: [...cur.geo.footer],
      footnotes: [],
    });
  };
  const turnPage = (): void => {
    if (opts.onePage) throw ONE_PAGE_EXCEEDED;
    finish();
    cur = newPage();
    holding = false;
    if (run) checkBalance = true;
  };

  const used = (): number => cur.colUsed[cur.column] ?? 0;
  const addUsed = (d: number): void => {
    cur.colUsed[cur.column] = used() + d;
  };
  const colEmpty = (): boolean => used() === 0 && (cur.colFrags[cur.column] ?? 0) === 0;
  const pageEmpty = (): boolean => cur.fragments.length === 0 && cur.colUsed.every((u) => u === 0);
  /** The height of a column of the current page: the body, or the balanced height. */
  const colH = (): number => Math.min(cur.geo.body, cur.cap ?? Number.POSITIVE_INFINITY);
  const room = (): number => colH() - used();
  const colX = (c: number): number => cur.geo.left + c * (cur.geo.colW + cur.geo.gap);
  const addFragment = (f: LayoutFragment): void => {
    if (pendingPin !== null) {
      pinPages.set(pendingPin, cur.index);
      pendingPin = null;
    }
    cur.fragments.push(f);
    cur.colFrags[cur.column] = (cur.colFrags[cur.column] ?? 0) + 1;
    cur.bottom = Math.max(cur.bottom, f.y - cur.geo.top + f.height);
    if (opts.notes && f.kind === 'paragraph') {
      const fresh = freshNotePieces(
        f.blockId,
        f.from,
        f.to,
        opts.notes.refs,
        opts.notes.notes,
        notesPlaced,
      );
      for (const p of fresh) notesPlaced.add(p.note);
      noteFresh.push(...fresh);
    }
  };

  /**
   * Whether the page still holds its footnote area when its body reaches `bottom` (below the body
   * top) and the CDM offsets [from, to) of block `blockId` join it (FE-084). `headLine` is the
   * height of the page's first body line when the page has no fragment yet.
   */
  const notesAllow = (
    bottom: number,
    headLine: number,
    span?: { readonly blockId: string; readonly from: number; readonly to: number },
  ): boolean => {
    const pn = opts.notes;
    if (!pn) return true;
    const extra = span
      ? freshNotePieces(span.blockId, span.from, span.to, pn.refs, pn.notes, notesPlaced)
      : [];
    if (noteCarry.length === 0 && noteFresh.length === 0 && extra.length === 0) return true;
    const head = cur.fragments[0];
    const first = head ? (head.kind === 'paragraph' ? (head.lines[0]?.height ?? 0) : 0) : headLine;
    const full = cur.geo.body;
    const cap = full - Math.max(cur.bottom, bottom);
    return noteAreaAccepts(noteCarry, [...noteFresh, ...extra], cap, Math.max(0, full - first));
  };
  /** Starts the next column, or a new page after the last one, unless the page holds a pinned range. */
  const breakColumn = (): void => {
    if (cur.column + 1 < cur.geo.cols) cur.column++;
    else if (!holding) turnPage();
  };

  /** Whether the content goes on in the last column of a page that holds a pinned range (FE-100). */
  const held = (): boolean => holding && cur.column + 1 >= cur.geo.cols;

  /** The pin at the start of `offset` of block `blockId`, if any (FE-100). */
  const pinOf = (blockId: string, offset: number): PinAt | undefined =>
    opts.pins?.get(pinKey(blockId, offset));

  /**
   * A typeset start is reached (FE-100): the range of the previous pin ends here. An adopted pin
   * starts a new page, which then holds its range; a dropped one leaves the flow to the editor.
   */
  const startPin = (pin: PinAt): void => {
    holding = false;
    if (pin.kept && !pageEmpty()) turnPage();
    holding = pin.kept;
    pendingPin = pin.index;
  };

  /**
   * A `continuous` break before or after columns (FE-085): the tallest column ends the run, and
   * every column of the new run starts below it. Between two single-column runs nothing changes.
   */
  const continuousColumns = (s: PageSetup): void => {
    const cols = columnCount(s);
    const gap = s.columnGap ?? 0;
    if (cols === 1 && cur.geo.cols === 1) return;
    const top = Math.max(...cur.colUsed, 0);
    const colW = columnWidth(cur.setup, cols, gap);
    cur.cap = null;
    cur.geo = { ...cur.geo, cols, colW, gap };
    cur.runTop = top;
    cur.colUsed = Array.from({ length: cols }, () => top);
    cur.colFrags = Array.from({ length: cols }, () => 0);
    cur.column = 0;
  };

  /** Starts the run of columns after the section break at `breakIndex` (-1: the first section). */
  const startRun = (breakIndex: number, cols: number): void => {
    const end = nextSectionBreak(items, breakIndex);
    const brk = items[end];
    const balanced =
      opts.balance && cols > 1 && brk?.kind === 'sectionBreak' && brk.start === 'continuous';
    run = balanced ? { end } : null;
    checkBalance = balanced;
  };

  /** The items of the run from index `i` on. */
  const runRest = (i: number): PageItem[] => (run ? items.slice(i, run.end) : []);

  /**
   * Balances the columns of the current page when the rest of the run holds on it (FE-085). Called
   * before anything is placed at the start of a run and on each new page of it, with the items
   * still to place, so the last page of a run is balanced wherever the run starts.
   */
  const maybeBalance = (rest: () => PageItem[]): void => {
    if (!checkBalance || !run) return;
    checkBalance = false;
    cur.cap = balanceCap(rest(), cur);
  };

  /** Starts a section on the current page, which is empty: its setup applies to this page. */
  const restartEmptyPage = (start: number | null): void => {
    if (start !== null) {
      cur.number = start;
      nextNumber = start + 1;
    }
    cur.setup = sectionSetup;
    cur.section = section;
    cur.sectionPage = 0;
    sectionPages = 1;
    cur.geo = makeGeo(sectionSetup, cur.number, 0, opts, stats);
    const cols = columnCount(sectionSetup);
    cur.column = 0;
    cur.colUsed = Array.from({ length: cols }, () => 0);
    cur.colFrags = Array.from({ length: cols }, () => 0);
    cur.runTop = 0;
    cur.cap = opts.capAll ?? null;
  };

  const keepsWithNext = (items: readonly PageItem[], k: number): boolean => {
    const it = items[k];
    const nx = items[k + 1];
    if (!it || !nx || (it.kind !== 'paragraph' && it.kind !== 'box') || !it.keepNext) return false;
    if (nx.kind === 'paragraph') return !nx.pageBreakBefore;
    return nx.kind === 'box';
  };

  /**
   * Height that must share a column from item i: the full height of each item in the keepNext chain
   * and the first line of its terminal item, or all of it when that item keeps its lines together.
   */
  const chainNeed = (items: readonly PageItem[], i: number): { need: number; terminal: number } => {
    let need = 0;
    let k = i;
    while (keepsWithNext(items, k)) {
      need += fullHeight(items[k] as ParagraphItem | BoxItem);
      k++;
    }
    const term = items[k] as ParagraphItem | BoxItem;
    const keepWhole = term.kind === 'paragraph' && term.keepLines;
    need += keepWhole ? fullHeight(term) : firstPart(term);
    return { need, terminal: k };
  };

  /** Applies keepNext before anything placed at item i. Returns the chain's terminal, or -1. */
  const honourChain = (items: readonly PageItem[], i: number): void => {
    if (!keepsWithNext(items, i)) return;
    const { need, terminal } = chainNeed(items, i);
    if (need <= cur.geo.body + EPS) {
      chainTerminal = terminal;
      if (!colEmpty() && need > room() + EPS) breakColumn();
    }
  };

  const placeParagraph = (item: ParagraphItem, index: number): void => {
    const frag = item.fragment;
    const lines = frag.lines;
    const n = lines.length;
    if (n === 0) {
      addUsed(item.spaceBefore + item.spaceAfter);
      return;
    }
    if (item.pageBreakBefore && !pageEmpty()) turnPage();
    maybeBalance(() => runRest(index));
    // keepLines: the whole paragraph moves unless a keepNext chain has already placed it.
    if (item.keepLines && chainTerminal !== index && !colEmpty()) {
      const whole = item.spaceBefore + frag.height;
      if (whole > room() + EPS && whole <= colH() + EPS) breakColumn();
    }

    /** The first line after `from` where a typeset page starts (FE-100), or the line count. */
    const pinStop = (from: number): number => {
      if (!opts.pins) return n;
      for (let j = from + 1; j < n; j++) if (pinOf(frag.blockId, lines[j]!.from)) return j;
      return n;
    };

    let from = 0;
    let first = true;
    for (;;) {
      const at = from;
      maybeBalance(() =>
        at === 0 ? runRest(index) : [continuation(item, at), ...runRest(index + 1)],
      );
      const sb = first ? item.spaceBefore : 0;
      // A page that holds a pinned range takes every line up to the next typeset start (FE-100).
      const hold = held();
      const avail = hold ? Number.POSITIVE_INFINITY : room() - sb;
      // Lines from..from+count, with the footnotes their references name, leave room for the
      // page's footnote area (FE-084).
      const allow = (count: number, height: number): boolean =>
        hold ||
        notesAllow(used() + sb + height, lines[from]!.height, {
          blockId: frag.blockId,
          from: lines[from]!.from,
          to: lines[from + count - 1]!.to,
        });
      const stop = pinStop(from);
      let k = 0;
      let h = 0;
      while (
        from + k < stop &&
        h + (lines[from + k]?.height ?? 0) <= avail + EPS &&
        allow(k + 1, h + lines[from + k]!.height)
      ) {
        h += lines[from + k]!.height;
        k++;
      }
      const remaining = stop - from;
      if (k < remaining) {
        if (item.widowControl) {
          if (remaining - k < 2) k = remaining - 2;
          if (k < 2) k = 0;
        }
        if (k === 0) {
          // A column that is not empty, or an empty column below text whose footnote area the
          // line would not leave room for, passes the line on.
          if (!colEmpty() || (!pageEmpty() && !allow(1, lines[from]!.height))) {
            breakColumn();
            continue;
          }
          // An empty column takes one line, so the paragraph always moves on.
          k = 1;
        }
      } else {
        k = remaining;
      }
      const piece = lines.slice(from, from + k);
      const base = piece[0]!.y;
      const pieceHeight = piece.reduce((sum, l) => sum + l.height, 0);
      if (piece.some((l) => l.height > cur.geo.body + EPS) && !overflowed.includes(frag.blockId))
        overflowed.push(frag.blockId);
      const local: LayoutLine[] = piece.map((l) => ({ ...l, y: l.y - base }));
      addFragment({
        kind: 'paragraph',
        blockId: frag.blockId,
        from: piece[0]!.from,
        to: piece[k - 1]!.to,
        x: colX(cur.column),
        y: cur.geo.top + used() + sb,
        width: frag.width,
        height: pieceHeight,
        lines: local,
      });
      addUsed(sb + pieceHeight);
      from += k;
      first = false;
      if (from >= n) break;
      // A typeset start inside the paragraph (FE-100): its pin decides, not the room left.
      const pin = from === stop ? pinOf(frag.blockId, lines[from]!.from) : undefined;
      if (pin) {
        startPin(pin);
        continue;
      }
      breakColumn();
    }
    addUsed(item.spaceAfter);
  };

  const placeBox = (item: BoxItem, index: number): void => {
    if (item.height > room() + EPS && !colEmpty()) breakColumn();
    // A box leaves room for the footnote area of its page too (FE-084). A new page is empty and
    // takes it, so the loop ends.
    // A page that holds a pinned range keeps the box (FE-100), so the loop ends there too.
    while (!held() && !pageEmpty() && !notesAllow(used() + item.height, 0)) breakColumn();
    maybeBalance(() => runRest(index));
    if (item.height > cur.geo.body + EPS && !overflowed.includes(item.blockId))
      overflowed.push(item.blockId);
    addFragment({
      kind: 'box',
      blockId: item.blockId,
      ...rangeOf(item),
      x: colX(cur.column),
      y: cur.geo.top + used(),
      width: item.width,
      height: item.height,
    });
    addUsed(item.height);
  };

  /**
   * Places a table row by row (FE-083). A row goes on the current column whole, and a row that does
   * not fit moves to the next column or page. Each column or page holds one fragment of the table,
   * with its rows; the leading header rows repeat at the top of every continuation piece. A row that
   * does not fit the space left is cut at a paragraph boundary (`splitRowAt`, FE-083 criteria 1 and
   * 4); its tail starts the next piece. A row with no such cut moves whole, and a piece with no body
   * row yet takes its row even when the row is taller than the body, which is reported in
   * `overflowed`, so the loop always ends. A row cut at its paragraphs is placed as two rows with
   * the same `rowId`. Footnote references in cells
   * are not placed, so a table with one is not an item (`tableItem`).
   */
  const placeTable = (item: TableItem, index: number): void => {
    const rows = item.rows;
    let headCount = 0;
    while (headCount < rows.length && rows[headCount]!.header) headCount++;
    const headHeight = rows.slice(0, headCount).reduce((sum, r) => sum + r.height, 0);
    /** The piece of the table open on the current column: its page, column and rows so far. */
    let piece: { page: OpenPage; column: number; index: number; rows: LayoutRow[] } | null = null;
    let bodyRowsOnPiece = 0;
    let started = false;
    // FE-085 criterion 4: in a multi-column run a table does not span pages (03 §10). When the rest
    // of this page cannot hold the whole table, and a page can, the table starts on a new page.
    // A table taller than a page still spans pages (reported through `overflowed`, as before).
    if (cur.geo.cols > 1 && !held() && !pageEmpty()) {
      const total = rows.reduce((sum, r) => sum + r.height, 0);
      let left = 0;
      for (let c = cur.column; c < cur.geo.cols; c++)
        left += Math.max(0, colH() - (cur.colUsed[c] ?? 0));
      if (total > left + EPS && total <= cur.geo.body + EPS) turnPage();
    }
    const onPiece = (): boolean =>
      piece !== null && piece.page === cur && piece.column === cur.column;

    const placeRow = (row: TableRowItem, repeated: boolean): void => {
      const top = cur.geo.top + used();
      const x = colX(cur.column) + item.x;
      const cells: LayoutCell[] = row.cells.map((c) => ({
        cellId: c.cellId,
        ...rangeOf(c),
        x: x + c.x,
        width: c.width,
        fragments: cellFragments(c, x + c.x, top),
      }));
      const laid: LayoutRow = {
        rowId: row.rowId,
        ...rangeOf(row),
        repeated,
        y: top,
        height: row.height,
        cells,
      };
      if (!onPiece()) piece = { page: cur, column: cur.column, index: -1, rows: [] };
      const open = piece!;
      open.rows.push(laid);
      const first = open.rows[0]!;
      const last = open.rows[open.rows.length - 1]!;
      const fragment: TableFragment = {
        kind: 'table',
        blockId: item.blockId,
        ...(first.from !== undefined ? { from: first.from } : {}),
        ...(last.to !== undefined ? { to: last.to } : {}),
        x,
        y: first.y,
        width: item.width,
        height: last.y + last.height - first.y,
        rows: [...open.rows],
      };
      if (open.index < 0) {
        addFragment(fragment);
        open.index = cur.fragments.length - 1;
      } else {
        cur.fragments[open.index] = fragment;
        cur.bottom = Math.max(cur.bottom, fragment.y - cur.geo.top + fragment.height);
      }
      addUsed(row.height);
    };

    maybeBalance(() => runRest(index));
    let k = 0;
    // The tail of a row cut at a paragraph boundary (FE-083): it goes on the next piece, first.
    let tail: TableRowItem | null = null;
    while (k < rows.length) {
      const row: TableRowItem = tail ?? rows[k]!;
      const repeat = started && k >= headCount && !onPiece();
      const headH = repeat ? headHeight : 0;
      const need = headH + row.height;
      if (need > room() + EPS) {
        const split = splitRowAt(row, room() - headH) ?? splitRowAtLine(row, room() - headH);
        if (split) {
          if (repeat) for (let h = 0; h < headCount; h++) placeRow(rows[h]!, true);
          placeRow(split.head, false);
          bodyRowsOnPiece++;
          started = true;
          tail = split.tail;
          continue;
        }
      }
      const fresh = colEmpty() || (onPiece() && bodyRowsOnPiece === 0);
      const canTurn = cur.column + 1 < cur.geo.cols || !holding;
      if (need <= room() + EPS || fresh || !canTurn) {
        if (repeat) for (let h = 0; h < headCount; h++) placeRow(rows[h]!, true);
        if (need > cur.geo.body + EPS && !overflowed.includes(item.blockId))
          overflowed.push(item.blockId);
        placeRow(row, false);
        bodyRowsOnPiece++;
        started = true;
        tail = null;
        k++;
        continue;
      }
      breakColumn();
      if (!onPiece()) bodyRowsOnPiece = 0;
    }
  };

  startRun(-1, columnCount(first));
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind !== 'sectionBreak') maybeBalance(() => runRest(i));
    switch (item.kind) {
      case 'pageBreak':
        if (!pageEmpty()) turnPage();
        break;
      case 'columnBreak':
        if (!colEmpty()) breakColumn();
        break;
      case 'sectionBreak': {
        run = null;
        checkBalance = false;
        section++;
        sectionSetup = item.page;
        sectionPages = 0;
        const start = item.page.pageNumberStart ?? null;
        if (item.start === 'continuous') {
          // The current page keeps its setup; numbering restarts on the next page.
          continuousColumns(item.page);
          pendingStart = start;
        } else {
          if (!pageEmpty()) {
            pendingStart = start;
            turnPage();
          } else {
            restartEmptyPage(start);
          }
          if (item.start !== 'nextPage') {
            const wantEven = item.start === 'evenPage';
            // Blank pages until the displayed number has the required parity.
            while ((cur.number % 2 === 0) !== wantEven) turnPage();
          }
        }
        startRun(i, columnCount(item.page));
        break;
      }
      case 'paragraph': {
        const line = item.fragment.lines[0];
        const pin = line ? pinOf(item.fragment.blockId, line.from) : undefined;
        if (pin) startPin(pin);
        honourChain(items, i);
        placeParagraph(item, i);
        break;
      }
      case 'box': {
        const pin = pinOf(item.blockId, 0);
        if (pin) startPin(pin);
        honourChain(items, i);
        placeBox(item, i);
        break;
      }
      case 'table':
        placeTable(item, i);
        break;
    }
  }
  if (!pageEmpty() || pages.length === 0) finish();
  return {
    pages,
    frames,
    overflowed,
    usedStories: stats.usedStories,
    pinPages,
    pageOverflow,
  };
}

/** Index of the next section break after i, or the item count when there is none. */
function nextSectionBreak(items: readonly PageItem[], i: number): number {
  for (let k = i + 1; k < items.length; k++) if (items[k]!.kind === 'sectionBreak') return k;
  return items.length;
}

/**
 * The lowest column bottom (below the body top) at which the rest of a run of columns holds on the
 * page `page` (FE-085), found by bisection. The trial passes use the page's insets, columns and run
 * top, so they place the rest exactly as the main pass will. Null when the rest does not hold on the
 * page at the body height: it then fills its columns, and the next page tries again.
 */
function balanceCap(
  rest: readonly PageItem[],
  page: Pick<OpenPage, 'setup' | 'geo' | 'runTop'>,
): number | null {
  const { geo, runTop } = page;
  const setup: PageSetup = {
    width: page.setup.width,
    height: page.setup.height,
    margins: page.setup.margins,
    columns: geo.cols,
    columnGap: geo.gap,
  };
  const fits = (cap: number): boolean => {
    try {
      layoutPass(rest, setup, {
        count: 0,
        fixed: { top: geo.top, bottom: geo.bottom },
        capAll: cap,
        startAt: runTop,
        onePage: true,
        balance: false,
      });
      return true;
    } catch (error) {
      if (error === ONE_PAGE_EXCEEDED) return false;
      throw error;
    }
  };
  if (!fits(geo.body)) return null;
  let lo = runTop;
  let hi = geo.body;
  for (let step = 0; step < 64 && hi - lo > BALANCE_TOLERANCE; step++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The lines of a paragraph from line `from` on, as the piece that continues it on a new page. */
function continuation(item: ParagraphItem, from: number): ParagraphItem {
  const lines = item.fragment.lines.slice(from);
  const base = lines[0]?.y ?? 0;
  return {
    ...item,
    spaceBefore: 0,
    keepLines: false,
    pageBreakBefore: false,
    fragment: {
      ...item.fragment,
      from: lines[0]?.from ?? item.fragment.to,
      height: lines.reduce((sum, l) => sum + l.height, 0),
      lines: lines.map((l) => ({ ...l, y: l.y - base })),
    },
  };
}

const fullHeight = (item: ParagraphItem | BoxItem): number =>
  item.kind === 'box' ? item.height : item.spaceBefore + item.fragment.height + item.spaceAfter;

const firstPart = (item: ParagraphItem | BoxItem): number => {
  if (item.kind === 'box') return item.height;
  return item.spaceBefore + (item.fragment.lines[0]?.height ?? 0);
};
