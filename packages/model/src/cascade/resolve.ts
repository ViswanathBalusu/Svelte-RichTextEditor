/**
 * The formatting cascade of 03 §6 (CDM-041), resolved once for the editor, the layout engine and
 * the LaTeX and DOCX writers. Later layers override earlier ones:
 *
 *   0. the base values below, with `settings.dir` and `settings.lang`;
 *   1. the default paragraph style, through its `basedOn` chain;
 *   2. the table style, for content inside a table;
 *   3. the numbering level's paragraph properties (`indentLeft`, and `hanging` as a negative
 *      `indentFirstLine`), for numbered paragraphs;
 *   4. the paragraph style chain, from the root of `basedOn` to the style itself;
 *   5. direct paragraph attributes;
 *   6. for runs: the run properties of the resolved paragraph (layers 0 to 4);
 *   7. the character style chain of the `charStyle` mark;
 *   8. direct marks; a toggle mark with `value: false` switches the property off.
 *
 * A style contributes once, at the first layer that reaches it: a style that the default
 * paragraph style's chain already applied in layer 1 is not applied again in layers 2 or 4. A null
 * value means "not set here; inherit" and is skipped. Properties are resolved one by one; `tabs`,
 * `borders`, `shading` and `numbering` are whole values, so the last layer that sets one gives all
 * of it. The decisions are recorded in docs/adr/0032-layout-semantics.md.
 *
 * Every function is pure and returns new or shared frozen values; nothing writes resolved values
 * into the document (03 §1 principle 5). Results are cached per style table, so a table must not be
 * changed after it is built: build a new one with `styleTable` when the definitions change.
 */
import type { StyleDefAttrs } from '../generated/types.ts';
import {
  type Attrs,
  type CascadeError,
  type MarkLike,
  type StyleTable,
  paragraphStyleOf,
  styleChain,
} from './styles.ts';

export type Alignment = 'start' | 'center' | 'end' | 'justify' | 'distribute';
export type LineRule = 'multiple' | 'exact' | 'atLeast';
export type TabAlignment = 'left' | 'center' | 'right' | 'decimal';
export type TabLeader = 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot' | 'heavy';
export type Borders = NonNullable<StyleDefAttrs['borders']>;
export type Shading = NonNullable<StyleDefAttrs['shading']>;

export interface TabStop {
  /** Twips from the left margin (03 §7). */
  readonly position: number;
  readonly align: TabAlignment;
  readonly leader: TabLeader;
}

/** A paragraph's list membership (03 §4.3). */
export interface NumberingRef {
  readonly numberingId: string;
  readonly level: number;
  readonly listId: string;
}

/** The paragraph properties of 03 §4.5, every one resolved. */
export interface ParagraphProperties {
  readonly align: Alignment;
  readonly dir: 'ltr' | 'rtl';
  readonly indentLeft: number;
  readonly indentRight: number;
  readonly indentFirstLine: number;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly contextualSpacing: boolean;
  readonly lineSpacing: number;
  readonly lineRule: LineRule;
  readonly keepNext: boolean;
  readonly keepLines: boolean;
  readonly pageBreakBefore: boolean;
  readonly widowControl: boolean;
  readonly tabs: readonly TabStop[];
  readonly borders: Borders | null;
  readonly shading: Shading | null;
}

/** The run properties of 03 §4.5, every one resolved. */
export interface RunProperties {
  /** Null when no layer names a font: the font registry's default face (FE, EXP). */
  readonly fontFamily: string | null;
  readonly fontSize: number;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: 'single' | 'double' | 'dotted' | 'none';
  readonly strike: boolean;
  readonly smallCaps: boolean;
  readonly allCaps: boolean;
  readonly vertAlign: 'super' | 'sub' | 'baseline';
  /** Null means automatic. */
  readonly color: string | null;
  readonly highlight: string | null;
  readonly lang: string | null;
  readonly hidden: boolean;
}

export const RUN_PROPERTIES = [
  'fontFamily',
  'fontSize',
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'vertAlign',
  'color',
  'highlight',
  'lang',
  'hidden',
] as const satisfies readonly (keyof RunProperties)[];

export const PARAGRAPH_PROPERTIES = [
  'align',
  'dir',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'contextualSpacing',
  'lineSpacing',
  'lineRule',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
  'tabs',
  'borders',
  'shading',
] as const satisfies readonly (keyof ParagraphProperties)[];

/**
 * Layer 0: what a property is when no layer sets it (ADR 0032). `dir` and `lang` come from
 * `settings` instead. A DOCX writer states these values in `w:docDefaults`, so that Word starts
 * from the same base.
 */
export const BASE_PARAGRAPH: ParagraphProperties = Object.freeze({
  align: 'start',
  dir: 'ltr',
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  contextualSpacing: false,
  lineSpacing: 1000,
  lineRule: 'multiple',
  keepNext: false,
  keepLines: false,
  pageBreakBefore: false,
  widowControl: true,
  tabs: Object.freeze([]) as readonly TabStop[],
  borders: null,
  shading: null,
});

export const BASE_RUN: RunProperties = Object.freeze({
  fontFamily: null,
  fontSize: 220,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  smallCaps: false,
  allCaps: false,
  vertAlign: 'baseline',
  color: null,
  highlight: null,
  lang: null,
  hidden: false,
});

/** Where a property's value came from, for traces and for reviewing the fixtures. */
export type Layer =
  | 'base'
  | 'settings'
  | 'default style'
  | 'table style'
  | 'numbering level'
  | 'paragraph style'
  | 'direct'
  | 'paragraph'
  | 'character style'
  | 'mark';

export interface ResolvedParagraph {
  /** The paragraph's style: its own, or the default paragraph style. */
  readonly styleId: string;
  /** 1 to 9 for a heading (through the paragraph style chain), else null. */
  readonly outlineLevel: number | null;
  /** The numbering that applies: the paragraph's own, else its styles' (layers 1, 2 and 4). */
  readonly numbering: NumberingRef | null;
  /** The numbering level object, when the numbering resolves to one. */
  readonly level: Attrs | null;
  readonly properties: ParagraphProperties;
  /** Layer 6: the paragraph's run properties, which are also those of its paragraph mark. */
  readonly run: RunProperties;
  /** Present when resolved with `{ trace: true }`. */
  readonly trace?: Readonly<Record<string, Layer>>;
}

export type CascadeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CascadeError };

export interface ParagraphContext {
  /** The style of the table the paragraph is in (layer 2); null or absent outside tables. */
  readonly tableStyle?: string | null | undefined;
  /** Record which layer gave each property (slower; for tests, fixtures and diagnostics). */
  readonly trace?: boolean | undefined;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Values = Mutable<ParagraphProperties & RunProperties>;

interface Layered {
  /** Layers 0 to 2 applied. */
  readonly low: Readonly<Values>;
  /** Layer 4 alone: only the properties its styles set. */
  readonly high: Readonly<Partial<Values>>;
  readonly lowTrace: Readonly<Record<string, Layer>>;
  readonly highTrace: Readonly<Record<string, Layer>>;
  /** The style-level numbering (layers 1, 2 and 4), or null. */
  readonly numbering: NumberingRef | null;
  readonly outlineLevel: number | null;
}

const STYLE_KEYS: readonly (keyof Values)[] = [...PARAGRAPH_PROPERTIES, ...RUN_PROPERTIES];
const DIRECT_KEYS: readonly (keyof ParagraphProperties)[] = PARAGRAPH_PROPERTIES;

const layeredCache = new WeakMap<StyleTable, Map<string, CascadeResult<Layered>>>();
const paragraphCache = new WeakMap<StyleTable, Map<string, ResolvedParagraph>>();

function cacheOf<T>(map: WeakMap<StyleTable, Map<string, T>>, table: StyleTable): Map<string, T> {
  let m = map.get(table);
  if (!m) {
    m = new Map();
    map.set(table, m);
  }
  return m;
}

function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function overlay(
  target: Partial<Values>,
  trace: Record<string, Layer>,
  attrs: Attrs | undefined,
  keys: readonly (keyof Values)[],
  layer: Layer,
): void {
  if (!attrs) return;
  const t = target as Record<string, unknown>;
  for (const k of keys) {
    const v = attrs[k];
    if (isSet(v)) {
      t[k] = v;
      trace[k] = layer;
    }
  }
}

function asNumbering(value: unknown): NumberingRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Attrs;
  const { numberingId, level, listId } = v;
  if (typeof numberingId !== 'string' || typeof level !== 'number' || typeof listId !== 'string')
    return null;
  return { numberingId, level, listId };
}

/** Layers 0, 1, 2 and 4 for a style in a table style, cached per table. */
function layered(
  table: StyleTable,
  styleId: string,
  tableStyle: string | null,
): CascadeResult<Layered> {
  const cache = cacheOf(layeredCache, table);
  const key = `${styleId}\u0000${tableStyle ?? ''}`;
  const known = cache.get(key);
  if (known) return known;
  const result = computeLayered(table, styleId, tableStyle);
  cache.set(key, result);
  return result;
}

function computeLayered(
  table: StyleTable,
  styleId: string,
  tableStyle: string | null,
): CascadeResult<Layered> {
  const def = styleChain(table, table.defaultParagraphStyle);
  if (!def.ok) return def;
  const tab = tableStyle === null ? null : styleChain(table, tableStyle);
  if (tab && !tab.ok) return tab;
  const own = styleChain(table, styleId);
  if (!own.ok) return own;

  const low: Values = { ...BASE_PARAGRAPH, ...BASE_RUN };
  const lowTrace: Record<string, Layer> = {};
  for (const k of STYLE_KEYS) lowTrace[k] = 'base';
  low.dir = table.settings.dir;
  low.lang = table.settings.lang;
  lowTrace['dir'] = 'settings';
  lowTrace['lang'] = 'settings';

  // A style contributes once, at the first layer that reaches it.
  const applied = new Set<string>();
  let numbering: NumberingRef | null = null;
  const apply = (
    ids: readonly string[],
    into: Partial<Values>,
    trace: Record<string, Layer>,
    layer: Layer,
  ): void => {
    for (const id of ids) {
      if (applied.has(id)) continue;
      applied.add(id);
      const style = table.styles.get(id);
      overlay(into, trace, style, STYLE_KEYS, layer);
      numbering = asNumbering(style?.['numbering']) ?? numbering;
    }
  };
  apply(def.chain, low, lowTrace, 'default style');
  if (tab) apply(tab.chain, low, lowTrace, 'table style');
  const high: Partial<Values> = {};
  const highTrace: Record<string, Layer> = {};
  apply(own.chain, high, highTrace, 'paragraph style');

  let outlineLevel: number | null = null;
  for (const id of own.chain) {
    const level = table.styles.get(id)?.['outlineLevel'];
    if (typeof level === 'number') outlineLevel = level;
  }
  return {
    ok: true,
    value: { low, high, lowTrace, highTrace, numbering, outlineLevel },
  };
}

/** The numbering level object of a numbering, or null when the definition or level is missing. */
export function numberingLevel(table: StyleTable, numbering: NumberingRef | null): Attrs | null {
  if (!numbering) return null;
  return table.numberings.get(numbering.numberingId)?.[numbering.level] ?? null;
}

/**
 * The numbering that applies to a paragraph: its own `numbering`, else the last one its styles set
 * in layers 1, 2 and 4. Cheaper than `resolveParagraph` when only the list membership is needed.
 */
export function paragraphNumbering(
  table: StyleTable,
  paragraphAttrs: Attrs | undefined,
  tableStyle: string | null = null,
): CascadeResult<NumberingRef | null> {
  const own = asNumbering(paragraphAttrs?.['numbering']);
  if (own) return { ok: true, value: own };
  const base = layered(table, paragraphStyleOf(table, paragraphAttrs), tableStyle);
  return base.ok ? { ok: true, value: base.value.numbering } : base;
}

function hasDirect(attrs: Attrs | undefined): boolean {
  if (!attrs) return false;
  for (const k of DIRECT_KEYS) if (isSet(attrs[k])) return true;
  return false;
}

/** Resolves a paragraph's properties through layers 0 to 5 (and its run properties, layer 6). */
export function resolveParagraph(
  table: StyleTable,
  paragraphAttrs: Attrs | undefined,
  context: ParagraphContext = {},
): CascadeResult<ResolvedParagraph> {
  const styleId = paragraphStyleOf(table, paragraphAttrs);
  const tableStyle = context.tableStyle ?? null;
  const base = layered(table, styleId, tableStyle);
  if (!base.ok) return base;
  const l = base.value;
  const numbering = asNumbering(paragraphAttrs?.['numbering']) ?? l.numbering;
  const level = numberingLevel(table, numbering);
  const direct = hasDirect(paragraphAttrs);
  const trace = context.trace === true;

  // Paragraphs without direct formatting share one frozen result per style, table style and level.
  const key =
    direct || trace
      ? null
      : `${styleId}\u0000${tableStyle ?? ''}\u0000${numbering ? `${numbering.numberingId}\u0000${numbering.level}\u0000${numbering.listId}` : ''}`;
  if (key !== null) {
    const known = cacheOf(paragraphCache, table).get(key);
    if (known) return { ok: true, value: known };
  }

  const v: Values = { ...l.low };
  const t: Record<string, Layer> = trace ? { ...l.lowTrace } : {};
  if (level) {
    // Layer 3: the level's indents. Its `align` places the label and its `runProps` format the
    // label only (ADR 0032), so neither is a paragraph property.
    if (typeof level['indentLeft'] === 'number') {
      v.indentLeft = level['indentLeft'];
      t['indentLeft'] = 'numbering level';
    }
    if (typeof level['hanging'] === 'number') {
      v.indentFirstLine = -level['hanging'];
      t['indentFirstLine'] = 'numbering level';
    }
  }
  Object.assign(v, l.high);
  if (trace) Object.assign(t, l.highTrace);
  if (direct) overlay(v, t, paragraphAttrs, DIRECT_KEYS, 'direct');
  if (Array.isArray(v.tabs)) v.tabs = sortTabs(v.tabs);

  const properties: ParagraphProperties = Object.freeze({
    align: v.align,
    dir: v.dir,
    indentLeft: v.indentLeft,
    indentRight: v.indentRight,
    indentFirstLine: v.indentFirstLine,
    spaceBefore: v.spaceBefore,
    spaceAfter: v.spaceAfter,
    contextualSpacing: v.contextualSpacing,
    lineSpacing: v.lineSpacing,
    lineRule: v.lineRule,
    keepNext: v.keepNext,
    keepLines: v.keepLines,
    pageBreakBefore: v.pageBreakBefore,
    widowControl: v.widowControl,
    tabs: v.tabs,
    borders: v.borders,
    shading: v.shading,
  });
  const run: RunProperties = Object.freeze({
    fontFamily: v.fontFamily,
    fontSize: v.fontSize,
    bold: v.bold,
    italic: v.italic,
    underline: v.underline,
    strike: v.strike,
    smallCaps: v.smallCaps,
    allCaps: v.allCaps,
    vertAlign: v.vertAlign,
    color: v.color,
    highlight: v.highlight,
    lang: v.lang,
    hidden: v.hidden,
  });
  const value: ResolvedParagraph = Object.freeze({
    styleId,
    outlineLevel: l.outlineLevel,
    numbering,
    level,
    properties,
    run,
    ...(trace ? { trace: Object.freeze(t) } : {}),
  });
  if (key !== null) cacheOf(paragraphCache, table).set(key, value);
  return { ok: true, value };
}

/**
 * Tab stops in position order. When two stops share a position, the later one in the list wins,
 * so a list can be read as "set in this order" (ADR 0032).
 */
export function sortTabs(tabs: readonly TabStop[]): readonly TabStop[] {
  const byPosition = new Map<number, TabStop>();
  for (const t of tabs) byPosition.set(t.position, t);
  return Object.freeze([...byPosition.values()].sort((a, b) => a.position - b.position));
}

const TOGGLES = new Set(['bold', 'italic', 'strike', 'smallCaps', 'allCaps', 'hidden']);
const VALUED = new Set(['vertAlign', 'fontFamily', 'fontSize', 'color', 'highlight', 'lang']);

export interface ResolvedRun extends RunProperties {
  readonly trace?: Readonly<Record<string, Layer>>;
}

/**
 * Resolves a run's properties: the paragraph's run properties (layer 6), the character style
 * chain (layer 7), then the direct marks (layer 8). Marks that do not format (`link`, `ins`, `del`,
 * `fmt`, `preserved`) are ignored; a `fmt` suggestion shows the formatting it suggests.
 */
export function resolveRun(
  table: StyleTable,
  paragraph: ResolvedParagraph,
  marks: readonly MarkLike[] | undefined,
  options: { readonly trace?: boolean } = {},
): CascadeResult<ResolvedRun> {
  const trace = options.trace === true;
  if (!marks?.length && !trace) return { ok: true, value: paragraph.run };
  const r: Mutable<RunProperties> = { ...paragraph.run };
  const t: Record<string, Layer> = {};
  if (trace) for (const k of RUN_PROPERTIES) t[k] = 'paragraph';
  const charStyle = marks?.find((m) => m.type === 'charStyle')?.attrs?.['style'];
  if (typeof charStyle === 'string') {
    const chain = styleChain(table, charStyle);
    if (!chain.ok) return chain;
    for (const id of chain.chain)
      overlay(r, t, table.styles.get(id), RUN_PROPERTIES, 'character style');
  }
  const out = r as Record<string, unknown>;
  for (const m of marks ?? []) {
    if (TOGGLES.has(m.type)) {
      out[m.type] = m.attrs?.['value'] !== false;
      t[m.type] = 'mark';
    } else if (m.type === 'underline') {
      const style = m.attrs?.['style'];
      out['underline'] = typeof style === 'string' ? style : 'single';
      t['underline'] = 'mark';
    } else if (VALUED.has(m.type)) {
      const value = m.attrs?.['value'];
      if (isSet(value)) {
        out[m.type] = value;
        t[m.type] = 'mark';
      }
    }
  }
  return { ok: true, value: Object.freeze(trace ? { ...r, trace: Object.freeze(t) } : r) };
}

/**
 * The run properties of a numbering label: the paragraph's run properties with the level's
 * `runProps` over them (ADR 0032). Bullet characters and numbers are formatted alike.
 */
export function resolveLabelRun(paragraph: ResolvedParagraph): RunProperties {
  const props = paragraph.level?.['runProps'];
  if (typeof props !== 'object' || props === null) return paragraph.run;
  const r: Mutable<RunProperties> = { ...paragraph.run };
  overlay(r, {}, props as Attrs, RUN_PROPERTIES, 'numbering level');
  return Object.freeze(r);
}
