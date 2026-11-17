/**
 * Table borders and shading in the web view (FE-131 criterion 1; 03 §4.1, §4.3, §4.5).
 *
 * A table takes its borders from its table style and a direct `borders` on the table replaces them
 * (`resolveTableFormat`, the model's cascade). A cell's own `borders` then replace a side, and a
 * cell's own `shading` replaces the header row shading of the style. Nothing is written into the
 * document: the values are computed from it and drawn.
 *
 * - `tableCellStyles` is the pure part: the CSS values of each cell of each table of the body.
 * - `tableStylePlugin` carries those values to the cells as node decorations (in the decoration's
 *   `spec`, never as a `style` attribute, which is an inline style under a content security policy).
 * - `tableCellView` is the cell's node view: it applies the values through the CSSOM, after each
 *   value has been built from a checked colour, a known border style and a bounded width (I11).
 *
 * Readings taken here and recorded as proposed in ADR 0365: a border `width` is in eighths of a
 * point, a border without a width is half a point, `thick` draws as a solid line, a border without
 * a colour takes the text colour, and `bandedRows` draws nothing because the CDM names no colour
 * for the bands.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type NodeView,
  type NodeViewConstructor,
} from 'prosemirror-view';
import { resolveTableFormat, styleTable } from '@docedit/model';
import { cellEntries } from '../table-span.ts';
import { colourValue } from '../view-support.ts';

/** The attributes of a node as the model's cascade reads them. */
type Attrs = Readonly<Record<string, unknown>>;

export const tableStyleKey = new PluginKey<DecorationSet>('docedit-table-style');

/** The CSS values of one cell; a side or the fill is absent when nothing sets it. */
export interface CellCss {
  readonly backgroundColor?: string;
  readonly borderTop?: string;
  readonly borderBottom?: string;
  readonly borderLeft?: string;
  readonly borderRight?: string;
}

export interface CellStyle {
  /** The position before the cell, and its size. */
  readonly pos: number;
  readonly size: number;
  readonly css: CellCss;
}

const LINE: Readonly<Record<string, string>> = {
  single: 'solid',
  thick: 'solid',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
};

/** A border without a width: half a point, in eighths of a point (ADR 0365, proposed). */
const DEFAULT_WIDTH = 4;
const MAX_WIDTH = 240;

/**
 * The CSS `border` shorthand of one side, or undefined when the side is not set or does not match
 * the grammar. `none` is a value: it removes a border the stylesheet or the style would draw.
 */
export function borderCss(side: unknown): string | undefined {
  if (side === null || typeof side !== 'object') return undefined;
  const { style, width, color } = side as Record<string, unknown>;
  if (style === 'none') return 'none';
  const line = typeof style === 'string' ? LINE[style] : undefined;
  if (line === undefined) return undefined;
  const w = width === undefined || width === null ? DEFAULT_WIDTH : width;
  if (!Number.isInteger(w) || (w as number) < 0 || (w as number) > MAX_WIDTH) return undefined;
  if (color !== undefined && color !== null && colourValue(color) === undefined) return undefined;
  return `${(w as number) / 8}pt ${line} ${colourValue(color) ?? 'currentcolor'}`;
}

function fillCss(shading: unknown): string | undefined {
  if (shading === null || typeof shading !== 'object') return undefined;
  return colourValue((shading as Record<string, unknown>)['fill']);
}

function side(borders: Attrs | null | undefined, name: string): unknown {
  return borders ? borders[name] : undefined;
}

function tableCells(table: PMNode, tablePos: number, styles: ReturnType<typeof styleTable>) {
  const out: CellStyle[] = [];
  const found = resolveTableFormat(styles, table.attrs);
  // A broken style chain draws nothing from the style; the validator reports it (I4, I5).
  const format = found.ok ? found.value : null;
  const direct = table.attrs['borders'] as Attrs | null | undefined;
  const borders = format ? format.borders : (direct ?? null);
  const headerFill = fillCss(format?.headerRowShading);
  const grid: unknown = table.attrs['grid'];
  const columns = Array.isArray(grid) ? grid.length : 0;
  const entries = cellEntries(table, tablePos, columns);
  if (!entries) return out;
  const rows = table.childCount;
  const headerRows = typeof table.attrs['headerRows'] === 'number' ? table.attrs['headerRows'] : 0;
  for (const e of entries) {
    const own = e.cell.attrs['borders'] as Attrs | null | undefined;
    const edge = (name: string, outer: boolean, inside: string): string | undefined =>
      borderCss(side(own, name)) ?? borderCss(side(borders, outer ? name : inside));
    const css: {
      -readonly [K in keyof CellCss]: CellCss[K];
    } = {};
    const fill = fillCss(e.cell.attrs['shading']) ?? (e.row < headerRows ? headerFill : undefined);
    if (fill !== undefined) css.backgroundColor = fill;
    const top = edge('top', e.row === 0, 'insideH');
    if (top !== undefined) css.borderTop = top;
    const bottom = edge('bottom', e.row + e.rowspan === rows, 'insideH');
    if (bottom !== undefined) css.borderBottom = bottom;
    const left = edge('left', e.col === 0, 'insideV');
    if (left !== undefined) css.borderLeft = left;
    const right = edge('right', e.col + e.colspan === columns, 'insideV');
    if (right !== undefined) css.borderRight = right;
    if (Object.keys(css).length > 0) out.push({ pos: e.pos, size: e.cell.nodeSize, css });
  }
  return out;
}

/**
 * The CSS values of every cell of every table in the document that has any, in document order. A
 * table whose rows do not cover its grid is skipped (the validator reports it).
 */
export function tableCellStyles(doc: PMNode): CellStyle[] {
  const styles = styleTable(doc);
  const out: CellStyle[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'defs' || node.isTextblock) return false;
    if (node.type.name === 'table') out.push(...tableCells(node, pos, styles));
    return true;
  });
  return out;
}

function decorationsOf(doc: PMNode): DecorationSet {
  return DecorationSet.create(
    doc,
    tableCellStyles(doc).map((c) =>
      // A string, so that an unchanged cell is an equal decoration and is not drawn again.
      Decoration.node(c.pos, c.pos + c.size, {}, { tableCellCss: JSON.stringify(c.css) }),
    ),
  );
}

/** The table style values as node decorations on the cells; recomputed when the document changes. */
export function tableStylePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: tableStyleKey,
    state: {
      init: (_config, state) => decorationsOf(state.doc),
      apply: (tr, value) => (tr.docChanged ? decorationsOf(tr.doc) : value),
    },
    props: {
      decorations(state) {
        return tableStyleKey.getState(state) ?? null;
      },
    },
  });
}

const PROPS = [
  ['backgroundColor', 'background-color'],
  ['borderTop', 'border-top'],
  ['borderBottom', 'border-bottom'],
  ['borderLeft', 'border-left'],
  ['borderRight', 'border-right'],
] as const;

function cssOf(decorations: readonly Decoration[]): CellCss {
  for (const d of decorations) {
    const css = (d.spec as { tableCellCss?: string } | undefined)?.tableCellCss;
    if (css !== undefined) return JSON.parse(css) as CellCss;
  }
  return {};
}

/**
 * The node view of a table cell: the same `td` the schema writes, with the table style values of
 * its decoration applied through the CSSOM. A value that is no longer set is removed.
 */
export const tableCellView: NodeViewConstructor = (node, _view, _getPos, decorations): NodeView => {
  const dom = document.createElement('td');
  const span = (cell: PMNode): void => {
    dom.setAttribute('colspan', String(cell.attrs['colspan']));
    dom.setAttribute('rowspan', String(cell.attrs['rowspan']));
  };
  const paint = (decos: readonly Decoration[]): void => {
    const css = cssOf(decos);
    for (const [key, property] of PROPS) {
      const value = css[key];
      if (value === undefined) dom.style.removeProperty(property);
      else dom.style.setProperty(property, value);
    }
  };
  span(node);
  paint(decorations);
  const type = node.type;
  return {
    dom,
    contentDOM: dom,
    update(next, decos) {
      if (next.type !== type) return false;
      span(next);
      paint(decos);
      return true;
    },
  };
};
