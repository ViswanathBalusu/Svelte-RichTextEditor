// Table borders and default cell margins in the formatting cascade (CDM-028 criterion 5; CDM-041;
// 03 §6). A table takes these from its table style, and a direct value on the table overrides it.
// Like the paragraph `borders`, each is a whole value: the last layer that sets one gives all of
// it, so a direct `borders` replaces the style's `borders` and does not merge with it.
//
// Pure: nothing is written into the document (03 §1 principle 5).
import type { CascadeResult } from './resolve.ts';
import { type Attrs, type StyleTable, styleChain } from './styles.ts';

/** Where a table's value came from: its table style (down the chain), the table itself, or none. */
export type TableFormatLayer = 'table style' | 'direct' | 'none';

export interface TableFormat {
  /** The table's borders, or null when neither the table nor its style sets them. */
  readonly borders: Attrs | null;
  /** The table's default cell margins, or null when neither sets them. */
  readonly cellMargins: Attrs | null;
  /**
   * The header row shading of the table style (FE-131 criterion 1). A table has no shading of its
   * own in the CDM, so only the style sets it; null when the style does not.
   */
  readonly headerRowShading: Attrs | null;
  readonly trace: {
    readonly borders: TableFormatLayer;
    readonly cellMargins: TableFormatLayer;
  };
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * The borders and cell margins a table has. The table style's `basedOn` chain is applied from its
 * root to the style itself, so a more specific table style wins; a direct value on the table wins
 * over all of them. A table without a style takes only its direct values.
 *
 * A missing table style, a cycle or a chain longer than ten styles is returned as the cascade's
 * typed error; invariants I4 and I5 report the same breaks when the document is validated.
 */
export function resolveTableFormat(
  table: StyleTable,
  tableAttrs: Attrs | undefined,
): CascadeResult<TableFormat> {
  const styleId = tableAttrs?.['style'];
  let styleChainIds: readonly string[] = [];
  if (typeof styleId === 'string') {
    const found = styleChain(table, styleId);
    if (!found.ok) return found;
    styleChainIds = found.chain;
  }

  let borders: Attrs | null = null;
  let cellMargins: Attrs | null = null;
  let headerRowShading: Attrs | null = null;
  let bordersLayer: TableFormatLayer = 'none';
  let marginsLayer: TableFormatLayer = 'none';

  for (const id of styleChainIds) {
    const style = table.styles.get(id);
    if (!style) continue;
    const b = style['borders'];
    if (isSet(b)) {
      borders = b as Attrs;
      bordersLayer = 'table style';
    }
    const m = style['cellMargins'];
    if (isSet(m)) {
      cellMargins = m as Attrs;
      marginsLayer = 'table style';
    }
    const h = style['headerRowShading'];
    if (isSet(h)) {
      headerRowShading = h as Attrs;
    }
  }

  const directBorders = tableAttrs?.['borders'];
  if (isSet(directBorders)) {
    borders = directBorders as Attrs;
    bordersLayer = 'direct';
  }
  const directMargins = tableAttrs?.['cellMargins'];
  if (isSet(directMargins)) {
    cellMargins = directMargins as Attrs;
    marginsLayer = 'direct';
  }

  return {
    ok: true,
    value: {
      borders,
      cellMargins,
      headerRowShading,
      trace: { borders: bordersLayer, cellMargins: marginsLayer },
    },
  };
}
