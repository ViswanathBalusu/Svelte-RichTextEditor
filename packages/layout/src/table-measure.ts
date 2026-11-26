/**
 * The height of table rows and of the blocks in their cells, from the editor's own page layout
 * (EXP-039; owner decision 114: no first compile pass). The editor and the export converter both
 * need to know whether a row is taller than a page body before LaTeX sees it, because a `longtable`
 * row cannot break across pages. This function lays the document out with the given providers and
 * reads the heights from the tree, so the editor (canvas measurer) and a worker (any injected
 * measurer) get one answer from one implementation.
 *
 * What is measured, all in points:
 *
 * - `body`: the page body height of the page the table starts on (page height less its top and
 *   bottom margins; a header or footer that grows into the body is not counted);
 * - a row's `height`: the sum of the heights of its pieces, repeated header rows left out. The
 *   layout cuts a row that does not fit, so the pieces of a tall row add up to the row's height;
 * - a block's `height`: the sum of the heights of the paragraph fragments it has in the cell.
 *   Spacing before and after a paragraph and the cell margins are not in it; they are in the
 *   row's `overhead`, the row's height less its tallest cell's blocks.
 *
 * A table that the layout does not place (it holds a footnote reference, see `tableItem`) has no
 * entry. A block that is not a paragraph (a picture, a nested table) has no block height.
 *
 * The result is plain data, so that it can cross a worker boundary and be passed to the converter
 * and to the preflight, which take the same shape (`@docedit/export-latex`, `table-measure.ts`).
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike } from './flow.ts';
import type { ItemProviders } from './items.ts';
import type { PaginatedPage } from './page-items.ts';
import type { LayoutFragment, TableFragment } from './tree.ts';

export interface BlockHeight {
  readonly blockId: string;
  readonly height: number;
}

export interface CellHeights {
  readonly cellId: string;
  /** The paragraphs of the cell that the layout placed, in order, with their heights. */
  readonly blocks: readonly BlockHeight[];
}

export interface RowHeight {
  readonly rowId: string;
  readonly height: number;
  /** The row's height less its tallest cell's blocks: margins and spacing. Never negative. */
  readonly overhead: number;
  readonly cells: readonly CellHeights[];
}

export interface TableHeights {
  readonly tableId: string;
  /** The page body height where the table starts. */
  readonly body: number;
  readonly rows: readonly RowHeight[];
}

export interface TableMeasure {
  /** The layout engine and the measurer that gave the heights. */
  readonly engine: string;
  readonly measurer: string;
  readonly tables: readonly TableHeights[];
}

const isTable = (f: LayoutFragment): f is TableFragment => f.kind === 'table';

export function measureTables(envelope: CdmEnvelopeLike, providers: ItemProviders): TableMeasure {
  const { tree } = layoutFlow(toFlow(envelope), providers);
  const tables = new Map<
    string,
    { body: number; rows: Map<string, { height: number; cells: Map<string, Map<string, number>> }> }
  >();
  for (const page of tree.pages) {
    const m = (page as Partial<PaginatedPage>).margins;
    const body = Math.max(0, page.height - (m?.top ?? 0) - (m?.bottom ?? 0));
    for (const f of page.fragments.filter(isTable)) {
      let t = tables.get(f.blockId);
      if (!t) tables.set(f.blockId, (t = { body, rows: new Map() }));
      for (const row of f.rows) {
        if (row.repeated) continue;
        let r = t.rows.get(row.rowId);
        if (!r) t.rows.set(row.rowId, (r = { height: 0, cells: new Map() }));
        r.height += row.height;
        for (const cell of row.cells) {
          let c = r.cells.get(cell.cellId);
          if (!c) r.cells.set(cell.cellId, (c = new Map()));
          for (const frag of cell.fragments)
            if (frag.kind === 'paragraph')
              c.set(frag.blockId, (c.get(frag.blockId) ?? 0) + frag.height);
        }
      }
    }
  }
  return {
    engine: tree.engine,
    measurer: tree.measurer,
    tables: [...tables].map(([tableId, t]) => ({
      tableId,
      body: t.body,
      rows: [...t.rows].map(([rowId, r]) => {
        const cells = [...r.cells].map(([cellId, blocks]) => ({
          cellId,
          blocks: [...blocks].map(([blockId, height]) => ({ blockId, height })),
        }));
        const tallest = Math.max(
          0,
          ...cells.map((c) => c.blocks.reduce((sum, b) => sum + b.height, 0)),
        );
        return { rowId, height: r.height, overhead: Math.max(0, r.height - tallest), cells };
      }),
    })),
  };
}
