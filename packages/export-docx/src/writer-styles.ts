/**
 * The definition parts of the direct DOCX writer (EXP-090): `styles.xml` with `w:docDefaults` for
 * the model's base values (ADR 0032), `numbering.xml` from the numbering definitions with one list
 * instance per `listId`, and the property XML both share (borders, shading, tabs, margins).
 */
import { BASE_PARAGRAPH, BASE_RUN, type JsonNode } from '@docedit/model';
import type { JsonValue } from '@docedit/model/definition';
import {
  type LensContext,
  type MergedItem,
  type Values,
  RPR,
  STYLE,
  isRaw,
  mergeContainer,
} from './props.ts';
import { w } from './ooxml.ts';
import type { NamespaceWriter, TreeElement } from './tree.ts';
import { XML_DECLARATION, ROOT_DECLARATIONS, el } from './writer-xml.ts';

/**
 * The font slots of `w:rFonts` other than `w:ascii`, for a run's font (ECMA-376 Part 1, 17.3.2.26).
 * Word takes each character's font from one of four slots chosen by its Unicode range: `w:ascii`
 * for U+0000 to U+007F, `w:hAnsi` for most other Latin text (U+0100 to U+017F, U+1E00 to U+1EFF)
 * and for punctuation such as the curly quotes U+2018 to U+201F, `w:eastAsia` for East Asian text
 * (and for shared characters under an East Asian hint), and `w:cs` for complex scripts. A slot the
 * run does not set is inherited from the style chain and the document defaults. The model has one
 * font per run (03 §6) and the `w:rFonts` lens writes it as `w:ascii`, so a package written from the
 * model alone states it in every slot; otherwise Word shows a character outside U+0000 to U+007F
 * in the default font. Passed as the residue of the run properties, the lens adds `w:ascii` to it.
 */
export function fontSlots(values: Values): TreeElement[] {
  const f = values['fontFamily'];
  if (typeof f !== 'string') return [];
  return [{ name: w('rFonts'), attrs: { [w('hAnsi')]: f, [w('eastAsia')]: f, [w('cs')]: f } }];
}

/** Word's own names of the built-in styles, by the model's reserved identifier, so Word treats them as its built-ins. */
export const WORD_BUILT_IN_NAMES: Readonly<Record<string, string>> = {
  Normal: 'Normal',
  Title: 'Title',
  Subtitle: 'Subtitle',
  Quote: 'Quote',
  IntenseQuote: 'Intense Quote',
  ListParagraph: 'List Paragraph',
  NoSpacing: 'No Spacing',
  Caption: 'caption',
  FootnoteText: 'footnote text',
  Header: 'header',
  Footer: 'footer',
  TOCHeading: 'TOC Heading',
  DefaultParagraphFont: 'Default Paragraph Font',
  FootnoteReference: 'footnote reference',
  Hyperlink: 'Hyperlink',
  Strong: 'Strong',
  Emphasis: 'Emphasis',
  TableNormal: 'Normal Table',
  TableGrid: 'Table Grid',
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`Heading${i + 1}`, `heading ${i + 1}`]),
  ),
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`TOC${i + 1}`, `toc ${i + 1}`])),
};

const STYLE_PPR = STYLE.nested![w('pPr')]!;
const STYLE_RPR = STYLE.nested![w('rPr')]!;

const hex = (c: unknown): string =>
  typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c) ? c.slice(1).toUpperCase() : 'auto';

const BORDER_STYLE: Readonly<Record<string, string>> = {
  none: 'none',
  single: 'single',
  double: 'double',
  dotted: 'dotted',
  dashed: 'dashed',
  thick: 'thick',
};

/** One border side: width in twips becomes eighths of a point (2 to 96), space in twips becomes points. */
function side(name: string, b: unknown): string {
  if (typeof b !== 'object' || b === null) return '';
  const r = b as Record<string, unknown>;
  const style = BORDER_STYLE[String(r['style'] ?? 'single')] ?? 'single';
  const width = typeof r['width'] === 'number' ? r['width'] : 10;
  const space = typeof r['space'] === 'number' ? r['space'] : 0;
  return el(name, {
    'w:val': style,
    'w:sz': style === 'none' ? 0 : Math.max(2, Math.min(96, Math.round(width / 2.5))),
    'w:space': Math.max(0, Math.min(31, Math.round(space / 20))),
    'w:color': hex(r['color']),
  });
}

/** Borders in schema order; `sides` names the model's side and Word's element for it. */
export function bordersXml(
  container: string,
  borders: JsonValue | undefined,
  sides: ReadonlyArray<[string, string]>,
): string {
  if (typeof borders !== 'object' || borders === null || Array.isArray(borders)) return '';
  const inner = sides.map(([k, n]) => side(n, (borders as Record<string, unknown>)[k])).join('');
  return inner ? el(container, {}, inner) : '';
}

export const PARAGRAPH_SIDES: ReadonlyArray<[string, string]> = [
  ['top', 'w:top'],
  ['left', 'w:left'],
  ['bottom', 'w:bottom'],
  ['right', 'w:right'],
  ['between', 'w:between'],
];
export const TABLE_SIDES: ReadonlyArray<[string, string]> = [
  ['top', 'w:top'],
  ['left', 'w:left'],
  ['bottom', 'w:bottom'],
  ['right', 'w:right'],
  ['insideH', 'w:insideH'],
  ['insideV', 'w:insideV'],
];
export const CELL_SIDES: ReadonlyArray<[string, string]> = [
  ['top', 'w:top'],
  ['left', 'w:left'],
  ['bottom', 'w:bottom'],
  ['right', 'w:right'],
];

export function shadingXml(shading: JsonValue | undefined): string {
  if (typeof shading !== 'object' || shading === null || Array.isArray(shading)) return '';
  return el('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': hex(shading['fill']) });
}

/** Cell margins: `w:tblCellMar` or `w:tcMar`, in twips. */
export function marginsXml(container: string, m: JsonValue | undefined): string {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return '';
  const r = m as Record<string, unknown>;
  const one = (k: string, n: string): string =>
    typeof r[k] === 'number' ? el(n, { 'w:w': r[k] as number, 'w:type': 'dxa' }) : '';
  const inner =
    one('top', 'w:top') +
    one('left', 'w:left') +
    one('bottom', 'w:bottom') +
    one('right', 'w:right');
  return inner ? el(container, {}, inner) : '';
}

export function tabsXml(tabs: JsonValue | undefined): string {
  if (!Array.isArray(tabs)) return '';
  if (!tabs.length) return '';
  const inner = tabs
    .map((t) => {
      const r = (t ?? {}) as Record<string, unknown>;
      return el('w:tab', {
        'w:val': String(r['align'] ?? 'left'),
        'w:leader': String(r['leader'] ?? 'none'),
        'w:pos': Number(r['position'] ?? 0),
      });
    })
    .join('');
  return el('w:tabs', {}, inner);
}

/** Paragraph properties the lenses do not write (tabs, borders, shading), as extras merged by rank. */
export function paragraphExtras(values: Values): MergedItem[] {
  const out: MergedItem[] = [];
  const tabs = tabsXml(values['tabs']);
  if (tabs) out.push({ name: w('tabs'), raw: tabs });
  const bdr = bordersXml('w:pBdr', values['borders'], PARAGRAPH_SIDES);
  if (bdr) out.push({ name: w('pBdr'), raw: bdr });
  const shd = shadingXml(values['shading']);
  if (shd) out.push({ name: w('shd'), raw: shd });
  return out;
}

export function itemsXml(items: readonly MergedItem[], ns: NamespaceWriter): string {
  return items.map((m) => (isRaw(m) ? m.raw : ns.element(m, new Map()))).join('');
}

export interface StylesInput {
  styles: readonly JsonNode[];
  defaultParagraphStyle: string;
  lang: string | null;
  dir: 'ltr' | 'rtl';
  defaultFont: string | null;
  ctx: LensContext;
  ns: NamespaceWriter;
  /** The `w:numPr` of a style's numbering, if it has one. */
  styleNumPr(style: JsonNode): string | null;
}

/** `styles.xml`: document defaults from the base values, then every style definition. */
export function stylesPart(input: StylesInput): string {
  const { ns, ctx } = input;
  const ids = new Set(input.styles.map((s) => String(s.attrs?.['id'])));
  const fonts = input.defaultFont
    ? el('w:rFonts', {
        'w:ascii': input.defaultFont,
        'w:hAnsi': input.defaultFont,
        'w:cs': input.defaultFont,
        'w:eastAsia': input.defaultFont,
      })
    : '';
  const halfPoints = Math.round(BASE_RUN.fontSize / 10);
  const rPrDefault = el(
    'w:rPr',
    {},
    fonts,
    el('w:sz', { 'w:val': halfPoints }),
    el('w:szCs', { 'w:val': halfPoints }),
    input.lang ? el('w:lang', { 'w:val': input.lang, 'w:bidi': input.lang }) : '',
  );
  const line = Math.round((BASE_PARAGRAPH.lineSpacing * 240) / 1000);
  const pPrDefault = el(
    'w:pPr',
    {},
    BASE_PARAGRAPH.widowControl ? el('w:widowControl') : el('w:widowControl', { 'w:val': '0' }),
    input.dir === 'rtl' ? el('w:bidi') : '',
    el('w:spacing', {
      'w:before': BASE_PARAGRAPH.spaceBefore,
      'w:after': BASE_PARAGRAPH.spaceAfter,
      'w:line': line,
      'w:lineRule': 'auto',
    }),
  );
  const docDefaults = el(
    'w:docDefaults',
    {},
    el('w:rPrDefault', {}, rPrDefault),
    el('w:pPrDefault', {}, pPrDefault),
  );
  const styles = input.styles.map((s) => {
    const a = (s.attrs ?? {}) as Values;
    const id = String(a['id']);
    const kind = String(a['kind'] ?? 'paragraph');
    const builtIn = a['builtIn'] === true ? WORD_BUILT_IN_NAMES[id] : undefined;
    const name = builtIn ?? String(a['name'] ?? id);
    const isDefault =
      (kind === 'paragraph' && id === input.defaultParagraphStyle) ||
      (kind === 'character' && id === 'DefaultParagraphFont') ||
      (kind === 'table' && id === 'TableNormal');
    // Layer 1 of 03 §6 gives every paragraph the default style's properties; Word gives them only
    // to styles based on it, so a root paragraph style is written as based on the default style.
    let basedOn = typeof a['basedOn'] === 'string' ? a['basedOn'] : null;
    if (
      basedOn === null &&
      kind === 'paragraph' &&
      id !== input.defaultParagraphStyle &&
      ids.has(input.defaultParagraphStyle)
    )
      basedOn = input.defaultParagraphStyle;
    const values: Values = { ...a };
    const parts: string[] = [el('w:name', { 'w:val': name })];
    if (basedOn && ids.has(basedOn)) parts.push(el('w:basedOn', { 'w:val': basedOn }));
    if (kind === 'paragraph' && typeof a['next'] === 'string' && ids.has(a['next']))
      parts.push(el('w:next', { 'w:val': a['next'] }));
    if (kind !== 'table') parts.push(el('w:qFormat'));
    if (kind !== 'character') {
      const extras = paragraphExtras(values);
      const numPr = input.styleNumPr(s);
      if (numPr) extras.push({ name: w('numPr'), raw: numPr });
      if (kind === 'table')
        extras.splice(0, extras.length, ...extras.filter((x) => x.name !== w('pBdr')));
      const pPr = itemsXml(mergeContainer(STYLE_PPR, values, [], ctx, extras), ns);
      if (pPr) parts.push(el('w:pPr', {}, pPr));
    }
    const rPr = itemsXml(mergeContainer(STYLE_RPR, values, fontSlots(values), ctx, []), ns);
    if (rPr) parts.push(el('w:rPr', {}, rPr));
    if (kind === 'table') {
      const tblPr =
        (a['bandedRows'] === true ? el('w:tblStyleRowBandSize', { 'w:val': 1 }) : '') +
        bordersXml('w:tblBorders', a['borders'], TABLE_SIDES) +
        marginsXml('w:tblCellMar', a['cellMargins']);
      if (tblPr) parts.push(el('w:tblPr', {}, tblPr));
      const header = shadingXml(a['headerRowShading']);
      if (header)
        parts.push(el('w:tblStylePr', { 'w:type': 'firstRow' }, el('w:tcPr', {}, header)));
    }
    return el(
      'w:style',
      { 'w:type': kind, 'w:default': isDefault ? '1' : null, 'w:styleId': id },
      ...parts,
    );
  });
  return `${XML_DECLARATION}<w:styles${ROOT_DECLARATIONS}>${docDefaults}${styles.join('')}</w:styles>`;
}

// ---------------------------------------------------------------------------------------------
// Numbering.

const LEVEL_JC: Readonly<Record<string, string>> = {
  start: 'left',
  center: 'center',
  end: 'right',
};

/**
 * List instances (03 §4.3; ADR 0032 §2). Word counts per abstract numbering, so two `w:num` of one
 * abstract numbering continue one count; each `listId` therefore gets an abstract numbering of its
 * own (a copy of its definition), and a `numberingRestart` starts a new `w:num` of it with a start
 * override, which the rest of the list then uses.
 */
export class NumberingBuilder {
  /** Abstract numbering per list instance and definition, with the definition it copies. */
  private readonly abstractOf = new Map<string, number>();
  private readonly abstractDefinition: string[] = [];
  private readonly nums: Array<{ abstractNumId: number; overrides: Array<[number, number]> }> = [];
  private readonly current = new Map<string, number>();
  private readonly listDefinitions = new Map<string, Set<string>>();
  readonly defs: ReadonlyMap<string, JsonNode>;

  constructor(defs: ReadonlyMap<string, JsonNode>) {
    this.defs = defs;
  }

  get empty(): boolean {
    return this.nums.length === 0;
  }

  private abstract(listId: string, numberingId: string): number {
    const key = `${listId}\u0000${numberingId}`;
    let n = this.abstractOf.get(key);
    if (n === undefined) {
      n = this.abstractDefinition.length;
      this.abstractOf.set(key, n);
      this.abstractDefinition.push(numberingId);
    }
    return n;
  }

  /** The list instance a paragraph of `listId` on `numberingId` is numbered in. */
  numFor(listId: string, numberingId: string): number | null {
    if (!this.defs.has(numberingId)) return null;
    const key = `${listId}\u0000${numberingId}`;
    let n = this.current.get(key);
    if (n === undefined) {
      this.nums.push({ abstractNumId: this.abstract(listId, numberingId), overrides: [] });
      n = this.nums.length;
      this.current.set(key, n);
    }
    let set = this.listDefinitions.get(listId);
    if (!set) this.listDefinitions.set(listId, (set = new Set()));
    set.add(numberingId);
    return n;
  }

  /** A new instance for `listId` whose `level` starts at `value`; the list continues in it. */
  restart(listId: string, numberingId: string, level: number, value: number): number | null {
    if (!this.defs.has(numberingId)) return null;
    this.nums.push({
      abstractNumId: this.abstract(listId, numberingId),
      overrides: [[level, value]],
    });
    const n = this.nums.length;
    this.current.set(`${listId}\u0000${numberingId}`, n);
    return n;
  }

  /** Lists that span two definitions: Word cannot share their counters (a warning). */
  sharedLists(): string[] {
    return [...this.listDefinitions].filter(([, s]) => s.size > 1).map(([id]) => id);
  }

  part(ctx: LensContext, ns: NamespaceWriter): string {
    const abstracts = this.abstractDefinition.map((numberingId, abstractNumId) => {
      const levels = (this.defs.get(numberingId)?.attrs?.['levels'] ?? []) as Values[];
      const lvls = levels.map((lv, k) => levelXml(lv, k, ctx, ns));
      return el(
        'w:abstractNum',
        { 'w:abstractNumId': abstractNumId },
        el('w:multiLevelType', { 'w:val': levels.length > 1 ? 'multilevel' : 'singleLevel' }),
        ...lvls,
      );
    });
    const nums = this.nums.map((n, i) =>
      el(
        'w:num',
        { 'w:numId': i + 1 },
        el('w:abstractNumId', { 'w:val': n.abstractNumId }),
        ...n.overrides.map(([level, value]) =>
          el('w:lvlOverride', { 'w:ilvl': level }, el('w:startOverride', { 'w:val': value })),
        ),
      ),
    );
    return `${XML_DECLARATION}<w:numbering${ROOT_DECLARATIONS}>${abstracts.join('')}${nums.join('')}</w:numbering>`;
  }
}

/**
 * The number format of a level. `lowerGreek` is Word's custom sequence "α, β, γ, ..." (Word 2010 and
 * later), with `decimal` as the fallback for readers that do not know it (the reverse of the import).
 */
function numFmtXml(format: string): string {
  if (format !== 'lowerGreek') return el('w:numFmt', { 'w:val': format });
  return el(
    'mc:AlternateContent',
    {},
    el(
      'mc:Choice',
      { Requires: 'w14' },
      el('w:numFmt', { 'w:val': 'custom', 'w:format': 'α, β, γ, ...' }),
    ),
    el('mc:Fallback', {}, el('w:numFmt', { 'w:val': 'decimal' })),
  );
}

function levelXml(lv: Values, k: number, ctx: LensContext, ns: NamespaceWriter): string {
  const format = String(lv['format'] ?? 'decimal');
  const text = format === 'bullet' ? String(lv['bulletChar'] ?? '•') : String(lv['text'] ?? '');
  const restartAfter = lv['restartAfter'];
  // ADR 0032: r becomes r + 1 (Word's lvlRestart is 1-based); at or above the level, never (0).
  const lvlRestart =
    typeof restartAfter === 'number' ? (restartAfter >= k ? 0 : restartAfter + 1) : null;
  const ind = el('w:ind', {
    'w:left': typeof lv['indentLeft'] === 'number' ? lv['indentLeft'] : 0,
    'w:hanging': typeof lv['hanging'] === 'number' ? lv['hanging'] : 0,
  });
  const runProps = (lv['runProps'] ?? null) as Values | null;
  const rPr = runProps
    ? itemsXml(
        mergeContainer(RPR, { ...runProps, charStyle: null }, fontSlots(runProps), ctx, []),
        ns,
      )
    : '';
  return el(
    'w:lvl',
    { 'w:ilvl': k },
    el('w:start', { 'w:val': typeof lv['start'] === 'number' ? lv['start'] : 1 }),
    numFmtXml(format),
    lvlRestart === null ? '' : el('w:lvlRestart', { 'w:val': lvlRestart }),
    lv['legal'] === true ? el('w:isLgl') : '',
    el('w:lvlText', { 'w:val': text }),
    el('w:lvlJc', { 'w:val': LEVEL_JC[String(lv['align'] ?? 'start')] ?? 'left' }),
    el('w:pPr', {}, ind),
    rPr ? el('w:rPr', {}, rPr) : '',
  );
}
