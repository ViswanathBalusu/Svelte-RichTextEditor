/**
 * What the ruler and the paragraph dialog show (UX-102; 13 §2; 03 §4.5, §7): the indents and the
 * tab stops of the paragraphs the selection covers, the document's default tab interval, and the
 * page of the section the selection starts in, which is the page the PDF sets the text on.
 *
 * The values are the paragraphs' own, the ones `setParagraphFormat` writes. A paragraph that sets
 * none counts as 0 and as no tab stops. What a paragraph style gives is not resolved here, as it is
 * not drawn in the web view either (FE-129 Notes). A value the selected paragraphs do not share is
 * null. Lengths are twips, as the CDM stores them.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { defaultTabStopOf } from './paragraph-indent.ts';
import { pageSetupPos } from './page-setup-commands.ts';
import { selectedParagraphs } from './styles.ts';

export type TabAlign = 'left' | 'center' | 'right' | 'decimal';
export type TabLeader = 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot' | 'heavy';

/** One tab stop of a paragraph (03 §7): its place from the left margin, in twips. */
export interface TabStopInfo {
  readonly position: number;
  readonly align: TabAlign;
  readonly leader: TabLeader;
}

/** The page of a section as the PDF sets it (03 §4.1 `page_setup`), in twips. */
export interface PageColumnInfo {
  readonly width: number;
  readonly marginLeft: number;
  readonly marginRight: number;
}

export type ParagraphBorderSide = 'top' | 'bottom' | 'left' | 'right' | 'between';
export type ParagraphBorderStyle = 'none' | 'single' | 'double' | 'dotted' | 'dashed' | 'thick';

/** One border of a paragraph (03 §4.5): width in eighths of a point, space in twentieths. */
export interface ParagraphBorderInfo {
  readonly style: ParagraphBorderStyle;
  readonly width?: number;
  readonly color?: string | null;
  readonly space?: number;
}

/**
 * The other options of the paragraph dialog (FE-129 criterion 6): what `setParagraphFormat` sets
 * besides the indents and tab stops. Each value is the first selected paragraph's own, with the
 * CDM's default when it sets none; `mixed` names the options the selected paragraphs do not share.
 */
export interface ParagraphOptionsInfo {
  readonly align: 'start' | 'center' | 'end' | 'justify' | 'distribute';
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly lineSpacing: number;
  readonly lineRule: 'multiple' | 'exact' | 'atLeast';
  readonly keepNext: boolean;
  readonly keepLines: boolean;
  readonly pageBreakBefore: boolean;
  readonly widowControl: boolean;
  readonly contextualSpacing: boolean;
  /** The sides that have a border, by side; a side with none is absent. */
  readonly borders: Readonly<Partial<Record<ParagraphBorderSide, ParagraphBorderInfo>>>;
  /** The fill colour (`#RRGGBB`) of the shading; null for none. */
  readonly shading: string | null;
  readonly mixed: readonly string[];
}

export interface ParagraphFormatInfo {
  /** How many paragraphs the selection covers. */
  readonly count: number;
  /** The left indent; null when the paragraphs differ. */
  readonly indentLeft: number | null;
  /** The right indent; null when the paragraphs differ. */
  readonly indentRight: number | null;
  /** The first-line indent, from the left indent; negative for a hanging indent; null when they differ. */
  readonly indentFirstLine: number | null;
  /** The tab stops, by position; null when the paragraphs differ. */
  readonly tabs: readonly TabStopInfo[] | null;
  /** `settings.defaultTabStop`: where a tab goes when no tab stop lies ahead. */
  readonly defaultTabStop: number;
  /** The page of the section the selection starts in; null when the document names none. */
  readonly page: PageColumnInfo | null;
  /** Whether `setParagraphFormat` may change these paragraphs now. */
  readonly editable: boolean;
  /** Alignment, spacing, keep rules, borders and shading, for the paragraph dialog. */
  readonly options: ParagraphOptionsInfo;
}

const ALIGNS: readonly unknown[] = ['left', 'center', 'right', 'decimal'];
const LEADERS: readonly unknown[] = ['none', 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'];

/** The tab stops a paragraph stores, by position; a stop that is not of the grammar is left out. */
export function tabStopsOf(attrs: Readonly<Record<string, unknown>>): TabStopInfo[] {
  const value = attrs['tabs'];
  if (!Array.isArray(value)) return [];
  const out: TabStopInfo[] = [];
  for (const tab of value as unknown[]) {
    if (tab === null || typeof tab !== 'object') continue;
    const { position, align, leader } = tab as Record<string, unknown>;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) continue;
    if (!ALIGNS.includes(align) || !LEADERS.includes(leader)) continue;
    out.push({ position, align: align as TabAlign, leader: leader as TabLeader });
  }
  return out.sort((a, b) => a.position - b.position);
}

const length = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) ? v : 0);

/**
 * The page setup of the section a position of the body is in: the one the last section break before
 * it names, else the body's own. Null outside the body, or when the definition is not there.
 */
export function pageColumnAt(state: EditorState, pos: number): PageColumnInfo | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  let body: PMNode | null = null;
  let index = 0;
  for (let depth = $pos.depth; depth >= 0; depth--) {
    if ($pos.node(depth).type.name !== 'body') continue;
    body = $pos.node(depth);
    index = $pos.index(depth);
    break;
  }
  if (body === null) return null;
  let setup: unknown = body.attrs['pageSetup'];
  for (let i = 0; i < index && i < body.childCount; i++) {
    const child = body.child(i);
    if (child.type.name === 'section_break') setup = child.attrs['pageSetup'];
  }
  if (typeof setup !== 'string') return null;
  const at = pageSetupPos(state.doc, setup);
  const def = at === null ? null : state.doc.nodeAt(at);
  if (!def) return null;
  // The gutter is part of the inner margin; on a page of one side that is the left one.
  return {
    width: length(def.attrs['width']),
    marginLeft: length(def.attrs['marginLeft']) + length(def.attrs['gutter']),
    marginRight: length(def.attrs['marginRight']),
  };
}

const OWN_ALIGNS = ['start', 'center', 'end', 'justify', 'distribute'] as const;
const OWN_RULES = ['multiple', 'exact', 'atLeast'] as const;
const BORDER_STYLES: readonly unknown[] = ['none', 'single', 'double', 'dotted', 'dashed', 'thick'];
const BORDER_SIDES: readonly ParagraphBorderSide[] = ['top', 'bottom', 'left', 'right', 'between'];

/** The borders a paragraph stores, as sides that have one (a side of style `none` has none). */
export function bordersOf(
  attrs: Readonly<Record<string, unknown>>,
): Partial<Record<ParagraphBorderSide, ParagraphBorderInfo>> {
  const value = attrs['borders'];
  const out: Partial<Record<ParagraphBorderSide, ParagraphBorderInfo>> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const side of BORDER_SIDES) {
    const b = (value as Record<string, unknown>)[side];
    if (b === null || typeof b !== 'object') continue;
    const { style, width, color, space } = b as Record<string, unknown>;
    if (!BORDER_STYLES.includes(style) || style === 'none') continue;
    out[side] = {
      style: style as ParagraphBorderStyle,
      ...(typeof width === 'number' ? { width } : {}),
      ...(typeof color === 'string' || color === null ? { color } : {}),
      ...(typeof space === 'number' ? { space } : {}),
    };
  }
  return out;
}

function shadingOf(attrs: Readonly<Record<string, unknown>>): string | null {
  const s = attrs['shading'];
  if (s === null || typeof s !== 'object') return null;
  const fill = (s as Record<string, unknown>)['fill'];
  return typeof fill === 'string' ? fill : null;
}

/** The options of the paragraph dialog of the selected paragraphs (see `ParagraphOptionsInfo`). */
export function paragraphOptionsInfo(
  paragraphs: readonly { node: PMNode }[],
): ParagraphOptionsInfo {
  const of = (attrs: Readonly<Record<string, unknown>>) => {
    const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T =>
      allowed.includes(v as T) ? (v as T) : fallback;
    const flag = (key: string, fallback: boolean): boolean =>
      typeof attrs[key] === 'boolean' ? (attrs[key] as boolean) : fallback;
    return {
      align: pick(attrs['align'], OWN_ALIGNS, 'start'),
      spaceBefore: length(attrs['spaceBefore']),
      spaceAfter: length(attrs['spaceAfter']),
      lineSpacing:
        typeof attrs['lineSpacing'] === 'number' && Number.isInteger(attrs['lineSpacing'])
          ? attrs['lineSpacing']
          : 1000,
      lineRule: pick(attrs['lineRule'], OWN_RULES, 'multiple'),
      keepNext: flag('keepNext', false),
      keepLines: flag('keepLines', false),
      pageBreakBefore: flag('pageBreakBefore', false),
      widowControl: flag('widowControl', true),
      contextualSpacing: flag('contextualSpacing', false),
      borders: bordersOf(attrs),
      shading: shadingOf(attrs),
    } as const;
  };
  const all = paragraphs.map(({ node }) => of(node.attrs));
  const first = all[0] ?? of({});
  const mixed = (Object.keys(first) as (keyof typeof first)[]).filter((key) => {
    const was = JSON.stringify(first[key]);
    return all.some((o) => JSON.stringify(o[key]) !== was);
  });
  return { ...first, mixed };
}

/** The format of the selected paragraphs, or null when the selection covers no paragraph. */
export function paragraphFormatInfo(
  state: EditorState,
  editable: boolean,
): ParagraphFormatInfo | null {
  const paragraphs = selectedParagraphs(state);
  const first = paragraphs[0];
  if (!first) return null;
  const shared = (key: string): number | null => {
    const value = length(first.node.attrs[key]);
    return paragraphs.every(({ node }) => length(node.attrs[key]) === value) ? value : null;
  };
  const tabs = tabStopsOf(first.node.attrs);
  const tabsKey = JSON.stringify(tabs);
  const sameTabs = paragraphs.every(
    ({ node }) => JSON.stringify(tabStopsOf(node.attrs)) === tabsKey,
  );
  return {
    count: paragraphs.length,
    indentLeft: shared('indentLeft'),
    indentRight: shared('indentRight'),
    indentFirstLine: shared('indentFirstLine'),
    tabs: sameTabs ? tabs : null,
    defaultTabStop: defaultTabStopOf(state.doc),
    page: pageColumnAt(state, state.selection.from),
    editable,
    options: paragraphOptionsInfo(paragraphs),
  };
}
