/**
 * The layout tree (02 §9.2; FE-078): pages contain fragments, fragments contain lines or table
 * rows, and every node records the block identifier and the CDM offsets it covers. Coordinates are
 * in points from the page's top-left corner. Each adapter in this spike turns its engine's result
 * into this one shape, so that the candidates can be compared and so that a painter, hit testing
 * and reconciliation (02 §9.6, §9.7) depend on the project's tree and not on an engine's.
 */
import { flowParagraphs, type FlowDocument } from './flow.ts';

export interface LayoutLine {
  /** CDM offset of the line's first position inside the block. */
  readonly from: number;
  /** CDM offset just past the line's last position. */
  readonly to: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * The text the line shows, when it is not the CDM text of `[from, to)`: a line of a paragraph
   * with a `page` or `pageCount` field, whose value the layout computed (FE-087). Absent otherwise.
   */
  readonly text?: string;
}

export interface ParagraphFragment {
  readonly kind: 'paragraph';
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lines: readonly LayoutLine[];
}

/**
 * The CDM range a node of a table or box covers, as offsets inside its top-level block (the table or
 * the box): the same coordinates as the `from` and `to` of a paragraph fragment inside its own
 * block. `layoutFlow` sets them on every node it makes (FE-078 criterion 2); a tree built by hand
 * may leave them out.
 */
export interface LayoutCell {
  readonly cellId: string;
  readonly from?: number;
  readonly to?: number;
  readonly x: number;
  readonly width: number;
  readonly fragments: readonly LayoutFragment[];
}

export interface LayoutRow {
  readonly rowId: string;
  readonly from?: number;
  readonly to?: number;
  /** A header row repeated at the top of a continuation page. */
  readonly repeated: boolean;
  readonly y: number;
  readonly height: number;
  readonly cells: readonly LayoutCell[];
}

export interface TableFragment {
  readonly kind: 'table';
  readonly blockId: string;
  /** From the first row's range to the last row's: the rows this fragment holds. */
  readonly from?: number;
  readonly to?: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly LayoutRow[];
}

export interface BoxFragment {
  readonly kind: 'box';
  readonly blockId: string;
  readonly from?: number;
  readonly to?: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type LayoutFragment = ParagraphFragment | TableFragment | BoxFragment;

/** A place in the document: a block and an offset inside it. */
export interface LayoutPosition {
  readonly blockId: string;
  readonly offset: number;
}

export interface LayoutPage {
  readonly index: number;
  /**
   * What the page's body covers: where its first fragment starts and where its last one ends, or
   * null for a page with no body fragment (FE-078 criterion 2). Headers, footers and footnotes are
   * not part of it.
   */
  readonly start?: LayoutPosition | null;
  readonly end?: LayoutPosition | null;
  /** Index of the flow section the page belongs to. */
  readonly section: number;
  readonly width: number;
  readonly height: number;
  readonly fragments: readonly LayoutFragment[];
  readonly header: readonly LayoutFragment[];
  readonly footer: readonly LayoutFragment[];
  readonly footnotes: readonly LayoutFragment[];
}

export interface LayoutTree {
  /** Engine and version, for example `@docen/layout@0.7.0`. */
  readonly engine: string;
  readonly measurer: string;
  readonly pages: readonly LayoutPage[];
}

/** The body range of a page's fragments, as `LayoutPage.start` and `end` record it. */
export function pageRange(fragments: readonly LayoutFragment[]): {
  readonly start: LayoutPosition | null;
  readonly end: LayoutPosition | null;
} {
  const first = fragments[0];
  const last = fragments[fragments.length - 1];
  if (!first || !last) return { start: null, end: null };
  return {
    start: { blockId: first.blockId, offset: first.from ?? 0 },
    end: { blockId: last.blockId, offset: last.to ?? 0 },
  };
}

/** Freezes a tree in place, recursively (FE-078: the tree is immutable). */
export function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freezeTree(v);
  }
  return value;
}

/** Every paragraph fragment of a page list, tables and stories included. */
export function* paragraphFragments(
  fragments: readonly LayoutFragment[],
): Generator<ParagraphFragment> {
  for (const f of fragments) {
    if (f.kind === 'paragraph') yield f;
    else if (f.kind === 'table')
      for (const row of f.rows)
        for (const cell of row.cells) yield* paragraphFragments(cell.fragments);
  }
}

export interface TreeSummary {
  readonly engine: string;
  readonly measurer: string;
  readonly pages: number;
  readonly bodyLines: number;
  readonly linesPerPage: readonly number[];
  /** Body blocks whose fragments sit on more than one page. */
  readonly splitBlocks: number;
  readonly footnoteLines: number;
  readonly headerFooterLines: number;
}

export function summarise(tree: LayoutTree): TreeSummary {
  const pagesOfBlock = new Map<string, Set<number>>();
  const linesPerPage: number[] = [];
  let footnoteLines = 0;
  let headerFooterLines = 0;
  for (const page of tree.pages) {
    let lines = 0;
    for (const f of paragraphFragments(page.fragments)) {
      lines += f.lines.length;
      const set = pagesOfBlock.get(f.blockId) ?? new Set<number>();
      set.add(page.index);
      pagesOfBlock.set(f.blockId, set);
    }
    for (const f of page.fragments)
      if (f.kind !== 'paragraph') {
        const set = pagesOfBlock.get(f.blockId) ?? new Set<number>();
        set.add(page.index);
        pagesOfBlock.set(f.blockId, set);
      }
    linesPerPage.push(lines);
    for (const f of paragraphFragments(page.footnotes)) footnoteLines += f.lines.length;
    for (const f of paragraphFragments([...page.header, ...page.footer]))
      headerFooterLines += f.lines.length;
  }
  return {
    engine: tree.engine,
    measurer: tree.measurer,
    pages: tree.pages.length,
    bodyLines: linesPerPage.reduce((a, b) => a + b, 0),
    linesPerPage,
    splitBlocks: [...pagesOfBlock.values()].filter((s) => s.size > 1).length,
    footnoteLines,
    headerFooterLines,
  };
}

/**
 * A stable serialisation of a tree's pages (FE-078: stored for regression tests), with lengths
 * rounded to a thousandth of a point, and a short FNV-1a digest of it for comparing environments.
 */
export function serialiseTree(tree: LayoutTree): string {
  return JSON.stringify(tree.pages, (_key, value: unknown) =>
    typeof value === 'number' ? Math.round(value * 1000) / 1000 : value,
  );
}

export function treeDigest(tree: LayoutTree): string {
  return digestText(serialiseTree(tree));
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex digits: a short label, not a security hash. */
export function digestText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface CoverageProblem {
  readonly blockId: string;
  readonly problem: string;
}

/**
 * Checks that the lines laid out for every body paragraph cover its CDM range without gap or
 * overlap, in order, across pages (FE-078). Paragraphs inside tables are checked as well, except
 * repeated header rows, which are copies.
 */
export function checkCoverage(flow: FlowDocument, tree: LayoutTree): CoverageProblem[] {
  const expected = new Map<string, { start: number; end: number }>();
  const generated = new Set<string>();
  for (const section of flow.sections)
    for (const p of flowParagraphs(section.blocks)) {
      if (p.generated) {
        generated.add(p.id);
        continue;
      }
      const e = expected.get(p.id);
      expected.set(p.id, {
        start: Math.min(e?.start ?? p.start, p.start),
        end: Math.max(e?.end ?? p.end, p.end),
      });
    }
  const seen = new Map<string, LayoutLine[]>();
  const collect = (fragments: readonly LayoutFragment[]): void => {
    for (const f of fragments) {
      if (f.kind === 'paragraph') seen.set(f.blockId, [...(seen.get(f.blockId) ?? []), ...f.lines]);
      else if (f.kind === 'table')
        for (const row of f.rows)
          if (!row.repeated) for (const cell of row.cells) collect(cell.fragments);
    }
  };
  for (const page of tree.pages) collect(page.fragments);
  const problems: CoverageProblem[] = [];
  for (const [blockId, range] of expected) {
    const lines = seen.get(blockId);
    if (!lines || lines.length === 0) {
      problems.push({ blockId, problem: 'no lines laid out' });
      continue;
    }
    let at = range.start;
    for (const line of lines) {
      if (line.from !== at)
        problems.push({ blockId, problem: `line starts at ${line.from}, expected ${at}` });
      if (line.to < line.from)
        problems.push({
          blockId,
          problem: `line ends before it starts (${line.from} to ${line.to})`,
        });
      at = line.to;
    }
    if (at !== range.end)
      problems.push({ blockId, problem: `lines end at ${at}, block ends at ${range.end}` });
  }
  for (const blockId of seen.keys())
    if (!expected.has(blockId) && !generated.has(blockId))
      problems.push({ blockId, problem: 'laid out but not in the flow' });
  return problems;
}
