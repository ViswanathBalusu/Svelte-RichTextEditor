/**
 * Tables (09 §3.2; EXP-038 to EXP-041). Two writers:
 * - in the single-column body flow, `longtable` with `colortbl`: column widths from `grid`, header
 *   rows repeated on every page, borders as rules, shading as cell colours;
 * - in a multi-column section, a header, a footer or a footnote, a boxed `tabular`, which cannot
 *   span pages (reported).
 * Row spans use the class's own cell macro (`\DErowspan`), never `multirow`: the content hangs
 * from its first row over the rows it spans, and the rules between those rows skip its columns.
 */
import { styleProperty } from '@docedit/model';
import {
  attr,
  colourOf,
  diag,
  idOf,
  num,
  register,
  str,
  warnOnce,
  within,
  line,
  type Ctx,
  type J,
} from './context.ts';
import { dimen, EMPTY, int, join, lit, tex, type Tex } from './emit.ts';
import { gap, newFlow, type ContentWriter, type Flow } from './flow.ts';
import { suggestionHides } from './suggestions.ts';

const t = lit;

interface Border {
  style?: string;
  width?: number;
  color?: string | null;
}

type Borders = Partial<
  Record<'top' | 'bottom' | 'left' | 'right' | 'insideH' | 'insideV', Border | null>
>;

const on = (b: Border | null | undefined): boolean => !!b && !!b.style && b.style !== 'none';
const double = (b: Border | null | undefined): boolean => on(b) && b!.style === 'double';
const widthOf = (b: Border): number => b.width ?? 8;
const colourKey = (b: Border): string => (typeof b.color === 'string' ? b.color.toUpperCase() : '');

/** Two borders draw the same rule (both off, or the same style class, width and colour). */
function same(a: Border | null | undefined, b: Border | null | undefined): boolean {
  if (!on(a) || !on(b)) return on(a) === on(b);
  return double(a) === double(b) && widthOf(a!) === widthOf(b!) && colourKey(a!) === colourKey(b!);
}

type Side = 'top' | 'bottom' | 'left' | 'right';

/**
 * A side of a cell's own `borders` (03 §4.3), or undefined when the cell does not set it, so the
 * table's border applies. A side with style `none` is set: it asks for no rule.
 */
function cellSide(cell: J | null, side: Side): Border | undefined {
  const b = attr(cell ?? undefined, 'borders') as
    Partial<Record<Side, Border | null>> | null | undefined;
  return b?.[side] ?? undefined;
}

/**
 * Two borders on one edge, the earlier cell's first (left of or above the edge). This follows
 * Word's rule for cells without spacing in a simplified form (ADR 0143, question 18): a border
 * that is drawn wins over one that is not, of two drawn borders the wider wins, and on a tie the
 * earlier cell's.
 */
function conflict(a: Border | null, b: Border | null): Border | null {
  if (!on(a)) return on(b) ? b : null;
  if (!on(b)) return a;
  return widthOf(b!) > widthOf(a!) ? b : a;
}

interface Placed {
  cell: J | null;
  col: number;
  span: number;
  rowspan: number;
  /** A position covered by a row span from above. */
  covered: boolean;
  /** The cell whose borders apply here: the cell itself, or the cell of the row span that covers it. */
  origin: J | null;
}

/** Cells of every row with their columns, covered positions included (03 §4.3, I6). */
function layoutRows(rows: readonly J[], columns: number): Placed[][] {
  const carry: number[] = new Array<number>(columns).fill(0);
  const carrySpan: number[] = new Array<number>(columns).fill(1);
  const carryCell: (J | null)[] = new Array<J | null>(columns).fill(null);
  return rows.map((row) => {
    const out: Placed[] = [];
    const cells = row.content ?? [];
    let col = 0;
    let k = 0;
    while (col < columns) {
      if (carry[col]! > 0) {
        const span = carrySpan[col]!;
        out.push({
          cell: null,
          col,
          span,
          rowspan: 1,
          covered: true,
          origin: carryCell[col] ?? null,
        });
        for (let c = col; c < Math.min(columns, col + span); c++) carry[c]! -= 1;
        col += span;
        continue;
      }
      const cell = cells[k++];
      if (!cell) break;
      const span = Math.max(1, Math.min(columns - col, num(attr(cell, 'colspan')) ?? 1));
      const rowspan = Math.max(1, num(attr(cell, 'rowspan')) ?? 1);
      out.push({ cell, col, span, rowspan, covered: false, origin: cell });
      if (rowspan > 1)
        for (let c = col; c < col + span; c++) {
          carry[c] = rowspan - 1;
          carrySpan[c] = c === col ? span : 1;
          carryCell[c] = cell;
        }
      col += span;
    }
    return out;
  });
}

function tableStyleValue(ctx: Ctx, style: string | null, name: string): unknown {
  return style ? styleProperty(ctx.table, style, name) : null;
}

export function table(ctx: Ctx, flow: Flow, node: J, content: ContentWriter): void {
  const id = idOf(node);
  const n = register(ctx, id, 'table', flow.owner);
  const a = node.attrs ?? {};
  const style = str(a['style']);
  const rows = (node.content ?? []).filter((r) => !suggestionHides(ctx, r.marks));
  const gridIn = Array.isArray(a['grid']) ? (a['grid'] as unknown[]).map((g) => num(g) ?? 0) : [];
  const columns = Math.max(
    1,
    gridIn.length,
    ...rows.map((r) => (r.content ?? []).reduce((s, c) => s + (num(attr(c, 'colspan')) ?? 1), 0)),
  );
  const grid =
    gridIn.length >= columns
      ? gridIn
      : Array.from({ length: columns }, (_, i) => gridIn[i] ?? 1440);
  const borders = ((a['borders'] ?? tableStyleValue(ctx, style, 'borders') ?? {}) as Borders) || {};
  const margins = (a['cellMargins'] ?? tableStyleValue(ctx, style, 'cellMargins') ?? {}) as Record<
    string,
    number
  >;
  const marginLR = num(margins['left']) ?? 108;
  const headerShade = colourOf(
    ctx,
    (tableStyleValue(ctx, style, 'headerRowShading') as { fill?: string } | null)?.fill,
    id,
  );
  if (tableStyleValue(ctx, style, 'bandedRows') === true)
    warnOnce(
      ctx,
      'banded_rows',
      'banded rows are not shaded: the table style gives no band colour',
      id,
    );
  const boxed = flow.place !== 'body' || ctx.state.columns > 1;
  if (boxed)
    diag(
      ctx,
      'warning',
      'table_cannot_span_pages',
      id,
      'a table in a multi-column section, a header, a footer or a footnote is set as a box and cannot span pages (09 §3.2)',
    );
  const headerRows = boxed ? 0 : Math.min(num(a['headerRows']) ?? 0, rows.length);
  const ruleWidth = Math.max(
    ...(['top', 'bottom', 'left', 'right', 'insideH', 'insideV'] as const).map((k) =>
      on(borders[k]) ? (borders[k]!.width ?? 8) : 0,
    ),
    0,
  );
  const ruleColour =
    colourOf(
      ctx,
      (['top', 'insideH', 'left', 'insideV', 'bottom', 'right'] as const)
        .map((k) => borders[k]?.color)
        .find((c) => typeof c === 'string'),
      id,
    ) ?? t('000000');
  const vsep = (b: Border | null | undefined): Tex =>
    on(b) ? (double(b) ? t('||') : t('|')) : EMPTY;
  const placed = layoutRows(rows, columns);

  // Cell borders (03 §4.3; EXP-038). A side the cell sets replaces the table's border on that
  // side; two cells that share an edge resolve it with `conflict`. An edge that comes out as the
  // table's own border is drawn as before (`|` and `\hline` in the table's rule width and colour);
  // any other edge is drawn with its own width and colour. Dotted, dashed and thick borders are
  // drawn as solid rules of their width, as table borders are.
  const ruleOf = (b: Border): { w: Tex; c: Tex } => ({
    w: dimen(widthOf(b), { min: 1, max: 240 }),
    c: colourOf(ctx, typeof b.color === 'string' ? b.color : null, id) ?? t('000000'),
  });
  /** A side of the cell at a position (its own, or the table's when it sets none). */
  const sideOf = (
    p: Placed | undefined,
    side: Side,
    table: Border | null | undefined,
  ): Border | null => {
    const own = p ? cellSide(p.origin, side) : undefined;
    return own !== undefined ? own : (table ?? null);
  };
  /** A vertical edge as a column separator: the table's own `|`, or a rule of its own. */
  const vedge = (edge: Border | null, table: Border | null | undefined): Tex => {
    if (same(edge, table)) return vsep(table);
    if (!on(edge)) return EMPTY;
    const { w, c } = ruleOf(edge!);
    return double(edge)
      ? tex`!{\DEvrule{${w}}{${c}}\hskip\doublerulesep\DEvrule{${w}}{${c}}}`
      : tex`!{\DEvrule{${w}}{${c}}}`;
  };
  /** The placement that holds column `c` of row `r`. */
  const at = (r: number, c: number): Placed | undefined =>
    placed[r]?.find((p) => c >= p.col && c < p.col + p.span);
  /**
   * The horizontal rule above row `b` (`b` is `rows.length` for the rule under the last row), as
   * one border per column (null inside a row span), next to the table's own border for each column.
   */
  const boundary = (b: number): { edge: (Border | null)[]; table: (Border | null)[] } => {
    const n = rows.length;
    const own = (b === 0 ? borders.top : b === n ? borders.bottom : borders.insideH) ?? null;
    const edge: (Border | null)[] = [];
    const table: (Border | null)[] = [];
    for (let c = 0; c < columns; c++) {
      const below = b < n ? at(b, c) : undefined;
      if (below?.covered) {
        edge.push(null);
        table.push(null);
        continue;
      }
      const up = b > 0 ? sideOf(at(b - 1, c), 'bottom', own) : null;
      const down = b < n ? sideOf(below, 'top', own) : null;
      edge.push(b === 0 ? down : b === n ? up : conflict(up, down));
      table.push(own);
    }
    return { edge, table };
  };
  const colWidth = (from: number, span: number): Tex => {
    const w = grid.slice(from, from + span).reduce((s, x) => s + x, 0);
    return dimen(Math.max(20, w - 2 * marginLR), { min: 20, max: 31680 });
  };
  // Every cell is a `p` column, which hangs from its first line. A centred or bottom-aligned cell
  // ends with `\DEva`, and the class moves it inside its row when the page is shipped out: `m` and
  // `b` columns do not do it, because they only align cells with each other, not with the row.
  const vaCode = (cell: J | null): Tex | null => {
    const v = str(attr(cell ?? undefined, 'vAlign'));
    return v === 'center' ? t('1') : v === 'bottom' ? t('2') : null;
  };
  const spec = join([
    vsep(borders.left),
    join(
      grid.map((_, i) => tex`p{${colWidth(i, 1)}}`),
      vsep(borders.insideV),
    ),
    vsep(borders.right),
  ]);
  const align = str(a['align']);
  const alignCode = align === 'center' ? t('1') : align === 'end' ? t('2') : t('0');

  /** The rule under row `r` (or above the first): full width, or the columns no span covers. */
  const ruleAfter = (r: number, b: Border | null | undefined): Tex => {
    if (!on(b)) return EMPTY;
    const next = placed[r + 1];
    const coveredCols = new Set<number>();
    for (const p of next ?? [])
      if (p.covered) for (let c = p.col; c < p.col + p.span; c++) coveredCols.add(c);
    const rule = double(b) ? t('\\hline\\hline') : t('\\hline');
    if (coveredCols.size === 0) return rule;
    const parts: Tex[] = [];
    let c = 0;
    while (c < columns) {
      if (coveredCols.has(c)) {
        c++;
        continue;
      }
      let e = c;
      while (e + 1 < columns && !coveredCols.has(e + 1)) e++;
      parts.push(tex`\cline{${int(c + 1)}-${int(e + 1)}}`);
      c = e + 1;
    }
    return join(parts);
  };

  /**
   * The rule above row `b` (or under the last row when `b` is `rows.length`). When every column
   * comes out as the table's own border, it is the table's rule as before. Otherwise each run of
   * columns with the same border is a `\DEcline` of that width and colour; a double border gets a
   * second line after `\DEclinegap`, and `\DEclineend` gives back the table's rule width and colour.
   */
  const hrule = (b: number): Tex => {
    const { edge, table: own } = boundary(b);
    if (edge.every((e, c) => same(e, own[c]))) {
      const tb =
        b === 0 ? borders.top : b === rows.length ? borders.bottom : (borders.insideH ?? null);
      if (b > 0) return ruleAfter(b - 1, tb);
      return on(tb) ? (double(tb) ? t('\\hline\\hline') : t('\\hline')) : EMPTY;
    }
    const lines: Tex[] = [];
    const doubles: Tex[] = [];
    let gap = 0;
    let c = 0;
    while (c < columns) {
      const e = edge[c] ?? null;
      if (!on(e)) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < columns && on(edge[end + 1]) && same(edge[end + 1], e)) end++;
      const { w, c: colour } = ruleOf(e!);
      const segment = tex`\DEcline{${int(c + 1)}-${int(end + 1)}}{${w}}{${colour}}`;
      lines.push(segment);
      if (double(e)) {
        doubles.push(segment);
        gap = Math.max(gap, widthOf(e!));
      }
      c = end + 1;
    }
    if (lines.length === 0) return EMPTY;
    if (doubles.length > 0)
      lines.push(tex`\DEclinegap{${dimen(gap, { min: 1, max: 240 })}}`, ...doubles);
    lines.push(t('\\DEclineend'));
    return join(lines);
  };

  const rowBlocks: Array<[number, number]> = [];
  const emitRow = (r: number, repeated: boolean): void => {
    const first = ctx.blocks.length;
    emitRowCells(r, repeated);
    if (!repeated) rowBlocks[r] = [first, ctx.blocks.length];
  };
  const emitRowCells = (r: number, repeated: boolean): void => {
    const row = rows[r]!;
    const rowId = idOf(row);
    void rowId;
    const cells = placed[r] ?? [];
    // \rowcolor paints the whole row, after the content of a span that hangs from a row above. So
    // a row that a shaded span covers colours its other cells one by one (EXP-041 criterion 3).
    const coveredShaded = cells.some(
      (p) =>
        p.covered &&
        p.origin !== null &&
        (attr(p.origin, 'shading') as { fill?: string } | null | undefined)?.fill !== undefined,
    );
    if (r < headerRows && headerShade && !coveredShaded)
      line(ctx, tex`\rowcolor[HTML]{${headerShade}}`);
    cells.forEach((p, i) => {
      if (i > 0) line(ctx, t('&%'));
      // The cell's left edge is written only in the first column; every other edge belongs to the
      // cell on its left, which resolves it with the next cell's left side.
      const lastCol = p.col + p.span >= columns;
      const tableRight = lastCol ? borders.right : borders.insideV;
      const leftEdge = sideOf(p, 'left', borders.left);
      const ownRight = sideOf(p, 'right', tableRight);
      const rightEdge = lastCol
        ? ownRight
        : conflict(ownRight, sideOf(cells[i + 1], 'left', borders.insideV));
      const left = p.col === 0 ? vedge(leftEdge, borders.left) : EMPTY;
      const right = vedge(rightEdge, tableRight);
      const ownEdges =
        (p.col === 0 && !same(leftEdge, borders.left)) || !same(rightEdge, tableRight);
      const needsMulti = p.span > 1 || (p.col === 0 && left !== EMPTY) || ownEdges;
      const cellSpec = tex`${left}p{${colWidth(p.col, p.span)}}${right}`;
      const open =
        p.span > 1
          ? tex`\DEcolspan{${int(p.span)}}{${cellSpec}}{%`
          : needsMulti
            ? tex`\multicolumn{${int(p.span)}}{${cellSpec}}{%`
            : EMPTY;
      if (open !== EMPTY) line(ctx, open);
      if (p.cell && !p.covered) {
        const ownShade = colourOf(
          ctx,
          (attr(p.cell, 'shading') as { fill?: string } | null | undefined)?.fill,
          idOf(p.cell),
        );
        const shade = ownShade ?? (coveredShaded && r < headerRows ? headerShade : null);
        if (shade) line(ctx, tex`\cellcolor[HTML]{${shade}}%`);
        const cm = (attr(p.cell, 'margins') ?? margins) as Record<string, number>;
        const top = num(cm['top']) ?? 0;
        const bottom = num(cm['bottom']) ?? 0;
        const inner = (): void => {
          if (top > 0) line(ctx, tex`\DEcellpad{${dimen(top, { min: 0, max: 31680 })}}%`);
          // Row heights (EXP-038): `atLeast` is a strut of that height, so the row is at least as
          // tall; `exact` is a box of that height, so the row is that tall while the content fits.
          // Content taller than an exact row is not clipped. A row span is not sized (its rows are
          // not measured), so both rules apply to single-row cells only.
          const rowHeight = num(attr(row, 'height'));
          const heightRule = str(attr(row, 'heightRule'));
          const minH = p.rowspan === 1 && heightRule === 'atLeast' ? rowHeight : null;
          const exactH = p.rowspan === 1 && heightRule === 'exact' ? rowHeight : null;
          if (minH !== null) line(ctx, tex`\rule{0pt}{${dimen(minH, { min: 0, max: 31680 })}}%`);
          if (exactH !== null) line(ctx, tex`\vbox to ${dimen(exactH, { min: 0, max: 31680 })}{%`);
          content(
            newFlow('cell', style, id),
            repeated ? (p.cell!.content ?? []).map(stripIds) : p.cell!.content,
          );
          if (exactH !== null) line(ctx, t('\\vss}%'));
          if (bottom > 0) line(ctx, tex`\DEcellpad{${dimen(bottom, { min: 0, max: 31680 })}}%`);
          // A cell that spans rows hangs over them in a box of no height, so it stays top-aligned.
          const va = p.rowspan === 1 ? vaCode(p.cell) : null;
          if (va !== null) line(ctx, tex`\DEva{${va}}%`);
        };
        if (p.rowspan > 1) {
          if (!repeated && (p.cell!.content ?? []).length > 0)
            diag(
              ctx,
              'warning',
              'span_taller_than_rows',
              idOf(p.cell!),
              `a cell spans ${p.rowspan} rows and holds content; heights are not measured, so the content may be taller than the rows it spans (09 §3.2)`,
            );
          // The shading of a span covers all its rows: \cellcolor colours the first row, the class
          // paints the covered rows under the content when the page is shipped out.
          if (shade) line(ctx, tex`\DErowfill{${int(p.rowspan)}}{${shade}}%`);
          line(ctx, tex`\DErowspan{${int(p.rowspan)}}{%`);
          inner();
          line(ctx, t('}%'));
        } else inner();
      }
      if (open !== EMPTY) line(ctx, t('}%'));
    });
    line(ctx, t('\\\\'));
    const rule = hrule(r + 1);
    if (rule !== EMPTY) line(ctx, rule);
  };

  within(ctx, n, () => {
    gap(ctx, flow, null);
    const anchor = id ? ctx.anchors.get(`ref:node:${id}`) : undefined;
    if (anchor !== undefined) line(ctx, tex`\DEanchor{${int(anchor)}}`);
    const head = tex`{${int(n)}}{${int(headerRows)}}{${alignCode}}{${dimen(marginLR, { min: 0, max: 31680 })}}{${dimen(ruleWidth || 8, { min: 1, max: 240 })}}{${ruleColour}}`;
    if (boxed) {
      line(ctx, tex`\DEboxtbl${head}{${spec}}`);
      const top = hrule(0);
      if (top !== EMPTY) line(ctx, top);
      for (let r = 0; r < rows.length; r++) emitRow(r, false);
      line(ctx, t('\\DEboxtblend'));
    } else {
      line(ctx, tex`\DEtbl${head}`);
      line(ctx, tex`\begin{longtable}{${spec}}`);
      const top = hrule(0);
      if (top !== EMPTY) line(ctx, top);
      if (headerRows > 0) {
        for (let r = 0; r < headerRows; r++) emitRow(r, false);
        line(ctx, t('\\endfirsthead'));
        line(ctx, t('\\DErephead'));
        if (top !== EMPTY) line(ctx, top);
        for (let r = 0; r < headerRows; r++) emitRow(r, true);
        line(ctx, t('\\endhead'));
        line(ctx, t('\\DEbodyrows'));
      }
      for (let r = headerRows; r < rows.length; r++) emitRow(r, false);
      line(ctx, t('\\end{longtable}'));
      line(ctx, t('\\DEtblend'));
    }
  });
  // The rows of a table in the body flow, for the rows per page of layout.json (EXP-057).
  if (id && rowBlocks.length === rows.length && !ctx.tableRows.has(id))
    ctx.tableRows.set(id, rowBlocks);
  flow.prev = null;
}

/**
 * A repeated header row is a copy: its blocks must not register their identifiers again, so the
 * copy's paragraphs have no `id` (map.json and layout.json keep the first occurrence).
 */
function stripIds(node: J): J {
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs['id'];
  return { ...node, attrs, ...(node.content ? { content: node.content.map(stripIds) } : {}) };
}
