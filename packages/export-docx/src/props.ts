/**
 * Property containers (`w:pPr`, `w:rPr`, `w:sectPr`, `w:tblPr`, ...) as lenses (ADR 0017, part 2).
 *
 * Each modelled element has a lens: `read` maps the element to model values, `write` maps values
 * back to the element. Everything the model does not represent stays in the residue, an element
 * tree kept in the node's `preserved` attribute (or a `preserved` mark on text).
 *
 * Two rules make the round trip exact:
 *
 * 1. Import self-check. The importer regenerates every container from its values and residue and
 *    compares the result with the original as canonical XML. When they differ (a lexical form the
 *    writer would not produce, an order Word would not use), the residue keeps every original child,
 *    modelled ones included.
 * 2. Write rule. For a modelled element present in the residue, the writer keeps the residue's
 *    element while `read(element)` still equals the node's current values; otherwise it writes the
 *    current values and keeps the element's unmodelled attributes and children.
 *
 * So an unedited property is written in its original lexical form, and an edited one keeps what
 * the model does not know about it.
 */
import { BCP47_PATTERN, COLOUR_PATTERN, canonicalize } from '@docedit/model';
import { CDM1, HIGHLIGHT_VALUES, type JsonValue } from '@docedit/model/definition';
import {
  IDENTITY_ELEMENTS,
  NS,
  PPR_ORDER,
  RPR_ORDER,
  SECTPR_ORDER,
  STYLE_ORDER,
  TBLPR_ORDER,
  TCPR_ORDER,
  TRPR_ORDER,
  w,
} from './ooxml.ts';
import {
  type TreeElement,
  canonicalTree,
  elementsOf,
  hasContent,
  toTree,
  withoutAttrs,
} from './tree.ts';
import { pname } from './names.ts';
import { type XmlElement, canonical } from './xml.ts';

export type Values = Record<string, JsonValue>;

export interface LensContext {
  /** Word style id to CDM style id, if the style exists with that kind. */
  styleToCdm(wordId: string, kind: 'paragraph' | 'character' | 'table'): string | null;
  /** CDM style id to Word style id. */
  styleToWord(cdmId: string): string | null;
  /** Relationship id of a header or footer part to its story id. */
  storyForRel(relId: string): string | null;
  /** Story id to the relationship id that the main document part uses for it. */
  relForStory(storyId: string): string | null;
}

export interface Lens {
  name: string;
  /** For an element that repeats with different meanings: the attribute and value that select it. */
  discriminator?: { attr: string; value: string };
  keys: readonly string[];
  /** Names of the attributes the model represents (names.ts). */
  attrs: readonly string[];
  /**
   * Unmodelled attributes that take precedence over the modelled ones in Word (a theme colour over
   * `w:val`, character units over twips). They are dropped when the modelled value is edited, so
   * that Word shows the edit (precedence table, SR-M12).
   */
  overrides?: readonly string[];
  /** The values that mean "element absent". */
  absent: Values;
  read(el: TreeElement, ctx: LensContext): Values;
  /** Attributes for the values, or null when the element is to be absent. */
  write(v: Values, ctx: LensContext): Record<string, string> | null;
  /**
   * For an element whose values are in its children (borders): the children for the values,
   * keeping from `old`, the original element, what the model does not represent. Called only when
   * the values differ from what `old` reads to, or when there is no `old`.
   */
  children?(v: Values, old: TreeElement | undefined): TreeElement[];
}

export interface ContainerSpec {
  name: string;
  order: readonly string[];
  lenses: readonly Lens[];
  /** Child containers whose lenses write into the same values (for example `w:pPr` in `w:style`). */
  nested?: Readonly<Record<string, ContainerSpec>>;
  /** Children handled elsewhere (for example `w:sectPr` in `w:pPr`). */
  exclude?: ReadonlySet<string>;
}

/** An element written as given: XML text copied from the original part. */
export interface RawItem {
  name: string;
  raw: string;
}
export type MergedItem = TreeElement | RawItem;
export const isRaw = (m: MergedItem): m is RawItem => 'raw' in m;

const W_VAL = w('val');
// eslint-disable-next-line no-control-regex -- matching control characters is the point (as I11 does)
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const sameValues = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  canonicalize(a ?? null) === canonicalize(b ?? null);

function pick(v: Values, keys: readonly string[]): Values {
  const out: Values = {};
  for (const k of keys) out[k] = v[k] ?? null;
  return out;
}

const lensKey = (l: Lens): string =>
  l.discriminator ? `${l.name}#${l.discriminator.value}` : l.name;

function elementKey(el: TreeElement, spec: ContainerSpec): string {
  for (const l of spec.lenses)
    if (l.name === el.name && l.discriminator)
      if ((el.attrs?.[l.discriminator.attr] ?? '') === l.discriminator.value) return lensKey(l);
  return el.name;
}

function intIn(s: string | undefined, min: number, max: number): number | null {
  if (s === undefined || !/^-?[0-9]+$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

const onOff = (s: string | undefined): boolean =>
  s === undefined || !(s === '0' || s === 'false' || s === 'off');

// ---------------------------------------------------------------------------------------------
// Lens constructors.

function toggle(local: string, key: string, nullable = true): Lens {
  return {
    name: w(local),
    keys: [key],
    attrs: [W_VAL],
    absent: { [key]: nullable ? null : false },
    read: (el) => ({ [key]: onOff(el.attrs?.[W_VAL]) }),
    write: (v) =>
      v[key] === null || (!nullable && v[key] === false) ? null : v[key] ? {} : { [W_VAL]: '0' },
  };
}

function enumLens(
  local: string,
  key: string,
  toModel: Readonly<Record<string, string>>,
  toWord: Readonly<Record<string, string>>,
): Lens {
  return {
    name: w(local),
    keys: [key],
    attrs: [W_VAL],
    absent: { [key]: null },
    read: (el) => ({ [key]: toModel[el.attrs?.[W_VAL] ?? ''] ?? null }),
    write: (v) => {
      const s = v[key];
      return typeof s === 'string' && toWord[s] ? { [W_VAL]: toWord[s] } : null;
    },
  };
}

function styleRef(local: string, kind: 'paragraph' | 'character' | 'table', key: string): Lens {
  return {
    name: w(local),
    keys: [key],
    attrs: [W_VAL],
    absent: { [key]: null },
    read: (el, ctx) => ({ [key]: ctx.styleToCdm(el.attrs?.[W_VAL] ?? '', kind) }),
    write: (v, ctx) => {
      const id = v[key];
      const wordId = typeof id === 'string' ? ctx.styleToWord(id) : null;
      return wordId ? { [W_VAL]: wordId } : null;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Paragraph properties.

const JC_TO_MODEL = {
  left: 'start',
  start: 'start',
  center: 'center',
  right: 'end',
  end: 'end',
  both: 'justify',
  distribute: 'distribute',
};
const JC_TO_WORD = {
  start: 'left',
  center: 'center',
  end: 'right',
  justify: 'both',
  distribute: 'distribute',
};

const spacing: Lens = {
  name: w('spacing'),
  keys: ['spaceBefore', 'spaceAfter', 'lineSpacing', 'lineRule'],
  attrs: [w('before'), w('after'), w('line'), w('lineRule')],
  overrides: [w('beforeLines'), w('afterLines'), w('beforeAutospacing'), w('afterAutospacing')],
  absent: { spaceBefore: null, spaceAfter: null, lineSpacing: null, lineRule: null },
  read: (el) => {
    const a = el.attrs ?? {};
    const out: Values = {
      spaceBefore: intIn(a[w('before')], 0, 31680),
      spaceAfter: intIn(a[w('after')], 0, 31680),
      lineSpacing: null,
      lineRule: null,
    };
    const line = intIn(a[w('line')], 1, 31680 * 240);
    const rule = a[w('lineRule')] ?? 'auto';
    if (line !== null) {
      if (rule === 'auto') {
        const thousandths = (line * 1000) / 240;
        if (Number.isInteger(thousandths) && thousandths >= 1 && thousandths <= 31680) {
          out['lineSpacing'] = thousandths;
          out['lineRule'] = 'multiple';
        }
      } else if ((rule === 'exact' || rule === 'atLeast') && line <= 31680) {
        out['lineSpacing'] = line;
        out['lineRule'] = rule;
      }
    }
    return out;
  },
  write: (v) => {
    const out: Record<string, string> = {};
    if (v['spaceBefore'] !== null && v['spaceBefore'] !== undefined)
      out[w('before')] = String(v['spaceBefore']);
    if (v['spaceAfter'] !== null && v['spaceAfter'] !== undefined)
      out[w('after')] = String(v['spaceAfter']);
    const ls = v['lineSpacing'];
    const rule = v['lineRule'];
    if (typeof ls === 'number') {
      if (rule === 'exact' || rule === 'atLeast') {
        out[w('line')] = String(ls);
        out[w('lineRule')] = rule;
      } else {
        out[w('line')] = String(Math.round((ls * 240) / 1000));
        out[w('lineRule')] = 'auto';
      }
    }
    return Object.keys(out).length ? out : null;
  },
};

const ind: Lens = {
  name: w('ind'),
  keys: ['indentLeft', 'indentRight', 'indentFirstLine'],
  attrs: [w('left'), w('start'), w('right'), w('end'), w('firstLine'), w('hanging')],
  overrides: [
    w('leftChars'),
    w('startChars'),
    w('rightChars'),
    w('endChars'),
    w('firstLineChars'),
    w('hangingChars'),
  ],
  absent: { indentLeft: null, indentRight: null, indentFirstLine: null },
  read: (el) => {
    const a = el.attrs ?? {};
    const first = intIn(a[w('firstLine')], 0, 31680);
    const hanging = intIn(a[w('hanging')], 0, 31680);
    return {
      indentLeft: intIn(a[w('left')] ?? a[w('start')], -31680, 31680),
      indentRight: intIn(a[w('right')] ?? a[w('end')], -31680, 31680),
      indentFirstLine: hanging !== null ? -hanging : first,
    };
  },
  write: (v) => {
    const out: Record<string, string> = {};
    if (typeof v['indentLeft'] === 'number') out[w('left')] = String(v['indentLeft']);
    if (typeof v['indentRight'] === 'number') out[w('right')] = String(v['indentRight']);
    const f = v['indentFirstLine'];
    if (typeof f === 'number') {
      if (f < 0) out[w('hanging')] = String(-f);
      else out[w('firstLine')] = String(f);
    }
    return Object.keys(out).length ? out : null;
  },
};

const bidi: Lens = {
  name: w('bidi'),
  keys: ['dir'],
  attrs: [W_VAL],
  absent: { dir: null },
  read: (el) => ({ dir: onOff(el.attrs?.[W_VAL]) ? 'rtl' : 'ltr' }),
  write: (v) => (v['dir'] === 'rtl' ? {} : v['dir'] === 'ltr' ? { [W_VAL]: '0' } : null),
};

const PARAGRAPH_LENSES: Lens[] = [
  toggle('keepNext', 'keepNext'),
  toggle('keepLines', 'keepLines'),
  toggle('pageBreakBefore', 'pageBreakBefore'),
  toggle('widowControl', 'widowControl'),
  bidi,
  spacing,
  ind,
  toggle('contextualSpacing', 'contextualSpacing'),
  enumLens('jc', 'align', JC_TO_MODEL, JC_TO_WORD),
];

// ---------------------------------------------------------------------------------------------
// Run properties. Keys are the style_def attribute names; marks are converted in marks.ts.

/** The grammar of the `fontFamily` mark, taken from the definition (cdm1.ts does not export the pattern). */
const FONT_FAMILY_PATTERN = (() => {
  const g = CDM1.marks.find((m) => m.name === 'fontFamily')?.attrs['value']?.grammar;
  if (!g || g.kind !== 'string' || !g.pattern) throw new Error('fontFamily grammar not found');
  return g.pattern;
})();
const fontRe = new RegExp(FONT_FAMILY_PATTERN);
const colourRe = new RegExp(COLOUR_PATTERN);
const langRe = new RegExp(BCP47_PATTERN);

const rFonts: Lens = {
  name: w('rFonts'),
  keys: ['fontFamily'],
  attrs: [w('ascii')],
  overrides: [w('asciiTheme')],
  absent: { fontFamily: null },
  read: (el) => {
    const f = el.attrs?.[w('ascii')];
    return { fontFamily: f !== undefined && fontRe.test(f) ? f : null };
  },
  write: (v) => (typeof v['fontFamily'] === 'string' ? { [w('ascii')]: v['fontFamily'] } : null),
};

const color: Lens = {
  name: w('color'),
  keys: ['color'],
  attrs: [W_VAL],
  overrides: [w('themeColor'), w('themeShade'), w('themeTint')],
  absent: { color: null },
  read: (el) => {
    const c = `#${(el.attrs?.[W_VAL] ?? '').toUpperCase()}`;
    return { color: colourRe.test(c) ? c : null };
  },
  write: (v) => (typeof v['color'] === 'string' ? { [W_VAL]: v['color'].slice(1) } : null),
};

const sz: Lens = {
  name: w('sz'),
  keys: ['fontSize'],
  attrs: [W_VAL],
  absent: { fontSize: null },
  read: (el) => {
    const half = intIn(el.attrs?.[W_VAL], 2, 3276);
    return { fontSize: half === null ? null : half * 10 };
  },
  write: (v) =>
    typeof v['fontSize'] === 'number' ? { [W_VAL]: String(Math.round(v['fontSize'] / 10)) } : null,
};

const HIGHLIGHT = Object.fromEntries(HIGHLIGHT_VALUES.map((h) => [h, h]));
const UNDERLINE = { single: 'single', double: 'double', dotted: 'dotted', none: 'none' };
const VERT_TO_MODEL = { superscript: 'super', subscript: 'sub', baseline: 'baseline' };
const VERT_TO_WORD = { super: 'superscript', sub: 'subscript', baseline: 'baseline' };

const lang: Lens = {
  name: w('lang'),
  keys: ['lang'],
  attrs: [W_VAL],
  absent: { lang: null },
  read: (el) => {
    const l = el.attrs?.[W_VAL];
    return { lang: l !== undefined && l.length <= 64 && langRe.test(l) ? l : null };
  },
  write: (v) => (typeof v['lang'] === 'string' ? { [W_VAL]: v['lang'] } : null),
};

const RUN_LENSES: Lens[] = [
  rFonts,
  toggle('b', 'bold'),
  toggle('i', 'italic'),
  toggle('caps', 'allCaps'),
  toggle('smallCaps', 'smallCaps'),
  toggle('strike', 'strike'),
  toggle('vanish', 'hidden'),
  color,
  sz,
  enumLens('highlight', 'highlight', HIGHLIGHT, HIGHLIGHT),
  enumLens('u', 'underline', UNDERLINE, UNDERLINE),
  enumLens('vertAlign', 'vertAlign', VERT_TO_MODEL, VERT_TO_WORD),
  lang,
];

export const RUN_KEYS = ['charStyle', ...RUN_LENSES.flatMap((l) => l.keys)] as const;

// ---------------------------------------------------------------------------------------------
// Section properties (page_setup, plus `start` of the section break that begins the section).

function storyRef(local: 'headerReference' | 'footerReference', type: string, key: string): Lens {
  return {
    name: w(local),
    discriminator: { attr: w('type'), value: type },
    keys: [key],
    attrs: [w('type'), pname(NS.r, 'id')],
    absent: { [key]: null },
    read: (el, ctx) => ({ [key]: ctx.storyForRel(el.attrs?.[pname(NS.r, 'id')] ?? '') }),
    write: (v, ctx) => {
      const id = v[key];
      const rel = typeof id === 'string' ? ctx.relForStory(id) : null;
      return rel ? { [w('type')]: type, [pname(NS.r, 'id')]: rel } : null;
    },
  };
}

const PAGE_DEFAULTS = {
  width: 11906,
  height: 16838,
  orientation: 'portrait',
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  headerDistance: 708,
  footerDistance: 708,
  gutter: 0,
} as const;

const pgSz: Lens = {
  name: w('pgSz'),
  keys: ['width', 'height', 'orientation'],
  attrs: [w('w'), w('h'), w('orient')],
  absent: { width: PAGE_DEFAULTS.width, height: PAGE_DEFAULTS.height, orientation: 'portrait' },
  read: (el) => ({
    width: intIn(el.attrs?.[w('w')], 144, 31680) ?? PAGE_DEFAULTS.width,
    height: intIn(el.attrs?.[w('h')], 144, 31680) ?? PAGE_DEFAULTS.height,
    orientation: el.attrs?.[w('orient')] === 'landscape' ? 'landscape' : 'portrait',
  }),
  write: (v) => {
    const out: Record<string, string> = {
      [w('w')]: String(v['width']),
      [w('h')]: String(v['height']),
    };
    if (v['orientation'] === 'landscape') out[w('orient')] = 'landscape';
    return out;
  },
};

const MARGIN_ATTRS: Array<[string, keyof typeof PAGE_DEFAULTS]> = [
  ['top', 'marginTop'],
  ['right', 'marginRight'],
  ['bottom', 'marginBottom'],
  ['left', 'marginLeft'],
  ['header', 'headerDistance'],
  ['footer', 'footerDistance'],
  ['gutter', 'gutter'],
];

const pgMar: Lens = {
  name: w('pgMar'),
  keys: MARGIN_ATTRS.map((m) => m[1]),
  attrs: MARGIN_ATTRS.map((m) => w(m[0])),
  absent: Object.fromEntries(MARGIN_ATTRS.map(([, k]) => [k, PAGE_DEFAULTS[k]])),
  read: (el) =>
    Object.fromEntries(
      MARGIN_ATTRS.map(([a, k]) => {
        const n = intIn(el.attrs?.[w(a)], -31680, 31680);
        return [k, n === null ? PAGE_DEFAULTS[k] : Math.abs(n)];
      }),
    ),
  write: (v) => Object.fromEntries(MARGIN_ATTRS.map(([a, k]) => [w(a), String(v[k])])),
};

const cols: Lens = {
  name: w('cols'),
  keys: ['columns', 'columnGap'],
  attrs: [w('num'), w('space')],
  absent: { columns: 1, columnGap: 720 },
  read: (el) => ({
    columns: intIn(el.attrs?.[w('num')], 1, 16) ?? 1,
    columnGap: intIn(el.attrs?.[w('space')], 0, 31680) ?? 720,
  }),
  write: (v) => {
    const out: Record<string, string> = { [w('space')]: String(v['columnGap']) };
    if (v['columns'] !== 1) out[w('num')] = String(v['columns']);
    return out;
  },
};

const PAGE_FORMATS = {
  decimal: 'decimal',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
};

const pgNumType: Lens = {
  name: w('pgNumType'),
  keys: ['pageNumberStart', 'pageNumberFormat'],
  attrs: [w('start'), w('fmt')],
  absent: { pageNumberStart: null, pageNumberFormat: 'decimal' },
  read: (el) => ({
    pageNumberStart: intIn(el.attrs?.[w('start')], 0, 32767),
    pageNumberFormat:
      (PAGE_FORMATS as Record<string, string>)[el.attrs?.[w('fmt')] ?? ''] ?? 'decimal',
  }),
  write: (v) => {
    const out: Record<string, string> = {};
    if (typeof v['pageNumberStart'] === 'number') out[w('start')] = String(v['pageNumberStart']);
    if (v['pageNumberFormat'] !== 'decimal') out[w('fmt')] = String(v['pageNumberFormat']);
    return Object.keys(out).length ? out : null;
  },
};

const sectionType: Lens = {
  name: w('type'),
  keys: ['start'],
  attrs: [W_VAL],
  absent: { start: 'nextPage' },
  read: (el) => {
    const t = el.attrs?.[W_VAL] ?? 'nextPage';
    return {
      start: ['nextPage', 'continuous', 'evenPage', 'oddPage'].includes(t) ? t : 'nextPage',
    };
  },
  write: (v) => (v['start'] === 'nextPage' ? null : { [W_VAL]: String(v['start']) }),
};

const SECTION_LENSES: Lens[] = [
  storyRef('headerReference', 'default', 'headerDefault'),
  storyRef('headerReference', 'first', 'headerFirst'),
  storyRef('headerReference', 'even', 'headerEven'),
  storyRef('footerReference', 'default', 'footerDefault'),
  storyRef('footerReference', 'first', 'footerFirst'),
  storyRef('footerReference', 'even', 'footerEven'),
  pgSz,
  pgMar,
  pgNumType,
  cols,
  toggle('titlePg', 'differentFirstPage', false),
];

// ---------------------------------------------------------------------------------------------
// Tables.

const tblW: Lens = {
  name: w('tblW'),
  keys: ['width'],
  attrs: [w('w'), w('type')],
  absent: { width: null },
  read: (el) => {
    const type = el.attrs?.[w('type')] ?? 'dxa';
    const raw = el.attrs?.[w('w')] ?? '0';
    if (type === 'dxa') {
      const n = intIn(raw, 0, 31680);
      return { width: n === null ? null : { type: 'fixed', value: n } };
    }
    if (type === 'pct') {
      const n = raw.endsWith('%')
        ? Math.round(Number(raw.slice(0, -1)) * 100)
        : (intIn(raw, 0, 15840) ?? NaN) * 2;
      return {
        width: Number.isInteger(n) && n >= 0 && n <= 31680 ? { type: 'pct', value: n } : null,
      };
    }
    if (type === 'auto') {
      const n = intIn(raw, 0, 31680);
      return { width: n === null ? null : { type: 'auto', value: n } };
    }
    return { width: null };
  },
  write: (v) => {
    const wv = v['width'] as { type: string; value: number } | null;
    if (!wv) return null;
    if (wv.type === 'fixed') return { [w('w')]: String(wv.value), [w('type')]: 'dxa' };
    if (wv.type === 'pct')
      return { [w('w')]: String(Math.round(wv.value / 2)), [w('type')]: 'pct' };
    return { [w('w')]: String(wv.value), [w('type')]: 'auto' };
  },
};

const TABLE_JC = { center: 'center', left: 'start', start: 'start', right: 'end', end: 'end' };
const TABLE_JC_WORD = { center: 'center', start: 'left', end: 'right' };

const trHeight: Lens = {
  name: w('trHeight'),
  keys: ['height', 'heightRule'],
  attrs: [W_VAL, w('hRule')],
  absent: { height: null, heightRule: 'auto' },
  read: (el) => {
    const h = intIn(el.attrs?.[W_VAL], 0, 31680);
    const rule = el.attrs?.[w('hRule')] ?? 'atLeast';
    return {
      height: h,
      heightRule: ['auto', 'atLeast', 'exact'].includes(rule) ? rule : 'atLeast',
    };
  },
  write: (v) => {
    if (v['height'] === null && v['heightRule'] === 'auto') return null;
    const out: Record<string, string> = {};
    if (typeof v['height'] === 'number') out[W_VAL] = String(v['height']);
    if (v['heightRule'] !== 'atLeast') out[w('hRule')] = String(v['heightRule']);
    return out;
  },
};

const gridSpan: Lens = {
  name: w('gridSpan'),
  keys: ['colspan'],
  attrs: [W_VAL],
  absent: { colspan: 1 },
  read: (el) => ({ colspan: intIn(el.attrs?.[W_VAL], 1, 63) ?? 1 }),
  write: (v) => (v['colspan'] === 1 ? null : { [W_VAL]: String(v['colspan']) }),
};

const shd: Lens = {
  name: w('shd'),
  keys: ['shading'],
  attrs: [W_VAL, w('color'), w('fill')],
  overrides: [w('themeFill'), w('themeFillShade'), w('themeFillTint')],
  absent: { shading: null },
  read: (el) => {
    const f = `#${(el.attrs?.[w('fill')] ?? '').toUpperCase()}`;
    return { shading: colourRe.test(f) ? { fill: f } : null };
  },
  // `w:val` is required by the schema (EXP-090 criterion 7): a solid fill is the pattern `clear`.
  write: (v) => {
    const s = v['shading'] as { fill: string } | null;
    return s ? { [W_VAL]: 'clear', [w('color')]: 'auto', [w('fill')]: s.fill.slice(1) } : null;
  },
};

const V_ALIGN = { top: 'top', center: 'center', bottom: 'bottom' };

// Borders of a table (`w:tblBorders`) and of a cell (`w:tcBorders`) as the `borders` attribute of
// `table` and `table_cell` (cdm1.ts TABLE_BORDERS and CELL_BORDERS; EXP-101). The values are in
// the side elements, so the lens builds children. A side reads to the model's border grammar:
// `w:val` to one of the six model styles, `w:sz` (eighths of a point) to twips, `w:space`
// (points) to twips, and `w:color` to a colour, or none for `auto`. A Word style the model does
// not name (`triple`, `wave`, art borders) reads as `single`, so the editor draws a line; the
// whole element stays in the residue, and a side is written back unchanged while its value is
// unchanged (rule 2). `w:start` and `w:end` read as left and right, as in a left-to-right table.
// Sides the model does not have (`w:tl2br`, `w:tr2bl`, a cell's inside borders) stay unmodelled.

const BORDER_FROM_WORD: Readonly<Record<string, string>> = {
  nil: 'none',
  none: 'none',
  single: 'single',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  thick: 'thick',
};
const SIDE_ATTRS = [W_VAL, w('sz'), w('space'), w('color')];
const SIDE_OVERRIDES = [w('themeColor'), w('themeTint'), w('themeShade')];
const SIDE_ORDER = [
  'top',
  'left',
  'start',
  'bottom',
  'right',
  'end',
  'insideH',
  'insideV',
  'tl2br',
  'tr2bl',
].map(w);

const isRecord = (x: JsonValue | undefined): x is Record<string, JsonValue> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function readSide(el: TreeElement): JsonValue {
  const a = el.attrs ?? {};
  const out: Record<string, JsonValue> = { style: BORDER_FROM_WORD[a[W_VAL] ?? ''] ?? 'single' };
  const sz = intIn(a[w('sz')], 0, 100000);
  if (sz !== null) out['width'] = Math.min(240, Math.round(sz * 2.5));
  const space = intIn(a[w('space')], 0, 100000);
  if (space !== null) out['space'] = Math.min(620, space * 20);
  const c = `#${(a[w('color')] ?? '').toUpperCase()}`;
  if (colourRe.test(c)) out['color'] = c;
  return out;
}

/** The attributes of one side, with the defaults of writer-styles.ts `bordersXml`. */
function sideAttrs(b: Record<string, JsonValue>): Record<string, string> {
  const style = typeof b['style'] === 'string' ? b['style'] : 'single';
  const width = typeof b['width'] === 'number' ? b['width'] : 10;
  const space = typeof b['space'] === 'number' ? b['space'] : 0;
  const c = b['color'];
  return {
    [W_VAL]: style,
    [w('sz')]: String(style === 'none' ? 0 : Math.max(2, Math.min(96, Math.round(width / 2.5)))),
    [w('space')]: String(Math.max(0, Math.min(31, Math.round(space / 20)))),
    [w('color')]:
      typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c) ? c.slice(1).toUpperCase() : 'auto',
  };
}

/** `sides`: the model's key for a side and Word's elements for it, the preferred one first. */
function bordersLens(local: string, sides: ReadonlyArray<[string, readonly string[]]>): Lens {
  const keyOf = new Map<string, string>();
  for (const [k, names] of sides) for (const n of names) keyOf.set(w(n), k);
  const rank = (name: string): number => {
    const i = SIDE_ORDER.indexOf(name);
    return i < 0 ? SIDE_ORDER.length : i;
  };
  return {
    name: w(local),
    keys: ['borders'],
    attrs: [],
    absent: { borders: null },
    read: (el) => {
      const out: Record<string, JsonValue> = {};
      for (const c of elementsOf(el.children)) {
        const k = keyOf.get(c.name);
        if (k !== undefined && !(k in out)) out[k] = readSide(c);
      }
      return { borders: Object.keys(out).length ? out : null };
    },
    write: (v) => (isRecord(v['borders']) ? {} : null),
    children: (v, old) => {
      const b = isRecord(v['borders']) ? v['borders'] : {};
      const out: TreeElement[] = [];
      const done = new Set<string>();
      for (const c of elementsOf(old?.children)) {
        const k = keyOf.get(c.name);
        // An unmodelled side, or a second element for a side already read, stays as it is.
        if (k === undefined || done.has(k)) {
          out.push(c);
          continue;
        }
        done.add(k);
        const val = b[k];
        if (!isRecord(val)) continue;
        if (sameValues(readSide(c), val)) {
          out.push(c);
          continue;
        }
        const base = withoutAttrs(c, [...SIDE_ATTRS, ...SIDE_OVERRIDES]);
        const side: TreeElement = { name: c.name, attrs: { ...sideAttrs(val), ...base.attrs } };
        if (base.children) side.children = base.children;
        out.push(side);
      }
      for (const [k, names] of sides) {
        const val = b[k];
        if (!done.has(k) && isRecord(val) && names[0])
          out.push({ name: w(names[0]), attrs: sideAttrs(val) });
      }
      return out.sort((x, y) => rank(x.name) - rank(y.name));
    },
  };
}

const tblBorders = bordersLens('tblBorders', [
  ['top', ['top']],
  ['left', ['left', 'start']],
  ['bottom', ['bottom']],
  ['right', ['right', 'end']],
  ['insideH', ['insideH']],
  ['insideV', ['insideV']],
]);
const tcBorders = bordersLens('tcBorders', [
  ['top', ['top']],
  ['left', ['left', 'start']],
  ['bottom', ['bottom']],
  ['right', ['right', 'end']],
]);

// ---------------------------------------------------------------------------------------------
// Styles.

const styleName: Lens = {
  name: w('name'),
  keys: ['name'],
  attrs: [W_VAL],
  absent: { name: null },
  read: (el) => {
    const n = el.attrs?.[W_VAL] ?? '';
    return { name: n.length >= 1 && n.length <= 255 && !CONTROL_CHARACTERS.test(n) ? n : null };
  },
  write: (v) => (typeof v['name'] === 'string' ? { [W_VAL]: v['name'] } : null),
};

const outlineLvl: Lens = {
  name: w('outlineLvl'),
  keys: ['outlineLevel'],
  attrs: [W_VAL],
  absent: { outlineLevel: null },
  read: (el) => {
    const n = intIn(el.attrs?.[W_VAL], 0, 8);
    return { outlineLevel: n === null ? null : n + 1 };
  },
  write: (v) =>
    typeof v['outlineLevel'] === 'number' ? { [W_VAL]: String(v['outlineLevel'] - 1) } : null,
};

// ---------------------------------------------------------------------------------------------
// Container specs.

export const PPR: ContainerSpec = {
  name: w('pPr'),
  order: PPR_ORDER,
  lenses: [styleRef('pStyle', 'paragraph', 'style'), ...PARAGRAPH_LENSES],
  exclude: new Set([w('sectPr')]),
};

export const RPR: ContainerSpec = {
  name: w('rPr'),
  order: RPR_ORDER,
  lenses: [styleRef('rStyle', 'character', 'charStyle'), ...RUN_LENSES],
};

export const SECTPR_FIRST: ContainerSpec = {
  name: w('sectPr'),
  order: SECTPR_ORDER,
  lenses: SECTION_LENSES,
};
export const SECTPR: ContainerSpec = {
  name: w('sectPr'),
  order: SECTPR_ORDER,
  lenses: [...SECTION_LENSES, sectionType],
};

export const TBLPR: ContainerSpec = {
  name: w('tblPr'),
  order: TBLPR_ORDER,
  lenses: [
    styleRef('tblStyle', 'table', 'style'),
    tblW,
    enumLens('jc', 'align', TABLE_JC, TABLE_JC_WORD),
    tblBorders,
  ],
};
export const TRPR: ContainerSpec = {
  name: w('trPr'),
  order: TRPR_ORDER,
  lenses: [trHeight, toggle('cantSplit', 'cantSplit', false)],
  // A tracked insertion or deletion of the row is a suggestion mark on the row (EXP-103).
  exclude: new Set([w('ins'), w('del')]),
};
/**
 * A leading header row whose `w:tblHeader` is the plain empty element: the table's `headerRows`
 * models it, so it is left out of the row's residue and written again from `headerRows`.
 */
export const TRPR_HEADER: ContainerSpec = {
  ...TRPR,
  exclude: new Set([w('ins'), w('del'), w('tblHeader')]),
};
export const TCPR: ContainerSpec = {
  name: w('tcPr'),
  order: TCPR_ORDER,
  lenses: [gridSpan, enumLens('vAlign', 'vAlign', V_ALIGN, V_ALIGN), shd, tcBorders],
};

export const STYLE: ContainerSpec = {
  name: w('style'),
  order: STYLE_ORDER,
  lenses: [
    styleName,
    styleRef('basedOn', 'paragraph', 'basedOn'),
    styleRef('next', 'paragraph', 'next'),
  ],
  nested: {
    [w('pPr')]: { name: w('pPr'), order: PPR_ORDER, lenses: [...PARAGRAPH_LENSES, outlineLvl] },
    [w('rPr')]: { name: w('rPr'), order: RPR_ORDER, lenses: RUN_LENSES },
  },
  // The style's revision session is identity-bound: the source map keeps it (EXP-116).
  exclude: IDENTITY_ELEMENTS,
};

/**
 * The `w:tblPr` of a table style (`w:style` with `w:type="table"`): its borders are read into the
 * style's `borders` attribute, as the table's own `w:tblPr` does (EXP-101). The other children stay
 * in the residue.
 */
const TABLE_STYLE_TBLPR: ContainerSpec = {
  name: w('tblPr'),
  order: TBLPR_ORDER,
  lenses: [tblBorders],
};

/** Style specs depend on the style kind: `basedOn` and `next` refer to styles of the same kind. */
export function styleSpec(kind: 'paragraph' | 'character' | 'table'): ContainerSpec {
  if (kind === 'paragraph') return STYLE;
  if (kind === 'table')
    return {
      ...STYLE,
      lenses: [styleName, styleRef('basedOn', kind, 'basedOn')],
      nested: { [w('tblPr')]: TABLE_STYLE_TBLPR },
    };
  return {
    ...STYLE,
    lenses: [styleName, styleRef('basedOn', kind, 'basedOn')],
    nested: { [w('rPr')]: STYLE.nested![w('rPr')]! },
  };
}

/** The keys a spec writes, with their absent values. */
export function absentValues(spec: ContainerSpec): Values {
  const out: Values = {};
  for (const l of spec.lenses) Object.assign(out, l.absent);
  for (const n of Object.values(spec.nested ?? {})) Object.assign(out, absentValues(n));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading and merging.

export interface ContainerRead {
  values: Values;
  residue: TreeElement[];
  /** True when the residue holds every original child (the self-check failed for the compact form). */
  full: boolean;
}

/**
 * Reads a container's children (already filtered by `spec.exclude` by the caller or here) into
 * values and a residue, and self-checks the result (rule 1 above).
 */
export function readContainer(
  spec: ContainerSpec,
  children: XmlElement[],
  ctx: LensContext,
  stats?: ReadStats,
): ContainerRead {
  const values = absentValues(spec);
  const kept = children.filter((c) => !spec.exclude?.has(pname(c.ns, c.local)));
  const residue: TreeElement[] = [];
  const done = new Set<string>();
  for (const c of kept) {
    const tree = toTree(c);
    const nested = spec.nested?.[tree.name];
    if (nested && !done.has(tree.name)) {
      done.add(tree.name);
      const inner = readContainer(nested, childElements(c), ctx, stats);
      Object.assign(values, inner.values);
      const holder: TreeElement = { name: tree.name };
      if (tree.attrs) holder.attrs = tree.attrs;
      if (inner.residue.length) holder.children = inner.residue;
      residue.push(holder);
      continue;
    }
    const key = elementKey(tree, spec);
    const lens = spec.lenses.find((l) => lensKey(l) === key);
    if (lens && !done.has(key)) {
      done.add(key);
      Object.assign(values, lens.read(tree, ctx));
      const partial = withoutAttrs(tree, lens.attrs);
      if (hasContent(partial)) residue.push(partial);
      continue;
    }
    residue.push(tree);
  }
  // Holders of nested containers without residue are kept only for an originally empty element.
  const compact = residue.filter(
    (r) => hasContent(r) || !spec.nested?.[r.name] || isEmptyOriginal(r, kept),
  );
  // Rule 1: the compact residue must reproduce the original exactly.
  const merged = mergeContainer(spec, values, compact, ctx, []);
  const want = kept.map((c) => canonical(c)).join('');
  const got = merged.map((m) => (isRaw(m) ? m.raw : canonicalTree(m))).join('');
  if (got === want) return { values, residue: compact, full: false };
  if (stats) stats.fullContainers[spec.name] = (stats.fullContainers[spec.name] ?? 0) + 1;
  return { values, residue: kept.map((c) => toTree(c)), full: true };
}

export interface ReadStats {
  fullContainers: Record<string, number>;
}

function isEmptyOriginal(r: TreeElement, kept: XmlElement[]): boolean {
  return kept.some(
    (c) => pname(c.ns, c.local) === r.name && !c.children.some((x) => x.kind === 'element'),
  );
}

function childElements(el: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (c.kind === 'element') out.push(c);
  return out;
}

function rankOf(spec: ContainerSpec, name: string): number | undefined {
  const i = spec.order.indexOf(name);
  return i < 0 ? undefined : i;
}

/**
 * Builds a container's children from values and residue (rule 2 above). Residue order is kept;
 * modelled elements missing from the residue, and the extras, go in by schema rank.
 */
export function mergeContainer(
  spec: ContainerSpec,
  values: Values,
  residue: readonly TreeElement[],
  ctx: LensContext,
  extras: readonly MergedItem[],
): MergedItem[] {
  const out: Array<{ rank: number; item: MergedItem }> = [];
  const done = new Set<string>();
  let prev = -1;
  for (const r of residue) {
    const rank = rankOf(spec, r.name) ?? prev;
    prev = rank;
    const nested = spec.nested?.[r.name];
    if (nested && !done.has(r.name)) {
      done.add(r.name);
      const inner = mergeContainer(
        nested,
        values,
        elementsOf(r.children),
        ctx,
        [],
      ) as TreeElement[];
      if (inner.length || r.attrs || !hasContent(r)) {
        const holder: TreeElement = { name: r.name };
        if (r.attrs) holder.attrs = r.attrs;
        if (inner.length) holder.children = inner;
        out.push({ rank, item: holder });
      }
      continue;
    }
    const key = elementKey(r, spec);
    const lens = spec.lenses.find((l) => lensKey(l) === key);
    if (lens && !done.has(key)) {
      done.add(key);
      const el = applyLens(lens, r, values, ctx);
      if (el) out.push({ rank, item: el });
      continue;
    }
    out.push({ rank, item: r });
  }
  const insert = (rank: number, item: MergedItem): void => {
    let i = out.findIndex((o) => o.rank > rank);
    if (i < 0) i = out.length;
    out.splice(i, 0, { rank, item });
  };
  for (const lens of spec.lenses) {
    if (done.has(lensKey(lens))) continue;
    const el = applyLens(lens, undefined, values, ctx);
    if (el) insert(rankOf(spec, lens.name) ?? spec.order.length, el);
  }
  for (const [name, nested] of Object.entries(spec.nested ?? {})) {
    if (done.has(name)) continue;
    const inner = mergeContainer(nested, values, [], ctx, []);
    if (inner.length)
      insert(rankOf(spec, name) ?? spec.order.length, { name, children: inner as TreeElement[] });
  }
  for (const x of extras) insert(rankOf(spec, x.name) ?? spec.order.length, x);
  return out.map((o) => o.item);
}

function applyLens(
  lens: Lens,
  r: TreeElement | undefined,
  values: Values,
  ctx: LensContext,
): TreeElement | null {
  const cur = pick(values, lens.keys);
  if (r) {
    const was = lens.read(r, ctx);
    if (lens.keys.every((k) => sameValues(was[k], cur[k]))) return r;
    const base = withoutAttrs(r, [...lens.attrs, ...(lens.overrides ?? [])]);
    const attrs = lens.write(cur, ctx);
    if (lens.children) return built(r.name, { ...attrs, ...base.attrs }, lens.children(cur, r));
    if (attrs === null) return hasContent(base) ? base : null;
    const el: TreeElement = { name: r.name, attrs: { ...attrs, ...(base.attrs ?? {}) } };
    if (base.children) el.children = base.children;
    return el;
  }
  if (lens.keys.every((k) => sameValues(lens.absent[k], cur[k]))) return null;
  const attrs = lens.write(cur, ctx);
  if (attrs !== null && lens.children)
    return built(lens.name, attrs, lens.children(cur, undefined));
  return attrs === null ? null : { name: lens.name, attrs };
}

/** An element with these attributes and children, or null when it would be empty. */
function built(
  name: string,
  attrs: Record<string, string>,
  kids: TreeElement[],
): TreeElement | null {
  const el: TreeElement = { name };
  if (Object.keys(attrs).length) el.attrs = attrs;
  if (kids.length) el.children = kids;
  return hasContent(el) ? el : null;
}
