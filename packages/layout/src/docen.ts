/**
 * Candidate 1 of spike S7: Docen's layout core, `@docen/layout` 0.7.0 (MIT), driven from CDM flow
 * blocks. Docen's input (a `LayoutDoc` of paragraphs and tables in pixels, cascades resolved) is
 * already the flow-block shape of 02 §9.1, so this adapter is a unit conversion plus a mapping of
 * the result back to the project's layout tree.
 *
 * The measurement seam is missing. Docen measures vertical metrics through an injected
 * `FontMetrics`, but horizontal advances come from `@docen/pretext`, which calls `measureText` on a
 * module-level canvas context that it creates on first use from `OffscreenCanvas` or `document`.
 * So that the injected `TextMeasurer` can be used anyway, this adapter installs, once, a stand-in
 * `OffscreenCanvas` whose 2D context forwards `measureText` to the measurer of the current call,
 * and to a real canvas when no measurer is set. A fork replaces that one function with the
 * injected interface; the stand-in exists only so that the spike can measure the unchanged
 * package. It uses no DOM or Node.js API: only `globalThis`.
 */
import {
  layoutFlowSections,
  lineOriginXPx,
  stackBlocks,
  tableGridOf,
  TextMeasurer as DocenMeasurer,
  type FlowPage as DocenPage,
  type FlowSection as DocenSection,
  type FontMetrics,
  type LaidOutBlock,
  type LaidOutLine,
  type LaidOutParagraph,
  type LaidOutStackItem,
  type LaidOutTable,
  type LayoutBlock,
  type LayoutInline,
  type LayoutParagraph,
  type LayoutTable,
  type LayoutTextStyle,
} from '@docen/layout';
import { clearCache as clearPretextCaches } from '@docen/pretext';
import type {
  FlowBlock,
  FlowDocument,
  FlowFont,
  FlowPage,
  FlowParagraph,
  FlowSection,
  FlowTable,
} from './flow.ts';
import type { FontKey, TextMeasurer } from './measure.ts';
import {
  freezeTree,
  type LayoutFragment,
  type LayoutLine,
  type LayoutPage,
  type LayoutRow,
  type LayoutTree,
  type ParagraphFragment,
  type TableFragment,
} from './tree.ts';

export const DOCEN_ENGINE = '@docen/layout@0.7.0';

const PX_PER_PT = 4 / 3;
const px = (pt: number): number => pt * PX_PER_PT;
const pt = (pixels: number): number => pixels / PX_PER_PT;

// ---------------------------------------------------------------------------------------------
// The measurement stand-in.

/** The part of a 2D canvas context that pretext uses. */
export interface Canvas2D {
  font: string;
  measureText(text: string): { width: number };
}
interface CanvasLike {
  getContext(kind: string): Canvas2D | null;
}
type CanvasConstructor = new (width: number, height: number) => CanvasLike;

let current: TextMeasurer | null = null;
/** A caller's canvas for measuring without an injected measurer where OffscreenCanvas is missing. */
let callerCanvas: Canvas2D | null = null;
let installed = false;

/**
 * Docen caches prepared paragraphs and segment widths at module level, keyed by the CSS font string
 * alone (`preparedCache` in `@docen/layout`, `segmentMetricCaches` in `@docen/pretext`), so a second
 * measurer in the same process would be served the first one's widths. The adapter therefore tags
 * every family with the measurer's identifier, `Noto Serif#fixed-width/0.5/0.8/0.2`; CDM family
 * names cannot contain `#` (cdm-1.attributes.md). A fork keys its caches by font alias, size, text
 * and font epoch instead (02 §9.3).
 */
const TAG = '#';

const untag = (family: string): string => family.split(TAG)[0] ?? family;

/** Parses the CSS font shorthand that Docen builds (`cssFontOf`): `[italic] [bold] <n>px "<family>", serif`. */
export function parseDocenFont(font: string): FontKey {
  const m = /^(italic )?(bold )?([\d.]+)px "((?:[^"\\]|\\.)*)"/.exec(font);
  if (!m)
    return {
      family: 'serif',
      sizePt: pt(Number(/([\d.]+)px/.exec(font)?.[1] ?? 16)),
      bold: false,
      italic: false,
    };
  return {
    family: untag((m[4] ?? '').replace(/\\"/g, '"')),
    sizePt: pt(Number(m[3])),
    bold: m[2] !== undefined,
    italic: m[1] !== undefined,
  };
}

class ForwardingContext implements Canvas2D {
  font = '10px sans-serif';
  private readonly real: Canvas2D | null;
  constructor(Real: CanvasConstructor | undefined) {
    this.real = Real ? new Real(1, 1).getContext('2d') : null;
  }
  measureText(text: string): { width: number } {
    if (current) return { width: px(current.advance(parseDocenFont(this.font), text)) };
    const real = this.real ?? callerCanvas;
    if (!real)
      throw new Error('Docen adapter: no injected measurer and no canvas in this environment');
    real.font = this.font;
    return real.measureText(text);
  }
}

function installForwardingCanvas(): void {
  if (installed) return;
  const g = globalThis as { OffscreenCanvas?: CanvasConstructor };
  const Real = g.OffscreenCanvas;
  g.OffscreenCanvas = class {
    getContext(kind: string): Canvas2D | null {
      return kind === '2d' ? new ForwardingContext(Real) : null;
    }
  };
  installed = true;
}

function fontMetricsOf(measurer: TextMeasurer | null): FontMetrics {
  return {
    normalRatio(request) {
      if (!measurer) return 1.2;
      const m = measurer.lineMetrics({
        family: untag(request.family),
        sizePt: 100,
        bold: request.bold === true,
        italic: request.italic === true,
      });
      return (m.ascent + m.descent + m.lineGap) / 100;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Flow blocks to Docen's LayoutDoc.

function styleOf(c: Converter, font: FlowFont): LayoutTextStyle {
  return {
    family: c.tag ? `${font.family}${TAG}${c.tag}` : font.family,
    sizePx: px(font.sizePt),
    ...(font.bold ? { bold: true } : {}),
    ...(font.italic ? { italic: true } : {}),
    ...(font.color ? { color: font.color.replace('#', '') } : {}),
    ...(font.underline ? { underline: true } : {}),
    ...(font.strike ? { strikethrough: true } : {}),
    ...(font.vertAlign
      ? { verticalAlign: font.vertAlign === 'super' ? 'superscript' : 'subscript' }
      : {}),
  } as LayoutTextStyle;
}

interface Converter {
  /** Docen's inline arrays, mapped back to the flow paragraph they came from. */
  readonly paragraphs: Map<readonly LayoutInline[], FlowParagraph>;
  /** Figures and other boxes are laid out as a paragraph holding one picture. */
  readonly boxes: Map<readonly LayoutInline[], { id: string }>;
  readonly tables: Map<readonly LayoutInline[], { table: FlowTable; row: number; cell: number }>;
  readonly noteNumbers: ReadonlyMap<string, number>;
  readonly defaultTabStopPx: number;
  /** The measurer's identifier, appended to font families; empty when measuring with canvas. */
  readonly tag: string;
}

function paragraphOf(c: Converter, p: FlowParagraph): LayoutParagraph {
  const inline: LayoutInline[] = p.inlines.map((i): LayoutInline => {
    switch (i.kind) {
      case 'text': {
        const base = { kind: 'text' as const, text: i.text, style: styleOf(c, i.font) };
        if (i.role === 'noteRef') {
          const n = c.noteNumbers.get(i.ref ?? '') ?? 0;
          return { ...base, noteRef: { kind: 'footnote', id: n, ordinal: n } };
        }
        if (i.role === 'field' && (i.ref === 'page' || i.ref === 'pageCount'))
          return { ...base, field: i.ref === 'page' ? 'page' : 'numPages' };
        if (i.role === 'label') return { ...base, synthetic: true };
        return base;
      }
      case 'tab':
        return i.toPt !== undefined ? { kind: 'tab', toPx: px(i.toPt) } : { kind: 'tab' };
      case 'lineBreak':
        return { kind: 'break' };
      case 'box':
        return { kind: 'picture', widthPx: px(i.width), heightPx: px(i.height) };
    }
  });
  const out: LayoutParagraph = {
    kind: 'paragraph',
    inline,
    spacing: {
      beforePx: px(p.spaceBefore),
      afterPx: px(p.spaceAfter),
      lineHeight:
        p.line.rule === 'multiple'
          ? { rule: 'multiple', factor: p.line.factor }
          : { rule: p.line.rule, px: px(p.line.pt) },
    },
    indent: {
      leftPx: px(p.indentLeft),
      rightPx: px(p.indentRight),
      firstLinePx: px(p.indentFirstLine),
    },
    // Docen has no decimal tab; it is laid out as a right tab here.
    tabStops: p.tabs.map((t) => ({
      positionPx: px(t.position),
      type: t.align === 'decimal' ? 'right' : t.align,
      ...(t.leader !== 'none' ? { leader: t.leader } : {}),
    })),
    defaultTabStopPx: c.defaultTabStopPx,
    markSizePx: px(p.markFont.sizePt),
    defaultTextStyle: styleOf(c, p.markFont),
    align: p.align === 'justify' ? 'both' : p.align,
    keepNext: p.keepNext,
    keepLines: p.keepLines,
    widowControl: p.widowControl,
    pageBreakBefore: p.pageBreakBefore,
  };
  c.paragraphs.set(inline, p);
  return out;
}

function tableOf(c: Converter, t: FlowTable): LayoutTable {
  const edge = { style: 'single', px: px(0.5) };
  const table: LayoutTable = {
    kind: 'table',
    width: { type: 'px', px: px(t.columnWidths.reduce((a, b) => a + b, 0)) },
    layout: 'fixed',
    align: t.align,
    columnWidthsPx: t.columnWidths.map(px),
    cellInsets: {
      top: px(t.cellMargins.top),
      right: px(t.cellMargins.right),
      bottom: px(t.cellMargins.bottom),
      left: px(t.cellMargins.left),
    },
    ...(t.bordered
      ? {
          borders: {
            top: edge,
            bottom: edge,
            left: edge,
            right: edge,
            insideHorizontal: edge,
            insideVertical: edge,
          },
        }
      : {}),
    rows: t.rows.map((row, r) => ({
      cells: row.cells.map((cell, k) => {
        const blocks = blocksOf(c, cell.blocks);
        for (const b of blocks)
          if (b.kind === 'paragraph') c.tables.set(b.inline, { table: t, row: r, cell: k });
        return {
          colspan: cell.colspan,
          rowspan: cell.rowspan,
          insets: {
            top: px(cell.margins.top),
            right: px(cell.margins.right),
            bottom: px(cell.margins.bottom),
            left: px(cell.margins.left),
          },
          verticalAlign: cell.vAlign,
          blocks,
        };
      }),
      ...(row.height !== null && row.heightRule !== 'auto'
        ? { height: { rule: row.heightRule, px: px(row.height) } }
        : {}),
      ...(row.header ? { tableHeader: true } : {}),
      ...(row.cantSplit ? { cantSplit: true } : {}),
    })),
  };
  return table;
}

function blocksOf(c: Converter, blocks: readonly FlowBlock[]): LayoutBlock[] {
  const out: LayoutBlock[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'paragraph':
        out.push(paragraphOf(c, b));
        break;
      case 'table':
        out.push(tableOf(c, b));
        break;
      case 'box': {
        const inline: LayoutInline[] = [
          { kind: 'picture', widthPx: px(Math.max(b.width, 1)), heightPx: px(b.height) },
        ];
        c.boxes.set(inline, { id: b.id });
        out.push({
          kind: 'paragraph',
          inline,
          spacing: { beforePx: 0, afterPx: 0 },
          align: b.align,
          keepNext: b.keepNext,
        });
        break;
      }
      case 'pageBreak':
        out.push({ kind: 'pageBreak' });
        break;
      case 'columnBreak':
        out.push({ kind: 'columnBreak' });
        break;
    }
  }
  return out;
}

interface StoryStack {
  readonly blocks: readonly LaidOutStackItem[];
  readonly heightPx: number;
}

interface SectionPlan {
  readonly section: FlowSection;
  readonly headers: { default?: StoryStack; first?: StoryStack; even?: StoryStack };
  readonly footers: { default?: StoryStack; first?: StoryStack; even?: StoryStack };
}

function storyStacks(
  c: Converter,
  doc: FlowDocument,
  page: FlowPage,
  ids: FlowPage['headers'],
  measurer: DocenMeasurer,
): { default?: StoryStack; first?: StoryStack; even?: StoryStack } {
  const width = px(page.width - page.marginLeft - page.marginRight);
  const stack = (id: string | null): StoryStack | undefined => {
    const blocks = id ? doc.stories.get(id) : undefined;
    if (!blocks) return undefined;
    const s = stackBlocks(blocksOf(c, blocks), width, undefined, measurer);
    return { blocks: s.stack, heightPx: s.heightPx };
  };
  const out: { default?: StoryStack; first?: StoryStack; even?: StoryStack } = {};
  const d = stack(ids.default);
  if (d) out.default = d;
  const f = page.differentFirstPage ? stack(ids.first) : undefined;
  if (f) out.first = f;
  const e = page.differentOddEven ? stack(ids.even) : undefined;
  if (e) out.even = e;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Docen's result to the layout tree.

interface Cursor {
  inline: number;
  char: number;
}

const WS = /[ \t\n\f\r]/;

/** The CDM offset at a cursor, skipping inter-word spaces so that they end the previous line. */
function offsetAt(p: FlowParagraph, cur: Cursor): number {
  // The first line owns whatever precedes its first printed inline (labels, bookmarks).
  if (cur.inline === 0 && cur.char === 0) return p.start;
  for (let i = cur.inline, ch = cur.char; i < p.inlines.length; i++, ch = 0) {
    const inl = p.inlines[i];
    if (!inl) break;
    if (inl.kind === 'text' && inl.role === 'text') {
      let k = ch;
      while (k < inl.text.length && WS.test(inl.text[k] ?? '')) k++;
      if (k < inl.text.length) return inl.offset + k;
      continue;
    }
    if (inl.size === 0) continue;
    if (ch === 0) return inl.offset;
  }
  return p.end;
}

/** Advances a cursor over one painted line item (Docen collapses whitespace in what it paints). */
function consume(p: FlowParagraph, cur: Cursor, inlineIndex: number, painted: string): void {
  if (inlineIndex > cur.inline) {
    cur.inline = inlineIndex;
    cur.char = 0;
  }
  const inl = p.inlines[inlineIndex];
  if (!inl) return;
  if (inl.kind !== 'text' || inl.role !== 'text') {
    cur.inline = inlineIndex + 1;
    cur.char = 0;
    return;
  }
  const src = inl.text;
  let k = cur.char;
  for (let j = 0; j < painted.length;) {
    const ch = painted[j] ?? '';
    if (WS.test(ch)) {
      while (k < src.length && WS.test(src[k] ?? '')) k++;
      while (j < painted.length && WS.test(painted[j] ?? '')) j++;
      continue;
    }
    while (k < src.length && src[k] !== ch && WS.test(src[k] ?? '')) k++;
    k++;
    j++;
  }
  cur.char = Math.min(k, src.length);
  if (cur.char >= src.length) {
    cur.inline = inlineIndex + 1;
    cur.char = 0;
  }
}

interface MutableLine {
  from: number;
  to: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Mapper {
  readonly c: Converter;
  readonly cursors: Map<FlowParagraph, Cursor>;
  /** Lines in document order for every flow paragraph, to fill in `to` at the end. */
  readonly lines: Map<FlowParagraph, MutableLine[]>;
  readonly rowsSeen: Map<FlowTable, Set<number>>;
}

function lineWidth(line: LaidOutLine): number {
  let right = 0;
  for (const item of line.items) right = Math.max(right, item.xPx + item.widthPx);
  return right;
}

function paragraphFragment(
  m: Mapper,
  laid: LaidOutParagraph,
  x0: number,
  y0: number,
  record: boolean,
): LayoutFragment | null {
  const box = m.c.boxes.get(laid.inline);
  if (box) {
    const first = laid.lines[0];
    const item = first?.items[0];
    return {
      kind: 'box',
      blockId: box.id,
      x: pt(x0 + (first ? lineOriginXPx(laid, first) : 0) + (item?.xPx ?? 0)),
      y: pt(y0),
      width: pt(item?.widthPx ?? 0),
      height: pt(laid.heightPx),
    };
  }
  const p = m.c.paragraphs.get(laid.inline);
  if (!p) return null;
  const cursor = record ? (m.cursors.get(p) ?? { inline: 0, char: 0 }) : { inline: 0, char: 0 };
  const lines: MutableLine[] = [];
  for (const line of laid.lines) {
    const from = offsetAt(p, cursor);
    for (const item of line.items)
      consume(p, cursor, item.inlineIndex, item.kind === 'text' ? item.text : '');
    lines.push({
      from,
      to: from,
      x: pt(x0 + lineOriginXPx(laid, line)),
      y: pt(y0 + line.yPx),
      width: pt(lineWidth(line)),
      height: pt(line.heightPx),
    });
  }
  if (record) {
    m.cursors.set(p, cursor);
    m.lines.set(p, [...(m.lines.get(p) ?? []), ...lines]);
  } else {
    // A repeated header row: a copy, closed on itself.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line) line.to = lines[i + 1]?.from ?? p.end;
    }
  }
  const widthPt = Math.max(0, ...lines.map((l) => l.x + l.width)) - pt(x0);
  return {
    kind: 'paragraph',
    blockId: p.id,
    from: lines[0]?.from ?? p.start,
    to: p.end,
    x: pt(x0),
    y: pt(y0),
    width: widthPt,
    height: pt(laid.heightPx),
    lines,
  } satisfies ParagraphFragment;
}

function firstInlineOf(stack: readonly LaidOutStackItem[]): readonly LayoutInline[] | null {
  for (const item of stack) if (item.block.kind === 'paragraph') return item.block.inline;
  return null;
}

function tableFragment(
  m: Mapper,
  laid: LaidOutTable,
  x0: number,
  y0: number,
): TableFragment | null {
  const grid = tableGridOf(laid);
  let owner: FlowTable | null = null;
  const rows: LayoutRow[] = [];
  for (let r = 0; r < laid.rows.length; r++) {
    const row = laid.rows[r];
    if (!row) continue;
    const placed = grid.cells.filter((p) => p.row === r);
    let flowRow: number | null = null;
    for (const p of placed) {
      const inl = firstInlineOf(p.cell.stack);
      const hit = inl ? m.c.tables.get(inl) : undefined;
      if (hit) {
        owner = hit.table;
        flowRow = hit.row;
        break;
      }
    }
    const seen = owner ? (m.rowsSeen.get(owner) ?? new Set<number>()) : new Set<number>();
    if (owner) m.rowsSeen.set(owner, seen);
    const repeated =
      flowRow !== null && seen.has(flowRow) && (owner?.rows[flowRow]?.header ?? false);
    if (flowRow !== null) seen.add(flowRow);
    const flowRowDef = owner && flowRow !== null ? owner.rows[flowRow] : undefined;
    rows.push({
      rowId: flowRowDef?.id ?? `row-${r}`,
      repeated,
      y: pt(y0 + (grid.rowY[r] ?? 0)),
      height: pt(row.heightPx),
      cells: placed.map((p, k) => ({
        cellId: flowRowDef?.cells[k]?.id ?? `cell-${r}-${k}`,
        x: pt(x0 + (grid.colX[p.col] ?? 0)),
        width: pt((grid.colX[p.col + p.spanW] ?? 0) - (grid.colX[p.col] ?? 0)),
        fragments: stackFragments(m, p.cell.stack, x0 + p.contentXPx, y0 + p.contentYPx, !repeated),
      })),
    });
  }
  if (!owner) return null;
  return {
    kind: 'table',
    blockId: owner.id,
    x: pt(x0 + (laid.offsetXPx ?? 0)),
    y: pt(y0),
    width: pt(laid.widthPx),
    height: pt(laid.heightPx),
    rows,
  };
}

function blockFragment(
  m: Mapper,
  block: LaidOutBlock,
  x0: number,
  y0: number,
  record: boolean,
): LayoutFragment[] {
  switch (block.kind) {
    case 'paragraph': {
      const f = paragraphFragment(m, block, x0, y0, record);
      return f ? [f] : [];
    }
    case 'table': {
      const f = tableFragment(m, block, x0, y0);
      return f ? [f] : [];
    }
    case 'group':
      return stackFragments(m, block.children, x0, y0, record);
    default:
      return [];
  }
}

function stackFragments(
  m: Mapper,
  stack: readonly LaidOutStackItem[],
  x0: number,
  y0: number,
  record: boolean,
): LayoutFragment[] {
  return stack.flatMap((item) => blockFragment(m, item.block, x0, y0 + item.yPx, record));
}

function pageVariant<T>(
  variants: { default?: T; first?: T; even?: T },
  localIndex: number,
  globalIndex: number,
): T | undefined {
  if (localIndex === 0 && variants.first) return variants.first;
  if (globalIndex % 2 === 1 && variants.even) return variants.even;
  return variants.default;
}

export interface DocenLayoutOptions {
  /** The injected measurer. Null measures with the environment's canvas (browsers only). */
  readonly measurer: TextMeasurer | null;
  /** With a null measurer, where OffscreenCanvas is missing (WebKit on Windows): a 2D context to use. */
  readonly canvas?: () => Canvas2D;
}

/** Lays out a flow document with Docen's core and returns the project's layout tree. */
export function layoutWithDocen(doc: FlowDocument, options: DocenLayoutOptions): LayoutTree {
  installForwardingCanvas();
  clearPretextCaches();
  current = options.measurer;
  callerCanvas = options.measurer ? null : (options.canvas?.() ?? null);
  try {
    const measurer = new DocenMeasurer(fontMetricsOf(options.measurer));
    const noteNumbers = new Map([...doc.notes.values()].map((n) => [n.id, n.number]));
    const c: Converter = {
      paragraphs: new Map(),
      boxes: new Map(),
      tables: new Map(),
      noteNumbers,
      defaultTabStopPx: px(doc.defaultTabStop),
      tag: options.measurer?.id ?? '',
    };
    const footnoteDefinitions = new Map<number, readonly LayoutBlock[]>();
    for (const note of doc.notes.values())
      footnoteDefinitions.set(note.number, blocksOf(c, note.blocks));
    const plans: SectionPlan[] = doc.sections.map((section) => ({
      section,
      headers: storyStacks(c, doc, section.page, section.page.headers, measurer),
      footers: storyStacks(c, doc, section.page, section.page.footers, measurer),
    }));
    const sections: DocenSection[] = plans.map(({ section, headers, footers }) => {
      const pg = section.page;
      const inset = (
        h: StoryStack | undefined,
        f: StoryStack | undefined,
      ): { topPx: number; bottomPx: number } => ({
        topPx: Math.max(0, px(pg.headerDistance) + (h?.heightPx ?? 0) - px(pg.marginTop)),
        bottomPx: Math.max(0, px(pg.footerDistance) + (f?.heightPx ?? 0) - px(pg.marginBottom)),
      });
      return {
        blocks: blocksOf(c, section.blocks),
        type: section.start,
        opts: {
          contentWidthPx: px(pg.width - pg.marginLeft - pg.marginRight),
          contentHeightPx: px(pg.height - pg.marginTop - pg.marginBottom),
          ...(pg.columns > 1
            ? {
                columns: {
                  count: pg.columns,
                  spacePx: px(pg.columnGap),
                  separate: false,
                  equalWidth: true,
                },
              }
            : {}),
          pageInsets: {
            default: inset(headers.default, footers.default),
            ...(pg.differentFirstPage ? { first: inset(headers.first, footers.first) } : {}),
            ...(pg.differentOddEven ? { even: inset(headers.even, footers.even) } : {}),
          },
          ...(footnoteDefinitions.size > 0
            ? { footnoteDefinitions: footnoteDefinitions as Map<number, LayoutBlock[]> }
            : {}),
        },
      };
    });
    const result = layoutFlowSections(sections, measurer);
    const m: Mapper = { c, cursors: new Map(), lines: new Map(), rowsSeen: new Map() };
    const firstPageOfSection = new Map<number, number>();
    const pages: LayoutPage[] = result.pages.map((page: DocenPage, index) => {
      const s = result.sectionOfPage[index] ?? 0;
      if (!firstPageOfSection.has(s)) firstPageOfSection.set(s, index);
      const plan = plans[s];
      const pg = plan?.section.page ?? doc.sections[0]?.page;
      if (!plan || !pg) throw new Error('Docen adapter: page without a section');
      const local = index - (firstPageOfSection.get(s) ?? index);
      const x0 = px(pg.marginLeft);
      const y0 = px(pg.marginTop);
      const fragments = page.items.flatMap((item) =>
        blockFragment(m, item.block, x0 + (item.xPx ?? 0), y0 + item.yPx, true),
      );
      const header = pageVariant(plan.headers, local, index);
      const footer = pageVariant(plan.footers, local, index);
      const area = page.footnotes;
      return {
        index,
        section: s,
        width: pg.width,
        height: pg.height,
        fragments,
        header: header ? stackFragments(m, header.blocks, x0, px(pg.headerDistance), false) : [],
        footer: footer
          ? stackFragments(
              m,
              footer.blocks,
              x0,
              px(pg.height - pg.footerDistance) - footer.heightPx,
              false,
            )
          : [],
        footnotes: area ? stackFragments(m, area.items, x0, y0 + area.yPx, true) : [],
      };
    });
    // Each line ends where the next line of its paragraph starts; the last one at the paragraph's end.
    for (const [p, lines] of m.lines)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line) line.to = lines[i + 1]?.from ?? p.end;
      }
    const tree: LayoutTree = {
      engine: DOCEN_ENGINE,
      measurer: options.measurer?.id ?? 'canvas',
      pages,
    };
    return freezeTree(fixFragmentRanges(tree));
  } finally {
    current = null;
    callerCanvas = null;
    clearPretextCaches();
  }
}

/** Paragraph fragments end where their last line ends. */
function fixFragmentRanges(tree: LayoutTree): LayoutTree {
  const fix = (fragments: readonly LayoutFragment[]): LayoutFragment[] =>
    fragments.map((f) => {
      if (f.kind === 'paragraph') {
        const last = f.lines[f.lines.length - 1] as LayoutLine | undefined;
        return { ...f, to: last ? last.to : f.to };
      }
      if (f.kind === 'table')
        return {
          ...f,
          rows: f.rows.map((r) => ({
            ...r,
            cells: r.cells.map((c) => ({ ...c, fragments: fix(c.fragments) })),
          })),
        };
      return f;
    });
  return {
    ...tree,
    pages: tree.pages.map((p) => ({
      ...p,
      fragments: fix(p.fragments),
      header: fix(p.header),
      footer: fix(p.footer),
      footnotes: fix(p.footnotes),
    })),
  };
}
