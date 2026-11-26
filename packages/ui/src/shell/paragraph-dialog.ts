/**
 * What the paragraph dialog shows and the patch it makes (UX-102 criterion 3; 02 §10; FE-104,
 * FE-129): the keyboard form of every drag on the ruler. It sets the same indents and tab stops
 * through the same `setParagraphFormat` command, so a change made here is the change the ruler's
 * drag would make. No DOM here.
 *
 * Lengths are typed in centimetres and stored in twips. A field left blank keeps what the selected
 * paragraphs have; a blank field for a value they share means 0.
 */
import type {
  ParagraphBorderSideView,
  ParagraphBorderView,
  ParagraphFormatView,
  ParagraphOptionsView,
  TabStopView,
} from '../core-api.ts';
import { MAX_TABS, MAX_TWIPS, centimetres, fromCentimetres, normaliseTabs } from './ruler.ts';

export interface TabRow {
  /** Centimetres, as typed. */
  position: string;
  align: TabStopView['align'];
  leader: TabStopView['leader'];
}

/** A check box: on, off, or the paragraphs differ and it has not been touched. */
export type Tri = boolean | 'mixed';

/** One border as typed: style, then width, colour and space as text ('' for none). */
export interface BorderRow {
  style: ParagraphBorderView['style'];
  /** Points. */
  width: string;
  /** `#RRGGBB`; blank for the automatic colour. */
  color: string;
  /** Points. */
  space: string;
}

export const BORDER_SIDES: readonly ParagraphBorderSideView[] = [
  'top',
  'bottom',
  'left',
  'right',
  'between',
];

export const TRI_OPTIONS = [
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
  'contextualSpacing',
] as const;

/**
 * The other options of the dialog (FE-129 criterion 6). Lengths of spacing are typed in points;
 * line spacing is typed in lines under the rule `multiple` and in points under the others. A text
 * or choice field is blank when the paragraphs differ, as the indents are.
 */
export interface OptionFields {
  align: string;
  spaceBefore: string;
  spaceAfter: string;
  lineRule: string;
  lineSpacing: string;
  keepNext: Tri;
  keepLines: Tri;
  pageBreakBefore: Tri;
  widowControl: Tri;
  contextualSpacing: Tri;
  borders: Record<ParagraphBorderSideView, BorderRow>;
  /** `#RRGGBB`; blank for none. */
  shading: string;
}

export interface DialogFields {
  left: string;
  right: string;
  firstLine: string;
  tabs: TabRow[];
  /** Present when the core gives the options (`ParagraphFormatView.options`). */
  options?: OptionFields;
}

export type DialogField =
  | 'left'
  | 'right'
  | 'firstLine'
  | `tab${number}`
  | 'spaceBefore'
  | 'spaceAfter'
  | 'lineSpacing'
  | 'shading'
  | `border:${ParagraphBorderSideView}`;

const round = (n: number): number => Math.round(n * 1000) / 1000;

function borderRow(border: ParagraphBorderView | undefined): BorderRow {
  if (!border) return { style: 'none', width: '', color: '', space: '' };
  return {
    style: border.style,
    width: border.width === undefined ? '' : String(round(border.width / 8)),
    color: border.color ?? '',
    space: border.space === undefined ? '' : String(round(border.space / 20)),
  };
}

/** The option fields of the paragraphs the core describes. */
export function optionFields(o: ParagraphOptionsView): OptionFields {
  const mixed = new Set(o.mixed);
  const blank = (key: string, text: string): string => (mixed.has(key) ? '' : text);
  const tri = (key: (typeof TRI_OPTIONS)[number]): Tri => (mixed.has(key) ? 'mixed' : o[key]);
  const lineMixed = mixed.has('lineSpacing') || mixed.has('lineRule');
  const lines = o.lineRule === 'multiple' ? o.lineSpacing / 1000 : o.lineSpacing / 20;
  return {
    align: blank('align', o.align),
    spaceBefore: blank('spaceBefore', String(round(o.spaceBefore / 20))),
    spaceAfter: blank('spaceAfter', String(round(o.spaceAfter / 20))),
    lineRule: blank('lineRule', o.lineRule),
    lineSpacing: lineMixed ? '' : String(round(lines)),
    keepNext: tri('keepNext'),
    keepLines: tri('keepLines'),
    pageBreakBefore: tri('pageBreakBefore'),
    widowControl: tri('widowControl'),
    contextualSpacing: tri('contextualSpacing'),
    borders: Object.fromEntries(
      BORDER_SIDES.map((side) => [side, borderRow(o.borders[side])]),
    ) as Record<ParagraphBorderSideView, BorderRow>,
    shading: o.shading ?? '',
  };
}

/** What the dialog starts with: a value the paragraphs do not share is left blank. */
export function dialogFields(format: ParagraphFormatView): DialogFields {
  const text = (twips: number | null): string => (twips === null ? '' : String(centimetres(twips)));
  return {
    left: text(format.indentLeft),
    right: text(format.indentRight),
    firstLine: text(format.indentFirstLine),
    tabs: (format.tabs ?? []).map((t) => ({
      position: String(centimetres(t.position)),
      align: t.align,
      leader: t.leader,
    })),
    ...(format.options ? { options: optionFields(format.options) } : {}),
  };
}

/**
 * The line spacing text after the rule changes, so that the same space stays: a line is taken as
 * 12 points (an approximation of the natural height, not a measurement). Text that is not a
 * number is kept.
 */
export function convertLineSpacing(
  text: string,
  from: 'multiple' | 'exact' | 'atLeast',
  to: 'multiple' | 'exact' | 'atLeast',
): string {
  const n = parseNumber(text);
  if (n === null || (from === 'multiple') === (to === 'multiple')) return text;
  return String(round(from === 'multiple' ? n * 12 : n / 12));
}

/** A typed number; accepts a decimal comma. Null when it is not a number. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** A typed number of centimetres; accepts a decimal comma. Null when it is not a number. */
export function parseCentimetres(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return fromCentimetres(Number(trimmed));
}

export interface DialogResult {
  /** The patch for `setParagraphFormat`; null when nothing changes. */
  readonly patch: Record<string, unknown> | null;
  /** The fields that do not hold a length the CDM can store. */
  readonly invalid: readonly DialogField[];
}

const within = (twips: number, min: number, max: number): boolean => twips >= min && twips <= max;

/**
 * The patch that takes the paragraphs from `format` to the dialog's fields: only what changed. A
 * value the paragraphs did not share is written when its field is filled in, and kept when blank.
 */
export function dialogPatch(format: ParagraphFormatView, fields: DialogFields): DialogResult {
  const patch: Record<string, unknown> = {};
  const invalid: DialogField[] = [];
  const indents = [
    ['left', 'indentLeft', fields.left, format.indentLeft],
    ['right', 'indentRight', fields.right, format.indentRight],
    ['firstLine', 'indentFirstLine', fields.firstLine, format.indentFirstLine],
  ] as const;
  for (const [field, key, text, was] of indents) {
    if (text.trim() === '') {
      if (was === null) continue; // the paragraphs differ and the field was left blank: keep each
      if (was !== 0) patch[key] = 0;
      continue;
    }
    const twips = parseCentimetres(text);
    const least = field === 'firstLine' ? -MAX_TWIPS : 0;
    if (twips === null || !within(twips, least, MAX_TWIPS)) invalid.push(field);
    else if (twips !== was) patch[key] = twips;
  }
  const tabs: TabStopView[] = [];
  fields.tabs.forEach((row, i) => {
    const position = parseCentimetres(row.position);
    if (position === null || !within(position, 0, MAX_TWIPS)) invalid.push(`tab${i}`);
    else tabs.push({ position, align: row.align, leader: row.leader });
  });
  if (fields.tabs.length > MAX_TABS) invalid.push(`tab${MAX_TABS}`);
  if (invalid.length === 0) {
    const next = normaliseTabs(tabs);
    const before = normaliseTabs(format.tabs ?? []);
    if (
      JSON.stringify(next) !== JSON.stringify(before) ||
      (format.tabs === null && next.length > 0)
    )
      patch['tabs'] = next.length === 0 ? null : next;
  }
  if (fields.options && format.options)
    optionsPatch(format.options, fields.options, patch, invalid);
  return { patch: invalid.length === 0 && Object.keys(patch).length > 0 ? patch : null, invalid };
}

const COLOUR = /^#[0-9A-Fa-f]{6}$/;
const LIMIT = 31680;

/** The borders as the CDM stores them: only sides with a style other than `none`. */
type Borders = Partial<Record<ParagraphBorderSideView, ParagraphBorderView>>;

/** Borders in one form for comparing: no `none` sides, an automatic colour left out. */
function canonicalBorders(borders: Borders): Borders {
  const out: Borders = {};
  for (const side of BORDER_SIDES) {
    const b = borders[side];
    if (!b || b.style === 'none') continue;
    out[side] = {
      style: b.style,
      ...(b.width === undefined ? {} : { width: b.width }),
      ...(b.color ? { color: b.color.toUpperCase() } : {}),
      ...(b.space === undefined ? {} : { space: b.space }),
    };
  }
  return out;
}

/** Adds to `patch` what the option fields change from `was`; names the fields that are not valid. */
function optionsPatch(
  was: ParagraphOptionsView,
  fields: OptionFields,
  patch: Record<string, unknown>,
  invalid: DialogField[],
): void {
  const mixed = new Set(was.mixed);
  if (fields.align !== '' && (fields.align !== was.align || mixed.has('align')))
    patch['align'] = fields.align;

  for (const key of ['spaceBefore', 'spaceAfter'] as const) {
    const text = fields[key];
    if (text.trim() === '') {
      if (!mixed.has(key) && was[key] !== 0) patch[key] = 0;
      continue;
    }
    const n = parseNumber(text);
    const twips = n === null ? null : Math.round(n * 20);
    if (twips === null || twips < 0 || twips > LIMIT) invalid.push(key);
    else if (twips !== was[key] || mixed.has(key)) patch[key] = twips;
  }

  // Line spacing: the rule decides the unit of the number.
  const ruleMixed = mixed.has('lineRule');
  const rule = fields.lineRule === '' ? (ruleMixed ? null : was.lineRule) : fields.lineRule;
  const ruleChanged = fields.lineRule !== '' && (fields.lineRule !== was.lineRule || ruleMixed);
  const spacingText = fields.lineSpacing.trim();
  if (spacingText === '') {
    // A rule chosen while the spacing differs would change what each paragraph's number means.
    if (ruleChanged && mixed.has('lineSpacing')) invalid.push('lineSpacing');
    else if (ruleChanged) patch['lineRule'] = rule;
  } else if (rule === null) {
    invalid.push('lineSpacing');
  } else {
    const n = parseNumber(spacingText);
    const value = n === null ? null : Math.round(rule === 'multiple' ? n * 1000 : n * 20);
    if (value === null || value < 1 || value > LIMIT) invalid.push('lineSpacing');
    else {
      if (ruleChanged) patch['lineRule'] = rule;
      if (value !== was.lineSpacing || ruleChanged || mixed.has('lineSpacing'))
        patch['lineSpacing'] = value;
    }
  }

  for (const key of TRI_OPTIONS) {
    const v = fields[key];
    if (v !== 'mixed' && (v !== was[key] || mixed.has(key))) patch[key] = v;
  }

  // Borders and shading are whole values: written when any field differs from what the first
  // paragraph has.
  const borders: Borders = {};
  for (const side of BORDER_SIDES) {
    const row = fields.borders[side];
    if (row.style === 'none') continue;
    const border: { -readonly [K in keyof ParagraphBorderView]: ParagraphBorderView[K] } = {
      style: row.style,
    };
    let ok = true;
    if (row.width.trim() !== '') {
      const n = parseNumber(row.width);
      const eighths = n === null ? null : Math.round(n * 8);
      if (eighths === null || eighths < 0 || eighths > 240) ok = false;
      else border.width = eighths;
    }
    if (row.space.trim() !== '') {
      const n = parseNumber(row.space);
      const twips = n === null ? null : Math.round(n * 20);
      if (twips === null || twips < 0 || twips > 620) ok = false;
      else border.space = twips;
    }
    if (row.color.trim() !== '') {
      if (COLOUR.test(row.color.trim())) border.color = row.color.trim().toUpperCase();
      else ok = false;
    }
    if (ok) borders[side] = border;
    else invalid.push(`border:${side}`);
  }
  const wasBorders = JSON.stringify(canonicalBorders(was.borders));
  if (JSON.stringify(canonicalBorders(borders)) !== wasBorders)
    patch['borders'] = Object.keys(borders).length === 0 ? null : borders;

  const fill = fields.shading.trim();
  if (fill !== '' && !COLOUR.test(fill)) invalid.push('shading');
  else if ((fill === '' ? null : fill.toUpperCase()) !== was.shading)
    patch['shading'] = fill === '' ? null : { fill: fill.toUpperCase() };
}
