/**
 * CDM document to flow blocks (02 §9.1; FE-077): the engine-neutral input every layout core in
 * this spike is driven from. Formatting is resolved here, once, in the order of 03 §6, so that an
 * engine sees fonts, sizes, indents and spacing in points and never a style identifier.
 *
 * Spike scope (SPK-020): paragraphs with runs, tabs, line, page and column breaks, numbering labels,
 * fields, inline images and equations as stand-ins, footnotes, tables, figures, display equations,
 * a table of contents, regions, section breaks with their page setups, and header and footer
 * stories. The cascade is the model's (`resolveParagraph`, `resolveRun`, `resolveLabelRun`;
 * CDM-041) and the labels are the model's (`computeLabels`; CDM-042): this module computes neither.
 */
import {
  BASE_PARAGRAPH,
  BASE_RUN,
  computeLabels,
  resolveLabelRun,
  resolveParagraph,
  resolveRun,
  styleTable,
  type ResolvedParagraph,
  type RunProperties,
  type StyleTable,
} from '@docedit/model';
import { indexDefinition } from '@docedit/model/definition';
import type { FontKey } from './measure.ts';

// ---------------------------------------------------------------------------------------------
// Flow block types. Every length is in points; offsets are CDM positions inside the block.

export interface FlowFont extends FontKey {
  readonly color: string | null;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly vertAlign: 'super' | 'sub' | null;
}

/**
 * Text and text stand-ins. `role` says what the text is:
 * - `text`: document text; `size` equals `text.length`.
 * - `label`: a numbering label the layout prints but the document does not hold; `size` is 0.
 * - `field`, `equation`, `form`, `extension`: an atom shown as stand-in text; it never breaks.
 * - `noteRef`: a footnote reference mark; `size` is the footnote node's size.
 */
export interface FlowText {
  readonly kind: 'text';
  readonly role: 'text' | 'label' | 'field' | 'equation' | 'form' | 'extension' | 'noteRef';
  readonly text: string;
  readonly font: FlowFont;
  readonly offset: number;
  readonly size: number;
  /** For `noteRef`: the footnote's identifier. For `field`: the field kind. */
  readonly ref?: string;
}

export interface FlowTab {
  readonly kind: 'tab';
  readonly font: FlowFont;
  readonly offset: number;
  readonly size: number;
  /** A tab the numbering label adds, which jumps to the hanging indent. */
  readonly toPt?: number;
}

export interface FlowLineBreak {
  readonly kind: 'lineBreak';
  readonly font: FlowFont;
  readonly offset: number;
  readonly size: number;
}

/** An inline box: a picture or preserved content, laid out by its size. */
export interface FlowInlineBox {
  readonly kind: 'box';
  readonly what: 'image' | 'preserved';
  readonly width: number;
  readonly height: number;
  readonly font: FlowFont;
  readonly offset: number;
  readonly size: number;
}

export type FlowInline = FlowText | FlowTab | FlowLineBreak | FlowInlineBox;

export interface FlowTabStop {
  readonly position: number;
  readonly align: 'left' | 'center' | 'right' | 'decimal';
  readonly leader: 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot' | 'heavy';
}

export type FlowLineSpacing =
  | { readonly rule: 'multiple'; readonly factor: number }
  | { readonly rule: 'exact' | 'atLeast'; readonly pt: number };

export interface FlowParagraph {
  readonly kind: 'paragraph';
  /** The CDM block this paragraph comes from (for a caption or a contents entry, its owner). */
  readonly id: string;
  /** 0 unless one CDM block yields several flow paragraphs (split at a page break, contents). */
  readonly part: number;
  /** CDM offset of the first inline of this part inside the block. */
  readonly start: number;
  /** CDM offset just past the last inline of this part. */
  readonly end: number;
  /** Generated at layout time (a contents entry); it covers no document text of its own. */
  readonly generated: boolean;
  /**
   * The BCP 47 language of the paragraph: the `lang` of its style (or of the paragraph), else the
   * document's default in `settings`. Absent when neither gives one (FE-080).
   */
  readonly lang?: string;
  readonly styleId: string;
  readonly outlineLevel: number | null;
  readonly align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  readonly indentLeft: number;
  readonly indentRight: number;
  /** Negative for a hanging indent. */
  readonly indentFirstLine: number;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly line: FlowLineSpacing;
  readonly keepNext: boolean;
  readonly keepLines: boolean;
  readonly pageBreakBefore: boolean;
  readonly widowControl: boolean;
  readonly tabs: readonly FlowTabStop[];
  /** The paragraph mark's font: the line height of an empty paragraph. */
  readonly markFont: FlowFont;
  readonly inlines: readonly FlowInline[];
  readonly regionId: string | null;
}

/** A block laid out by its size: a figure, a display equation, preserved or extension content. */
export interface FlowBox {
  readonly kind: 'box';
  readonly id: string;
  readonly what: 'figure' | 'equation' | 'preserved' | 'extension';
  readonly width: number;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right';
  readonly keepNext: boolean;
  readonly regionId: string | null;
}

export interface FlowBreak {
  readonly kind: 'pageBreak' | 'columnBreak';
  /** The paragraph the break sits in. */
  readonly id: string;
}

export interface FlowCell {
  readonly id: string;
  readonly colspan: number;
  readonly rowspan: number;
  readonly vAlign: 'top' | 'center' | 'bottom';
  readonly margins: FlowInsets;
  readonly blocks: readonly FlowBlock[];
}

export interface FlowRow {
  readonly id: string;
  readonly height: number | null;
  readonly heightRule: 'auto' | 'atLeast' | 'exact';
  readonly cantSplit: boolean;
  readonly header: boolean;
  readonly cells: readonly FlowCell[];
}

export interface FlowInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface FlowTable {
  readonly kind: 'table';
  readonly id: string;
  readonly columnWidths: readonly number[];
  readonly align: 'left' | 'center' | 'right';
  readonly headerRows: number;
  readonly cellMargins: FlowInsets;
  readonly bordered: boolean;
  readonly rows: readonly FlowRow[];
  readonly regionId: string | null;
}

export type FlowBlock = FlowParagraph | FlowTable | FlowBox | FlowBreak;

export interface FlowStories {
  readonly default: string | null;
  readonly first: string | null;
  readonly even: string | null;
}

export interface FlowPage {
  readonly setupId: string;
  readonly width: number;
  readonly height: number;
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  readonly headerDistance: number;
  readonly footerDistance: number;
  readonly columns: number;
  readonly columnGap: number;
  readonly differentFirstPage: boolean;
  readonly differentOddEven: boolean;
  readonly headers: FlowStories;
  readonly footers: FlowStories;
  readonly pageNumberStart: number | null;
  readonly pageNumberFormat: string | null;
}

export interface FlowSection {
  /** The `section_break` that starts this section, or null for the first section. */
  readonly breakId: string | null;
  readonly start: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage';
  readonly page: FlowPage;
  readonly blocks: readonly FlowBlock[];
}

export interface FlowNote {
  readonly id: string;
  readonly number: number;
  readonly label: string;
  readonly blocks: readonly FlowParagraph[];
}

export interface FlowDocument {
  readonly sections: readonly FlowSection[];
  /** Header and footer stories by identifier. */
  readonly stories: ReadonlyMap<string, readonly FlowBlock[]>;
  /** Footnotes by identifier, in reference order. */
  readonly notes: ReadonlyMap<string, FlowNote>;
  readonly defaultTabStop: number;
}

// ---------------------------------------------------------------------------------------------
// CDM reading.

interface CdmMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | null;
}

export interface CdmNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | null;
  readonly content?: readonly CdmNode[] | null;
  readonly text?: string;
  readonly marks?: readonly CdmMark[] | null;
}

export interface CdmEnvelopeLike {
  readonly doc: CdmNode;
}

const definition = indexDefinition();

/** An attribute, or the schema default when the node does not set it. */
function attr(node: CdmNode, name: string): unknown {
  const value = node.attrs?.[name];
  if (value !== undefined && value !== null) return value;
  return definition.nodes.get(node.type)?.attrs[name]?.default ?? null;
}

const pt = (twips: number): number => twips / 20;
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The face used when no layer of the cascade names a font (the model resolves null). */
const FALLBACK_FAMILY = 'Noto Serif';

type Attrs = Readonly<Record<string, unknown>>;

/**
 * Inline node size in CDM positions: text by UTF-16 length; a footnote, which holds paragraphs
 * (CDM-001, option B), and each of its paragraphs by their content plus two; other atoms one.
 */
function inlineSize(node: CdmNode): number {
  if (node.type === 'text') return node.text?.length ?? 0;
  if (node.type === 'footnote' || node.type === 'paragraph')
    return 2 + (node.content ?? []).reduce((s, c) => s + inlineSize(c), 0);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Numbering (03 §7). The labels come from the shared algorithm (`computeLabels`, packages/model);
// a list level's indents and the run format of its label come from the model's cascade (FE-077).

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let out = '';
  let rest = Math.max(1, Math.min(n, 3999));
  for (const [value, digits] of table)
    while (rest >= value) {
      out += digits;
      rest -= value;
    }
  return out;
}

function toLetters(n: number): string {
  const letter = String.fromCharCode(97 + ((Math.max(1, n) - 1) % 26));
  return letter.repeat(Math.floor((Math.max(1, n) - 1) / 26) + 1);
}

export function formatNumber(n: number, format: string): string {
  switch (format) {
    case 'lowerLetter':
      return toLetters(n);
    case 'upperLetter':
      return toLetters(n).toUpperCase();
    case 'lowerRoman':
      return toRoman(n);
    case 'upperRoman':
      return toRoman(n).toUpperCase();
    case 'none':
      return '';
    default:
      return String(n);
  }
}

// ---------------------------------------------------------------------------------------------
// The formatting cascade (03 §6): the model's resolver, read into flow values.

interface Context {
  readonly table: StyleTable;
  readonly pageSetups: ReadonlyMap<string, CdmNode>;
  readonly notes: Map<string, FlowNote>;
  readonly headings: { block: FlowParagraph; text: string }[];
  readonly captions: { name: string; block: FlowParagraph; text: string }[];
  footnoteFormat: string;
  /** The document's default language (`settings` `lang`), or null (FE-080). */
  readonly docLang: string | null;
  /**
   * Footnote marks by footnote identifier, from the shared numbering algorithm (`computeLabels`,
   * CDM-042): the format of `footnoteFormat` and the restart of `footnoteRestart` (FE-084).
   */
  readonly footnoteLabels: ReadonlyMap<string, string>;
  /** The label of each numbered paragraph (lists and headings), by paragraph identifier (FE-077). */
  readonly listLabels: ReadonlyMap<string, string>;
  /** The paragraphs whose style or direct formatting turns contextualSpacing on (CDM-043). */
  readonly contextual: Set<FlowBlock>;
}

/** A property through a style's `basedOn` chain, stopping before `stopAt` (exclusive). */
function chainValue(
  table: StyleTable,
  styleId: string | null,
  name: string,
  stopAt: string | null,
): unknown {
  const seen = new Set<string>();
  for (let id = styleId; id !== null && id !== stopAt && !seen.has(id) && seen.size < 10;) {
    seen.add(id);
    const style = table.styles.get(id);
    if (!style) return null;
    const value = style[name];
    if (value !== undefined && value !== null) return value;
    id = str(style['basedOn']);
  }
  return null;
}

/** What the cascade resolved for one paragraph: every run in it starts from this. */
interface Scope {
  /** The paragraph's own style, as named (it may not be defined). */
  readonly styleId: string;
  /** The model's resolution of the paragraph (03 §6, layers 0 to 6). */
  readonly resolved: ResolvedParagraph;
}

/** A paragraph with no style at all: the base values of the cascade (ADR 0032). */
const UNSTYLED: ResolvedParagraph = Object.freeze({
  styleId: '',
  outlineLevel: null,
  numbering: null,
  level: null,
  properties: BASE_PARAGRAPH,
  run: BASE_RUN,
});

/**
 * The style table the layout resolves against. The layout draws documents that were not
 * validated, so a default paragraph style that is not defined counts as a style that sets nothing,
 * instead of failing every paragraph.
 */
function tolerantTable(table: StyleTable): StyleTable {
  const id = table.defaultParagraphStyle;
  if (table.styles.has(id)) return table;
  const styles = new Map(table.styles);
  styles.set(id, Object.freeze({ id, kind: 'paragraph' }));
  return { ...table, styles };
}

/**
 * The model's resolution of a paragraph (CDM-041). A broken chain (a missing style, a cycle; I4 and
 * I5 normally prevent both) must not stop the layout: the broken layer is left out, the table style
 * first, then the paragraph's own style, and the base values are the last resort.
 */
function scopeOf(ctx: Context, attrs: Attrs | null, tableStyle: string | null): Scope {
  const styleId = str(attrs?.['style']) ?? ctx.table.defaultParagraphStyle;
  const inTable = tableStyle !== null && ctx.table.styles.has(tableStyle) ? tableStyle : null;
  const unstyled: Attrs = { ...attrs, style: null };
  const attempts: [Attrs, string | null][] = [
    [attrs ?? {}, inTable],
    [attrs ?? {}, null],
    [unstyled, inTable],
    [unstyled, null],
  ];
  for (const [a, t] of attempts) {
    const r = resolveParagraph(ctx.table, a, { tableStyle: t });
    if (r.ok) return { styleId, resolved: r.value };
  }
  return { styleId, resolved: UNSTYLED };
}

/** The scope of a paragraph the layout generates in a named style (a caption, a footnote, an entry). */
const styleScope = (ctx: Context, styleId: string, tableStyle: string | null): Scope =>
  scopeOf(ctx, { style: styleId }, tableStyle);

/**
 * A run's properties from the model (layers 6 to 8). A broken character style chain leaves the
 * character style out.
 */
function runOf(ctx: Context, scope: Scope, marks: readonly CdmMark[]): RunProperties {
  const list = marks as Parameters<typeof resolveRun>[2];
  const r = resolveRun(ctx.table, scope.resolved, list);
  if (r.ok) return r.value;
  const plain = resolveRun(
    ctx.table,
    scope.resolved,
    list?.filter((m) => m.type !== 'charStyle'),
  );
  return plain.ok ? plain.value : scope.resolved.run;
}

/** Resolved run properties as the font a measurer and a painter take. */
function flowFont(r: RunProperties): FlowFont {
  return {
    family: r.fontFamily ?? FALLBACK_FAMILY,
    sizePt: pt(r.fontSize),
    bold: r.bold,
    italic: r.italic,
    color: r.color,
    underline: r.underline !== 'none',
    strike: r.strike,
    vertAlign: r.vertAlign === 'super' || r.vertAlign === 'sub' ? r.vertAlign : null,
  };
}

const fontOf = (ctx: Context, scope: Scope, marks: readonly CdmMark[]): FlowFont =>
  flowFont(runOf(ctx, scope, marks));

function alignOf(v: unknown): FlowParagraph['align'] {
  switch (v) {
    case 'center':
      return 'center';
    case 'end':
      return 'right';
    case 'justify':
      return 'justify';
    case 'distribute':
      return 'distribute';
    default:
      return 'left';
  }
}

function lineOf(spacing: unknown, rule: unknown): FlowLineSpacing {
  const value = num(spacing);
  if (rule === 'exact' || rule === 'atLeast') return { rule, pt: pt(value ?? 240) };
  return { rule: 'multiple', factor: (value ?? 1000) / 1000 };
}

function tabsOf(v: unknown): FlowTabStop[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t: Attrs) => {
      const align = str(t['align']);
      const leader = str(t['leader']);
      return {
        position: pt(num(t['position']) ?? 0),
        align: align === 'center' || align === 'right' || align === 'decimal' ? align : 'left',
        leader:
          leader === 'dot' ||
          leader === 'hyphen' ||
          leader === 'underscore' ||
          leader === 'middleDot' ||
          leader === 'heavy'
            ? leader
            : 'none',
      } satisfies FlowTabStop;
    })
    .sort((a, b) => a.position - b.position);
}

// ---------------------------------------------------------------------------------------------
// Blocks.

interface ParagraphShape {
  styleId: string;
  outlineLevel: number | null;
  align: FlowParagraph['align'];
  indentLeft: number;
  indentRight: number;
  indentFirstLine: number;
  spaceBefore: number;
  spaceAfter: number;
  contextualSpacing: boolean;
  line: FlowLineSpacing;
  keepNext: boolean;
  keepLines: boolean;
  pageBreakBefore: boolean;
  widowControl: boolean;
  tabs: FlowTabStop[];
  markFont: FlowFont;
  lang: string | null;
}

/** The flow values of a resolved paragraph: the model's values, lengths in points. */
function paragraphShape(ctx: Context, scope: Scope): ParagraphShape {
  const p = scope.resolved.properties;
  return {
    styleId: scope.styleId,
    lang: scope.resolved.run.lang ?? ctx.docLang,
    outlineLevel: scope.resolved.outlineLevel,
    align: alignOf(p.align),
    indentLeft: pt(p.indentLeft),
    indentRight: pt(p.indentRight),
    indentFirstLine: pt(p.indentFirstLine),
    spaceBefore: pt(p.spaceBefore),
    spaceAfter: pt(p.spaceAfter),
    contextualSpacing: p.contextualSpacing,
    line: lineOf(p.lineSpacing, p.lineRule),
    keepNext: p.keepNext,
    keepLines: p.keepLines,
    pageBreakBefore: p.pageBreakBefore,
    widowControl: p.widowControl,
    tabs: tabsOf(p.tabs),
    markFont: fontOf(ctx, scope, []),
  };
}

function fieldText(node: CdmNode): string {
  const cached = str(node.attrs?.['cached']);
  if (cached) return cached;
  switch (str(node.attrs?.['kind'])) {
    case 'page':
    case 'pageCount':
    case 'seq':
      return '1';
    case 'date':
      return '06/11/2026';
    default:
      return '?';
  }
}

/** Stand-in text for an atom: spaces become no-break spaces so that it never breaks. */
const atomText = (s: string): string => s.replace(/ /g, ' ') || ' ';

interface ParagraphOptions {
  readonly id: string;
  readonly scope: Scope;
  readonly shape: ParagraphShape;
  readonly regionId: string | null;
  readonly label: { text: string; font: FlowFont } | null;
}

/** Converts a paragraph's inline content, splitting it at page and column breaks. */
function paragraphBlocks(
  ctx: Context,
  content: readonly CdmNode[],
  o: ParagraphOptions,
): FlowBlock[] {
  const out: FlowBlock[] = [];
  let inlines: FlowInline[] = [];
  let part = 0;
  let partStart = 0;
  let offset = 0;
  const flush = (end: number, last: boolean): void => {
    const first = part === 0;
    out.push({
      kind: 'paragraph',
      id: o.id,
      part,
      start: partStart,
      end,
      generated: false,
      styleId: o.shape.styleId,
      outlineLevel: o.shape.outlineLevel,
      align: o.shape.align,
      indentLeft: o.shape.indentLeft,
      indentRight: o.shape.indentRight,
      indentFirstLine: first ? o.shape.indentFirstLine : 0,
      spaceBefore: first ? o.shape.spaceBefore : 0,
      spaceAfter: last ? o.shape.spaceAfter : 0,
      line: o.shape.line,
      keepNext: last && o.shape.keepNext,
      keepLines: o.shape.keepLines,
      pageBreakBefore: first && o.shape.pageBreakBefore,
      widowControl: o.shape.widowControl,
      tabs: o.shape.tabs,
      markFont: o.shape.markFont,
      ...(o.shape.lang !== null ? { lang: o.shape.lang } : {}),
      inlines,
      regionId: o.regionId,
    });
    if (o.shape.contextualSpacing) ctx.contextual.add(out[out.length - 1] as FlowParagraph);
    inlines = [];
    part++;
  };
  if (o.label) {
    inlines.push({
      kind: 'text',
      role: 'label',
      text: o.label.text,
      font: o.label.font,
      offset: 0,
      size: 0,
    });
    inlines.push({ kind: 'tab', font: o.label.font, offset: 0, size: 0, toPt: o.shape.indentLeft });
  }
  for (const node of content) {
    const marks = node.marks ?? [];
    const size = inlineSize(node);
    const at = offset;
    offset += size;
    if (marks.some((m) => m.type === 'hidden' && m.attrs?.['value'] !== false)) continue;
    switch (node.type) {
      case 'text': {
        const font = fontOf(ctx, o.scope, marks);
        const allCaps = runOf(ctx, o.scope, marks).allCaps;
        const text = node.text ?? '';
        inlines.push({
          kind: 'text',
          role: 'text',
          text: allCaps ? text.toUpperCase() : text,
          font,
          offset: at,
          size,
        });
        break;
      }
      case 'tab':
        inlines.push({ kind: 'tab', font: fontOf(ctx, o.scope, marks), offset: at, size });
        break;
      case 'break': {
        const kind = str(node.attrs?.['kind']) ?? 'line';
        if (kind === 'line')
          inlines.push({ kind: 'lineBreak', font: fontOf(ctx, o.scope, marks), offset: at, size });
        else {
          flush(at + size, false);
          partStart = at + size;
          out.push({ kind: kind === 'column' ? 'columnBreak' : 'pageBreak', id: o.id });
        }
        break;
      }
      case 'image':
        inlines.push({
          kind: 'box',
          what: 'image',
          width: pt(num(node.attrs?.['width']) ?? 240),
          height: pt(num(node.attrs?.['height']) ?? 240),
          font: fontOf(ctx, o.scope, marks),
          offset: at,
          size,
        });
        break;
      case 'preserved_inline':
        if (num(node.attrs?.['width']) && num(node.attrs?.['height']))
          inlines.push({
            kind: 'box',
            what: 'preserved',
            width: pt(num(node.attrs?.['width']) ?? 0),
            height: pt(num(node.attrs?.['height']) ?? 0),
            font: fontOf(ctx, o.scope, marks),
            offset: at,
            size,
          });
        else {
          const text = atomText(
            str(node.attrs?.['fallbackText']) ?? str(node.attrs?.['label']) ?? '[preserved]',
          );
          inlines.push({
            kind: 'text',
            role: 'extension',
            text,
            font: fontOf(ctx, o.scope, marks),
            offset: at,
            size,
          });
        }
        break;
      case 'equation':
        // Stand-in until KaTeX measures it (FE-069): the LaTeX source in the run's font.
        inlines.push({
          kind: 'text',
          role: 'equation',
          text: atomText(str(node.attrs?.['latex']) ?? ''),
          // Italic unless the run says otherwise: a mark the run carries wins.
          font: fontOf(
            ctx,
            o.scope,
            marks.some((m) => m.type === 'italic') ? marks : [...marks, { type: 'italic' }],
          ),
          offset: at,
          size,
        });
        break;
      case 'field':
        inlines.push({
          kind: 'text',
          role: 'field',
          text: atomText(fieldText(node)),
          font: fontOf(ctx, o.scope, marks),
          offset: at,
          size,
          ref: str(node.attrs?.['kind']) ?? 'unknown',
        });
        break;
      case 'form_field': {
        const width = num(node.attrs?.['width']);
        const text = str(node.attrs?.['value']) ?? str(node.attrs?.['label']) ?? '';
        if (width)
          inlines.push({
            kind: 'box',
            what: 'preserved',
            width: pt(width),
            height: o.shape.markFont.sizePt,
            font: o.shape.markFont,
            offset: at,
            size,
          });
        else
          inlines.push({
            kind: 'text',
            role: 'form',
            text: atomText(text || '    '),
            font: fontOf(ctx, o.scope, marks),
            offset: at,
            size,
          });
        break;
      }
      case 'extension_inline':
        inlines.push({
          kind: 'text',
          role: 'extension',
          text: atomText(str(node.attrs?.['fallbackText']) ?? '[extension]'),
          font: fontOf(ctx, o.scope, marks),
          offset: at,
          size,
        });
        break;
      case 'footnote': {
        const id = str(node.attrs?.['id']) ?? `note-${ctx.notes.size + 1}`;
        const note = footnote(ctx, id, node.content ?? []);
        const font = fontOf(ctx, o.scope, [
          ...marks,
          { type: 'charStyle', attrs: { style: 'FootnoteReference' } },
        ]);
        inlines.push({
          kind: 'text',
          role: 'noteRef',
          text: note.label,
          font,
          offset: at,
          size,
          ref: id,
        });
        break;
      }
      default:
        // anchor and other zero-width atoms take a position but print nothing.
        break;
    }
  }
  flush(offset, true);
  return out;
}

function footnote(ctx: Context, id: string, content: readonly CdmNode[]): FlowNote {
  const existing = ctx.notes.get(id);
  if (existing) return existing;
  const number = ctx.notes.size + 1;
  // The mark comes from the shared algorithm. A footnote it does not number (none in a body of a
  // valid document) falls back to the count of this flow, in the format of the file.
  const label = ctx.footnoteLabels.get(id) ?? formatNumber(number, ctx.footnoteFormat);
  const scope = styleScope(ctx, 'FootnoteText', null);
  const shape = paragraphShape(ctx, scope);
  const labelFont = fontOf(ctx, scope, [
    { type: 'charStyle', attrs: { style: 'FootnoteReference' } },
  ]);
  // A footnote holds paragraphs (CDM-001, option B; exactly one in version 1): lay out each one.
  const blocks = content
    .filter((p) => p.type === 'paragraph')
    .flatMap((p) =>
      paragraphBlocks(ctx, p.content ?? [], {
        id: str(p.attrs?.['id']) ?? id,
        scope,
        shape,
        regionId: null,
        label: null,
      }),
    )
    .filter((b): b is FlowParagraph => b.kind === 'paragraph');
  const [first, ...rest] = blocks;
  const withLabel: FlowParagraph[] = first
    ? [
        {
          ...first,
          inlines: [
            { kind: 'text', role: 'label', text: label, font: labelFont, offset: 0, size: 0 },
            { kind: 'text', role: 'label', text: ' ', font: shape.markFont, offset: 0, size: 0 },
            ...first.inlines,
          ],
        },
        ...rest,
      ]
    : [];
  const note: FlowNote = { id, number, label, blocks: withLabel };
  ctx.notes.set(id, note);
  return note;
}

function insetsOf(v: unknown, fallback: FlowInsets): FlowInsets {
  if (!v || typeof v !== 'object') return fallback;
  const m = v as Attrs;
  return {
    top: num(m['top']) !== null ? pt(num(m['top']) ?? 0) : fallback.top,
    right: num(m['right']) !== null ? pt(num(m['right']) ?? 0) : fallback.right,
    bottom: num(m['bottom']) !== null ? pt(num(m['bottom']) ?? 0) : fallback.bottom,
    left: num(m['left']) !== null ? pt(num(m['left']) ?? 0) : fallback.left,
  };
}

function paragraphOf(
  ctx: Context,
  node: CdmNode,
  tableStyle: string | null,
  regionId: string | null,
): FlowBlock[] {
  const id = str(node.attrs?.['id']) ?? 'unidentified';
  const scope = scopeOf(ctx, node.attrs ?? null, tableStyle);
  const shape = paragraphShape(ctx, scope);
  let label: ParagraphOptions['label'] = null;
  if (scope.resolved.numbering && scope.resolved.level) {
    const text = ctx.listLabels.get(id) ?? '';
    if (text) label = { text, font: flowFont(resolveLabelRun(scope.resolved)) };
  }
  const blocks = paragraphBlocks(ctx, node.content ?? [], { id, scope, shape, regionId, label });
  const first = blocks[0];
  const text = (node.content ?? []).map((c) => c.text ?? '').join('');
  if (first?.kind === 'paragraph') {
    if (shape.outlineLevel !== null)
      ctx.headings.push({ block: first, text: (label ? `${label.text} ` : '') + text });
    const seq = (node.content ?? []).find((c) => c.type === 'field' && c.attrs?.['kind'] === 'seq');
    const seqName = str(seq?.attrs?.['name']);
    if (seqName) ctx.captions.push({ name: seqName, block: first, text });
  }
  return blocks;
}

function tableOf(ctx: Context, node: CdmNode, regionId: string | null): FlowTable {
  const id = str(node.attrs?.['id']) ?? 'unidentified';
  const tableStyle = str(node.attrs?.['style']);
  const styleValue = (name: string): unknown =>
    node.attrs?.[name] ?? (tableStyle ? chainValue(ctx.table, tableStyle, name, null) : null);
  const cellMargins = insetsOf(styleValue('cellMargins'), {
    top: 0,
    right: 5.4,
    bottom: 0,
    left: 5.4,
  });
  const headerRows = num(attr(node, 'headerRows')) ?? 0;
  const grid = Array.isArray(node.attrs?.['grid'])
    ? (node.attrs?.['grid'] as number[]).map(pt)
    : [];
  const rows: FlowRow[] = (node.content ?? []).map((row, r) => ({
    id: str(row.attrs?.['id']) ?? `${id}/r${r}`,
    height: num(row.attrs?.['height']) !== null ? pt(num(row.attrs?.['height']) ?? 0) : null,
    heightRule: ((): FlowRow['heightRule'] => {
      const rule = str(attr(row, 'heightRule'));
      return rule === 'atLeast' || rule === 'exact' ? rule : 'auto';
    })(),
    cantSplit: bool(attr(row, 'cantSplit')) ?? false,
    header: r < headerRows,
    cells: (row.content ?? []).map((cell, c) => {
      const v = str(attr(cell, 'vAlign'));
      return {
        id: str(cell.attrs?.['id']) ?? `${id}/r${r}c${c}`,
        colspan: num(attr(cell, 'colspan')) ?? 1,
        rowspan: num(attr(cell, 'rowspan')) ?? 1,
        vAlign: v === 'center' || v === 'bottom' ? v : 'top',
        margins: insetsOf(cell.attrs?.['margins'], cellMargins),
        blocks: blocksOf(ctx, cell.content ?? [], tableStyle ?? 'TableNormal', regionId),
      };
    }),
  }));
  const align = str(node.attrs?.['align']);
  return {
    kind: 'table',
    id,
    columnWidths: grid,
    align: align === 'center' ? 'center' : align === 'end' ? 'right' : 'left',
    headerRows,
    cellMargins,
    bordered: styleValue('borders') !== null,
    rows,
    regionId,
  };
}

function blocksOf(
  ctx: Context,
  nodes: readonly CdmNode[],
  tableStyle: string | null,
  regionId: string | null,
): FlowBlock[] {
  const out: FlowBlock[] = [];
  for (const node of nodes) out.push(...blockOf(ctx, node, tableStyle, regionId));
  return out;
}

function lineHeightOf(font: FlowFont): number {
  return font.sizePt * 1.2;
}

function blockOf(
  ctx: Context,
  node: CdmNode,
  tableStyle: string | null,
  regionId: string | null,
): FlowBlock[] {
  const id = str(node.attrs?.['id']) ?? 'unidentified';
  const defaultScope = scopeOf(ctx, null, tableStyle);
  switch (node.type) {
    case 'paragraph':
      return paragraphOf(ctx, node, tableStyle, regionId);
    case 'table':
      return [tableOf(ctx, node, regionId)];
    case 'region':
      return blocksOf(ctx, node.content ?? [], tableStyle, str(node.attrs?.['id']));
    case 'figure': {
      const caption = (node.content ?? []).find((c) => c.type === 'caption');
      const align = str(node.attrs?.['align']);
      const box: FlowBox = {
        kind: 'box',
        id,
        what: 'figure',
        width: pt(num(node.attrs?.['width']) ?? 1440),
        height: pt(num(node.attrs?.['height']) ?? 1440),
        align: align === 'center' ? 'center' : align === 'end' ? 'right' : 'left',
        keepNext: caption !== undefined,
        regionId,
      };
      if (!caption) return [box];
      const scope = styleScope(ctx, 'Caption', tableStyle);
      const shape = paragraphShape(ctx, scope);
      // A figure has no spacing of its own (ADR 0032; CDM-043): its caption is part of the figure,
      // so the caption style's space after does not reach the block below it. The space before the
      // caption stays: it lies inside the figure, between the picture and its caption.
      const blocks = paragraphBlocks(ctx, caption.content ?? [], {
        id,
        scope,
        shape: { ...shape, spaceAfter: 0 },
        regionId,
        label: null,
      });
      const seqName = str(
        (caption.content ?? []).find((c) => c.type === 'field' && c.attrs?.['kind'] === 'seq')
          ?.attrs?.['name'],
      );
      const first = blocks[0];
      if (seqName && first?.kind === 'paragraph')
        ctx.captions.push({
          name: seqName,
          block: first,
          text: (caption.content ?? [])
            .map((c) => c.text ?? str(c.attrs?.['cached']) ?? '')
            .join(''),
        });
      return [box, ...blocks];
    }
    case 'equation_block': {
      // Stand-in height: two lines of the default paragraph style, until KaTeX measures (FE-069).
      const font = fontOf(ctx, defaultScope, []);
      return [
        {
          kind: 'box',
          id,
          what: 'equation',
          width: 0,
          height: 2 * lineHeightOf(font),
          align: 'center',
          keepNext: false,
          regionId,
        },
      ];
    }
    case 'preserved_block': {
      const width = num(node.attrs?.['width']);
      const height = num(node.attrs?.['height']);
      if (width && height)
        return [
          {
            kind: 'box',
            id,
            what: 'preserved',
            width: pt(width),
            height: pt(height),
            align: 'left',
            keepNext: false,
            regionId,
          },
        ];
      return fallbackParagraph(
        ctx,
        id,
        str(node.attrs?.['fallbackText']) ?? '[preserved]',
        defaultScope,
        regionId,
      );
    }
    case 'extension_block':
      return fallbackParagraph(
        ctx,
        id,
        str(node.attrs?.['fallbackText']) ?? '[extension]',
        defaultScope,
        regionId,
      );
    case 'toc':
      // Replaced by entry paragraphs once every heading is known (tocEntries).
      return [
        {
          kind: 'box',
          id,
          what: 'extension',
          width: 0,
          height: 0,
          align: 'left',
          keepNext: false,
          regionId,
        },
      ];
    default:
      return [];
  }
}

function fallbackParagraph(
  ctx: Context,
  id: string,
  text: string,
  scope: Scope,
  regionId: string | null,
): FlowBlock[] {
  const shape = paragraphShape(ctx, scope);
  return paragraphBlocks(ctx, [{ type: 'text', text }], {
    id,
    scope,
    shape,
    regionId,
    label: null,
  }).map((b) =>
    b.kind === 'paragraph'
      ? {
          ...b,
          end: 1,
          inlines: b.inlines.map((i) =>
            i.kind === 'text' ? { ...i, role: 'extension' as const, size: 1 } : i,
          ),
        }
      : b,
  );
}

/** Contents entries, generated at layout time (03 §4.3): one paragraph per heading or caption. */
function tocEntries(ctx: Context, node: CdmNode, regionId: string | null): FlowParagraph[] {
  const id = str(node.attrs?.['id']) ?? 'toc';
  const of = str(attr(node, 'of')) ?? 'headings';
  const min = num(attr(node, 'minLevel')) ?? 1;
  const max = num(attr(node, 'maxLevel')) ?? 3;
  const found =
    of === 'headings'
      ? ctx.headings
          .filter((h) => (h.block.outlineLevel ?? 0) >= min && (h.block.outlineLevel ?? 0) <= max)
          .map((h) => ({ text: h.text, level: h.block.outlineLevel ?? 1 }))
      : ctx.captions.filter((c) => c.name === of).map((c) => ({ text: c.text, level: 1 }));
  // An empty list still occupies its place, as Word's "No entries found" does.
  const items = found.length > 0 ? found : [{ text: 'No entries found.', level: 1 }];
  return items.map((item, part) => {
    const scope = styleScope(ctx, `TOC${Math.min(9, item.level)}`, null);
    const shape = paragraphShape(ctx, scope);
    const font = shape.markFont;
    return {
      kind: 'paragraph',
      id,
      part,
      start: 0,
      end: 1,
      generated: true,
      styleId: scope.styleId,
      outlineLevel: null,
      align: shape.align,
      indentLeft: shape.indentLeft,
      indentRight: shape.indentRight,
      indentFirstLine: shape.indentFirstLine,
      spaceBefore: shape.spaceBefore,
      spaceAfter: shape.spaceAfter,
      line: shape.line,
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
      widowControl: shape.widowControl,
      tabs: shape.tabs,
      markFont: font,
      inlines: [
        { kind: 'text', role: 'label', text: item.text, font, offset: 0, size: 0 },
        { kind: 'tab', font, offset: 0, size: 0 },
        { kind: 'text', role: 'label', text: '1', font, offset: 0, size: 0 },
      ],
      regionId,
    } satisfies FlowParagraph;
  });
}

function pageOf(setup: CdmNode): FlowPage {
  const n = (name: string, fallback: number): number => num(attr(setup, name)) ?? fallback;
  const s = (name: string): string | null => str(attr(setup, name));
  return {
    setupId: str(setup.attrs?.['id']) ?? 'page',
    width: pt(n('width', 11906)),
    height: pt(n('height', 16838)),
    marginTop: pt(n('marginTop', 1440)),
    marginRight: pt(n('marginRight', 1440)),
    marginBottom: pt(n('marginBottom', 1440)),
    marginLeft: pt(n('marginLeft', 1440)),
    headerDistance: pt(n('headerDistance', 708)),
    footerDistance: pt(n('footerDistance', 708)),
    columns: n('columns', 1),
    columnGap: pt(n('columnGap', 720)),
    differentFirstPage: bool(attr(setup, 'differentFirstPage')) ?? false,
    differentOddEven: bool(attr(setup, 'differentOddEven')) ?? false,
    headers: { default: s('headerDefault'), first: s('headerFirst'), even: s('headerEven') },
    footers: { default: s('footerDefault'), first: s('footerFirst'), even: s('footerEven') },
    pageNumberStart: num(attr(setup, 'pageNumberStart')),
    pageNumberFormat: s('pageNumberFormat'),
  };
}

/**
 * The gaps between adjacent paragraphs, as `paragraphGap` in `@docedit/model` computes them
 * (CDM-043, 03 §7, ADR 0032). Contextual spacing is per side: when two neighbours have the same
 * style, a paragraph whose contextualSpacing is on drops its own space on the side facing the
 * other. The gap is then the larger of the upper paragraph's spaceAfter and the lower one's
 * spaceBefore. Engines add spaceAfter and spaceBefore, so the lower paragraph keeps its (possibly
 * dropped) spaceBefore and the upper one keeps only the part of the gap the lower one does not
 * supply.
 */
function applyContextualSpacing(
  blocks: readonly FlowBlock[],
  contextual: ReadonlySet<FlowBlock>,
): FlowBlock[] {
  const out = blocks.slice();
  for (let i = 0; i + 1 < blocks.length; i++) {
    // Read the sides from the input blocks; `out` may already carry this pass's changes.
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a?.kind !== 'paragraph' || b?.kind !== 'paragraph') continue;
    const same = a.styleId === b.styleId;
    const after = same && contextual.has(a) ? 0 : a.spaceAfter;
    const before = same && contextual.has(b) ? 0 : b.spaceBefore;
    const gap = Math.max(after, before);
    out[i] = { ...(out[i] as FlowParagraph), spaceAfter: gap - before };
    out[i + 1] = { ...(out[i + 1] as FlowParagraph), spaceBefore: before };
  }
  return out;
}

/**
 * Applies the gap rule to one list of blocks and to every table cell in it (CDM-043 pass (a):
 * paragraphs in cells follow the same rule as paragraphs in the body and in stories).
 */
function spaceBlocks(
  blocks: readonly FlowBlock[],
  contextual: ReadonlySet<FlowBlock>,
): FlowBlock[] {
  return applyContextualSpacing(blocks, contextual).map((b) =>
    b.kind === 'table'
      ? {
          ...b,
          rows: b.rows.map((row) => ({
            ...row,
            cells: row.cells.map((cell) => ({
              ...cell,
              blocks: spaceBlocks(cell.blocks, contextual),
            })),
          })),
        }
      : b,
  );
}

/** Converts a CDM envelope into flow blocks. */
export function toFlow(envelope: CdmEnvelopeLike): FlowDocument {
  const doc = envelope.doc;
  const defs = doc.content?.find((n) => n.type === 'defs');
  const body = doc.content?.find((n) => n.type === 'body');
  const settings = defs?.content?.find((n) => n.type === 'settings');
  const pageSetups = new Map<string, CdmNode>();
  for (const d of defs?.content ?? [])
    if (d.type === 'page_setup') pageSetups.set(str(d.attrs?.['id']) ?? '', d);
  const labels = computeLabels(doc as unknown as Parameters<typeof computeLabels>[0]);
  const ctx: Context = {
    table: tolerantTable(styleTable(doc as unknown as Parameters<typeof styleTable>[0])),
    pageSetups,
    notes: new Map(),
    headings: [],
    captions: [],
    footnoteFormat: (settings && str(attr(settings, 'footnoteFormat'))) ?? 'decimal',
    docLang: (settings && str(attr(settings, 'lang'))) ?? null,
    footnoteLabels: labels.footnotes,
    listLabels: new Map([...labels.lists].map(([paragraph, list]) => [paragraph, list.text])),
    contextual: new Set<FlowBlock>(),
  };
  const firstSetup =
    pageSetups.get(str(body?.attrs?.['pageSetup']) ?? '') ?? [...pageSetups.values()][0];
  const sections: {
    breakId: string | null;
    start: FlowSection['start'];
    setup: CdmNode | undefined;
    blocks: FlowBlock[];
  }[] = [{ breakId: null, start: 'nextPage', setup: firstSetup, blocks: [] }];
  const tocs: { section: number; index: number; node: CdmNode; regionId: string | null }[] = [];
  const visit = (node: CdmNode, regionId: string | null): void => {
    const current = sections[sections.length - 1];
    if (!current) return;
    if (node.type === 'section_break') {
      const start = str(attr(node, 'start'));
      sections.push({
        breakId: str(node.attrs?.['id']),
        start:
          start === 'continuous' || start === 'evenPage' || start === 'oddPage'
            ? start
            : 'nextPage',
        setup: pageSetups.get(str(node.attrs?.['pageSetup']) ?? '') ?? current.setup,
        blocks: [],
      });
      return;
    }
    if (node.type === 'region') {
      for (const child of node.content ?? []) visit(child, str(node.attrs?.['id']));
      return;
    }
    if (node.type === 'toc')
      tocs.push({ section: sections.length - 1, index: current.blocks.length, node, regionId });
    current.blocks.push(...blockOf(ctx, node, null, regionId));
  };
  for (const node of body?.content ?? []) visit(node, null);
  // Contents entries replace their placeholders, last first so that indexes stay valid.
  for (const t of tocs.reverse())
    sections[t.section]?.blocks.splice(t.index, 1, ...tocEntries(ctx, t.node, t.regionId));
  const stories = new Map<string, readonly FlowBlock[]>();
  for (const story of doc.content ?? [])
    if (story.type === 'story')
      stories.set(
        str(story.attrs?.['id']) ?? '',
        spaceBlocks(blocksOf(ctx, story.content ?? [], null, null), ctx.contextual),
      );
  const fallbackSetup: CdmNode = { type: 'page_setup', attrs: { id: 'default' } };
  // Section breaks are transparent (ADR 0032): the gap rule runs once over the whole body, so a
  // paragraph before a break and one after it share a gap as they would without the break.
  const flat = spaceBlocks(
    sections.flatMap((s) => s.blocks),
    ctx.contextual,
  );
  let at = 0;
  return {
    sections: sections.map((s) => {
      const blocks = flat.slice(at, at + s.blocks.length);
      at += s.blocks.length;
      return {
        breakId: s.breakId,
        start: s.start,
        page: pageOf(s.setup ?? fallbackSetup),
        blocks,
      };
    }),
    stories,
    notes: ctx.notes,
    defaultTabStop: pt((settings && num(attr(settings, 'defaultTabStop'))) ?? 720),
  };
}

/** Visits every paragraph of a flow document, in tables and stories too. */
export function* flowParagraphs(blocks: readonly FlowBlock[]): Generator<FlowParagraph> {
  for (const b of blocks) {
    if (b.kind === 'paragraph') yield b;
    else if (b.kind === 'table')
      for (const row of b.rows) for (const cell of row.cells) yield* flowParagraphs(cell.blocks);
  }
}
