/**
 * What a corpus document contains, computed from the document itself so that the manifest cannot
 * drift from the files: node and character counts, the constructs it uses, and an estimate of its
 * length in pages (FND-006).
 *
 * The page estimate is a line model, not a measurement. It is replaced by the page counts of the
 * S4 LaTeX compile (SPK-017) once that reports them. Its parameters are PAGE_ESTIMATE below and are
 * recorded in the manifest.
 */
import type { JsonEnvelope, JsonNode } from '@docedit/model';

// ---------------------------------------------------------------------------------------------
// Walking

export function* walk(
  node: JsonNode,
  ancestors: readonly JsonNode[] = [],
): Generator<[JsonNode, readonly JsonNode[]]> {
  yield [node, ancestors];
  if (node.content) {
    const next = [...ancestors, node];
    for (const child of node.content) yield* walk(child, next);
  }
}

function some(node: JsonNode, test: (n: JsonNode) => boolean): boolean {
  if (test(node)) return true;
  return (node.content ?? []).some((c) => some(c, test));
}

const attr = (n: JsonNode, key: string): unknown => n.attrs?.[key];
const str = (n: JsonNode | undefined, key: string): string | undefined => {
  const v = n?.attrs?.[key];
  return typeof v === 'string' ? v : undefined;
};
const num = (n: JsonNode | undefined, key: string): number | undefined => {
  const v = n?.attrs?.[key];
  return typeof v === 'number' ? v : undefined;
};

function childrenOf(n: JsonNode, type: string): JsonNode[] {
  return (n.content ?? []).filter((c) => c.type === type);
}

// ---------------------------------------------------------------------------------------------
// Text

/** Han, kana, Hangul, CJK symbols and punctuation, and full-width forms. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  );
}

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;

export interface TextCounts {
  /** Unicode code points in all text runs. */
  characters: number;
  /** Words separated by white space, not counting CJK characters. */
  words: number;
  /** CJK characters, CJK punctuation and full-width forms. */
  cjkCharacters: number;
}

export function countText(s: string): TextCounts {
  let characters = 0;
  let cjk = 0;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    characters++;
    const space = cp === 0x20 || cp === 0x0a || cp === 0x09 || cp === 0xa0 || cp === 0x3000;
    if (isCjk(cp) && cp !== 0x3000) {
      cjk++;
      inWord = false;
    } else if (space) inWord = false;
    else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return { characters, words, cjkCharacters: cjk };
}

/** The text of an inline container (paragraph, caption, footnote), without nested footnotes. */
function inlineText(container: JsonNode): string {
  let out = '';
  for (const c of container.content ?? []) {
    if (c.type === 'text') out += c.text ?? '';
    else if (c.type !== 'footnote') out += inlineText(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Styles, resolved along basedOn (03 §6; only what the estimate and the feature list need)

interface StyleInfo {
  kind: string;
  basedOn: string | null;
  attrs: Record<string, unknown>;
}

export class StyleSheet {
  readonly #styles = new Map<string, StyleInfo>();
  readonly defaultParagraphStyle: string;

  constructor(doc: JsonNode) {
    const defs = childrenOf(doc, 'defs')[0];
    let dps = 'Normal';
    for (const d of defs?.content ?? []) {
      if (d.type === 'settings') dps = str(d, 'defaultParagraphStyle') ?? 'Normal';
      if (d.type === 'style_def') {
        const id = str(d, 'id');
        if (id)
          this.#styles.set(id, {
            kind: str(d, 'kind') ?? 'paragraph',
            basedOn: str(d, 'basedOn') ?? null,
            attrs: d.attrs ?? {},
          });
      }
    }
    this.defaultParagraphStyle = dps;
  }

  /** The first value of `key` from the style up its basedOn chain, or undefined. */
  get(styleId: string | undefined, key: string): unknown {
    let id: string | null = styleId ?? this.defaultParagraphStyle;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const s = this.#styles.get(id);
      if (!s) return undefined;
      const v = s.attrs[key];
      if (v !== undefined && v !== null) return v;
      id = s.basedOn;
    }
    return undefined;
  }

  /** The number of styles from this one to the root of its basedOn chain, both included. */
  chainLength(styleId: string): number {
    let n = 0;
    let id: string | null = styleId;
    const seen = new Set<string>();
    while (id && !seen.has(id) && this.#styles.has(id)) {
      seen.add(id);
      n++;
      id = this.#styles.get(id)!.basedOn;
    }
    return n;
  }

  ids(): string[] {
    return [...this.#styles.keys()];
  }

  kind(id: string): string | undefined {
    return this.#styles.get(id)?.kind;
  }

  builtIn(id: string): boolean {
    return this.#styles.get(id)?.attrs['builtIn'] === true;
  }
}

/** A paragraph's own value, else its style chain's (direct formatting wins, 03 §6). */
function paragraphProp(p: JsonNode, sheet: StyleSheet, key: string): unknown {
  const own = attr(p, key);
  if (own !== undefined && own !== null) return own;
  return sheet.get(str(p, 'style'), key);
}

const outlineLevelOf = (p: JsonNode, sheet: StyleSheet): number | undefined => {
  if (p.type !== 'paragraph') return undefined;
  const v = paragraphProp(p, sheet, 'outlineLevel');
  return typeof v === 'number' ? v : undefined;
};

// ---------------------------------------------------------------------------------------------
// Page estimate

/**
 * The parameters of the page estimate. They describe body text of 11 pt with 1.15 line spacing on
 * an A4 page with 2.54 cm margins (a text block of 451 by 698 points), and are scaled from there for
 * other page setups, columns, indents and font sizes.
 */
export const PAGE_ESTIMATE = {
  status: 'estimated' as const,
  method:
    'Line model: the text of each block is converted to lines, lines to fractions of a page of the page setup in force, and the fractions are summed for each run of pages between forced breaks; each run is rounded up to whole pages.',
  wordsPerLine: 12,
  linesPerPage: 40,
  bodyFontSize: 220,
  rationale: [
    'wordsPerLine: the A4 text block is 451 pt wide; 11 pt serif text sets about 80 to 85 characters per line, and the generated English averages 6 to 7 characters per word with its space. A planning figure, not a measurement.',
    'linesPerPage: the A4 text block is 698 pt high; 11 pt text at 1.15 line spacing has a line pitch of about 15 to 17 pt depending on the line height of the font, about 40 to 45 lines before paragraph spacing; 40 is used. A planning figure, not a measurement.',
    'Words per line and lines per page scale with the column width (page width, margins, columns, indents), the text height and the font size of the paragraph style; a CJK character takes one em.',
    "The space between paragraphs is the larger of the first one's spaceAfter and the second one's spaceBefore (03 §7), in lines of 349 twips (13,958 twips of text height over 40 lines). Inline images taller than a line add their height; footnotes add their lines at the size of FootnoteText.",
    'A table row takes the lines of its fullest cell plus 0.3 lines of padding, or its height when that is fixed; a figure takes its height, half a line and its caption; a display equation takes 1.5 lines plus 1.2 lines per row.',
    'A table of contents takes one line per heading or caption it lists. A page break, pageBreakBefore, or a section break that is not continuous starts a new page.',
  ],
  replacedBy:
    'Measured page counts from the S4 LaTeX compile (SPK-017), once it reports them; until then every page count in this manifest is an estimate.',
};

const LINE_TWIPS = Math.round(13958 / PAGE_ESTIMATE.linesPerPage);

interface Geometry {
  columnWidth: number;
  linesPerPage: number;
}

function geometry(ps: JsonNode | undefined): Geometry {
  const width = num(ps, 'width') ?? 11906;
  const height = num(ps, 'height') ?? 16838;
  const textWidth =
    width -
    (num(ps, 'marginLeft') ?? 1440) -
    (num(ps, 'marginRight') ?? 1440) -
    (num(ps, 'gutter') ?? 0);
  const textHeight = height - (num(ps, 'marginTop') ?? 1440) - (num(ps, 'marginBottom') ?? 1440);
  const columns = num(ps, 'columns') ?? 1;
  const gap = num(ps, 'columnGap') ?? 720;
  return {
    columnWidth: (textWidth - (columns - 1) * gap) / columns,
    linesPerPage: ((PAGE_ESTIMATE.linesPerPage * textHeight) / 13958) * columns,
  };
}

/** Lines taken by the inline content of a paragraph, caption or footnote of the given width. */
function inlineLines(container: JsonNode, width: number, fontSize: number): number {
  const scale = fontSize / PAGE_ESTIMATE.bodyFontSize;
  const t = countText(inlineText(container));
  let words = t.words;
  let extra = 0;
  for (const c of container.content ?? []) {
    if (c.type === 'equation') words += 2;
    if (c.type === 'image') {
      const h = num(c, 'height') ?? 0;
      if (h > LINE_TWIPS) extra += (h - LINE_TWIPS) / LINE_TWIPS;
    }
  }
  const wordsPerLine = (PAGE_ESTIMATE.wordsPerLine * width) / 9026;
  const cjkPerLine = width / PAGE_ESTIMATE.bodyFontSize;
  const lines = Math.max(
    1,
    Math.ceil((words / wordsPerLine + t.cjkCharacters / cjkPerLine) * scale),
  );
  return lines * scale + extra;
}

class BlockCost {
  readonly sheet: StyleSheet;
  #prevSpaceAfter = 0;

  constructor(sheet: StyleSheet) {
    this.sheet = sheet;
  }

  paragraph(p: JsonNode, width: number, tableFontSize: number | undefined): number {
    const s = this.sheet;
    const styled = paragraphProp(p, s, 'fontSize');
    const fontSize = Number(
      (!str(p, 'style') && tableFontSize) || styled || PAGE_ESTIMATE.bodyFontSize,
    );
    const indent =
      Number(paragraphProp(p, s, 'indentLeft') ?? 0) +
      Number(paragraphProp(p, s, 'indentRight') ?? 0);
    const before = Number(paragraphProp(p, s, 'spaceBefore') ?? 0);
    const after = Number(paragraphProp(p, s, 'spaceAfter') ?? 0);
    const gap = Math.max(before, this.#prevSpaceAfter) / LINE_TWIPS;
    this.#prevSpaceAfter = after;
    const w = Math.max(width - indent, width / 4);
    let notes = 0;
    const noteSize = Number(s.get('FootnoteText', 'fontSize') ?? 180);
    for (const c of p.content ?? [])
      if (c.type === 'footnote') notes += inlineLines(c, w, noteSize);
    return gap + inlineLines(p, w, fontSize) + notes;
  }

  /** Lines of a table, and of its tallest row. */
  table(t: JsonNode, width: number): { lines: number; tallestRow: number } {
    const grid = (attr(t, 'grid') as number[] | undefined) ?? [width];
    const total = grid.reduce((a, b) => a + b, 0) || width;
    const scale = Math.min(1, width / total);
    const styled = this.sheet.get(str(t, 'style') ?? 'TableNormal', 'fontSize');
    const tableFontSize = typeof styled === 'number' ? styled : undefined;
    let lines = 0;
    let tallestRow = 0;
    const covered: number[] = [];
    for (const row of t.content ?? []) {
      let col = 0;
      let rowLines = 0;
      for (const cell of row.content ?? []) {
        while ((covered[col] ?? 0) > 0) col++;
        const span = num(cell, 'colspan') ?? 1;
        const rowspan = num(cell, 'rowspan') ?? 1;
        const cellWidth = Math.max(
          grid.slice(col, col + span).reduce((a, b) => a + b, 0) * scale - 216,
          360,
        );
        const saved = this.#prevSpaceAfter;
        this.#prevSpaceAfter = 0;
        let cellLines = 0;
        for (const block of cell.content ?? [])
          cellLines += this.block(block, cellWidth, tableFontSize);
        this.#prevSpaceAfter = saved;
        rowLines = Math.max(rowLines, cellLines / rowspan);
        for (let k = 0; k < span; k++) covered[col + k] = rowspan;
        col += span;
      }
      for (let k = 0; k < covered.length; k++) covered[k] = Math.max(0, (covered[k] ?? 0) - 1);
      const height = num(row, 'height');
      const fixed =
        height !== undefined && str(row, 'heightRule') !== undefined ? height / LINE_TWIPS : 0;
      const r = Math.max(rowLines + 0.3, fixed);
      tallestRow = Math.max(tallestRow, r);
      lines += r;
    }
    this.#prevSpaceAfter = LINE_TWIPS / 2;
    return { lines, tallestRow };
  }

  block(b: JsonNode, width: number, tableFontSize?: number): number {
    switch (b.type) {
      case 'paragraph':
        return this.paragraph(b, width, tableFontSize);
      case 'table':
        return this.table(b, width).lines;
      case 'figure': {
        const caption = childrenOf(b, 'caption')[0];
        const captionSize = Number(this.sheet.get('Caption', 'fontSize') ?? 180);
        this.#prevSpaceAfter = Number(this.sheet.get('Caption', 'spaceAfter') ?? 0);
        const height = num(b, 'height') ?? LINE_TWIPS;
        return height / LINE_TWIPS + 0.5 + (caption ? inlineLines(caption, width, captionSize) : 0);
      }
      case 'equation_block':
        this.#prevSpaceAfter = 0;
        return 1.5 + 1.2 * (str(b, 'latex') ?? '').split('\\\\').length;
      case 'region':
        return (b.content ?? []).reduce((sum, c) => sum + this.block(c, width, tableFontSize), 0);
      default:
        return 1;
    }
  }
}

/** Accumulates the estimated number of pages as body blocks are added in document order. */
export class PageEstimator {
  readonly #sheet: StyleSheet;
  readonly #setups = new Map<string, JsonNode>();
  readonly #cost: BlockCost;
  #geometry: Geometry;
  /** Page fractions of each run of pages between forced breaks. */
  readonly #runs: number[] = [0];
  readonly #tocs: Array<{
    run: number;
    linesPerPage: number;
    of: string;
    min: number;
    max: number;
  }> = [];

  constructor(doc: JsonNode) {
    this.#sheet = new StyleSheet(doc);
    this.#cost = new BlockCost(this.#sheet);
    for (const d of childrenOf(doc, 'defs')[0]?.content ?? []) {
      const id = str(d, 'id');
      if (d.type === 'page_setup' && id) this.#setups.set(id, d);
    }
    this.#geometry = geometry(this.#setups.get(str(childrenOf(doc, 'body')[0], 'pageSetup') ?? ''));
  }

  #newPage(): void {
    if (this.#runs[this.#runs.length - 1]! > 0) this.#runs.push(0);
  }

  #addLines(lines: number): void {
    this.#runs[this.#runs.length - 1]! += lines / this.#geometry.linesPerPage;
  }

  /** One line in each table of contents that lists this block. */
  #listInTocs(block: JsonNode): void {
    if (this.#tocs.length === 0) return;
    const level = outlineLevelOf(block, this.#sheet);
    for (const toc of this.#tocs) {
      const listed =
        toc.of === 'headings'
          ? level !== undefined && level >= toc.min && level <= toc.max
          : some(
              block,
              (n) => n.type === 'field' && str(n, 'kind') === 'seq' && str(n, 'name') === toc.of,
            );
      if (listed) this.#runs[toc.run]! += 1 / toc.linesPerPage;
    }
  }

  add(block: JsonNode): void {
    switch (block.type) {
      case 'section_break':
        if ((str(block, 'start') ?? 'nextPage') !== 'continuous') this.#newPage();
        this.#geometry = geometry(this.#setups.get(str(block, 'pageSetup') ?? ''));
        return;
      case 'toc':
        this.#tocs.push({
          run: this.#runs.length - 1,
          linesPerPage: this.#geometry.linesPerPage,
          of: str(block, 'of') ?? 'headings',
          min: num(block, 'minLevel') ?? 1,
          max: num(block, 'maxLevel') ?? 3,
        });
        this.#addLines(1);
        return;
      case 'region':
        for (const c of block.content ?? []) this.add(c);
        return;
      case 'paragraph':
        if (paragraphProp(block, this.#sheet, 'pageBreakBefore') === true) this.#newPage();
        this.#listInTocs(block);
        this.#addLines(this.#cost.block(block, this.#geometry.columnWidth));
        if ((block.content ?? []).some((n) => n.type === 'break' && str(n, 'kind') === 'page'))
          this.#newPage();
        return;
      default:
        this.#listInTocs(block);
        this.#addLines(this.#cost.block(block, this.#geometry.columnWidth));
    }
  }

  pages(): number {
    return this.#runs.reduce((sum, run) => sum + (run > 0 ? Math.ceil(run - 1e-9) : 0), 0);
  }

  /** The height of a table at the current column width, and of its tallest row, in pages. */
  tableInPages(table: JsonNode): { pages: number; tallestRowPages: number } {
    const t = new BlockCost(this.#sheet).table(table, this.#geometry.columnWidth);
    return {
      pages: t.lines / this.#geometry.linesPerPage,
      tallestRowPages: t.tallestRow / this.#geometry.linesPerPage,
    };
  }

  /** Lines per page of the page setup in force. */
  get linesPerPage(): number {
    return this.#geometry.linesPerPage;
  }
}

export function estimatePages(env: JsonEnvelope): number {
  const est = new PageEstimator(env.doc);
  for (const b of childrenOf(env.doc, 'body')[0]?.content ?? []) est.add(b);
  return est.pages();
}

// ---------------------------------------------------------------------------------------------
// Counts

export interface DocumentStats {
  nodes: number;
  nodesByType: Record<string, number>;
  text: TextCounts;
  /** The longest paragraph, in code points, without its footnotes. */
  longestParagraph: number;
}

export function documentStats(env: JsonEnvelope): DocumentStats {
  const byType = new Map<string, number>();
  let nodes = 0;
  let longest = 0;
  const text: TextCounts = { characters: 0, words: 0, cjkCharacters: 0 };
  for (const [n] of walk(env.doc)) {
    nodes++;
    byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
    if (n.type === 'text') {
      const t = countText(n.text ?? '');
      text.characters += t.characters;
      text.cjkCharacters += t.cjkCharacters;
    }
    if (n.type === 'paragraph' || n.type === 'caption') {
      const t = countText(inlineText(n));
      text.words += t.words;
      if (n.type === 'paragraph') longest = Math.max(longest, t.characters);
    }
  }
  const nodesByType: Record<string, number> = {};
  for (const k of [...byType.keys()].sort()) nodesByType[k] = byType.get(k)!;
  return { nodes, nodesByType, text, longestParagraph: longest };
}

// ---------------------------------------------------------------------------------------------
// Features

interface Numbering {
  numberingId: string;
  level: number;
  listId: string;
}

/**
 * The constructs a document uses, as stable identifiers. The coverage test checks the union over
 * the corpus against FND-006; the manifest records them per document.
 */
export function documentFeatures(env: JsonEnvelope): string[] {
  const f = new Set<string>();
  const doc = env.doc;
  const sheet = new StyleSheet(doc);
  const body = childrenOf(doc, 'body')[0];
  const bodySetup = str(body, 'pageSetup');
  const setups = new Map<string, JsonNode>();
  const numberingDefs = new Map<string, JsonNode>();
  for (const feature of env.requires) f.add(`requires.${feature}`);
  for (const d of childrenOf(doc, 'defs')[0]?.content ?? []) {
    if (d.type === 'page_setup') setups.set(str(d, 'id') ?? '', d);
    if (d.type === 'numbering_def') numberingDefs.set(str(d, 'id') ?? '', d);
    if (d.type === 'role_def') f.add('fields.roles');
    if (d.type === 'rule_def') f.add('fields.rules');
  }

  // Definitions count only when the content uses them: every document carries the same set.
  const usedStyles = new Set<string>([sheet.defaultParagraphStyle]);
  const usedNumbering = new Set<string>();
  const usedSetups = new Set<string>(bodySetup ? [bodySetup] : []);
  for (const [n] of walk(doc)) {
    const style = str(n, 'style');
    if (style && (n.type === 'paragraph' || n.type === 'table')) usedStyles.add(style);
    for (const m of n.marks ?? [])
      if (m.type === 'charStyle' && typeof m.attrs?.['style'] === 'string')
        usedStyles.add(m.attrs['style']);
    const numbering = attr(n, 'numbering') as Numbering | null | undefined;
    if (n.type === 'paragraph' && numbering) usedNumbering.add(numbering.numberingId);
    if (n.type === 'section_break' && str(n, 'pageSetup')) usedSetups.add(str(n, 'pageSetup')!);
  }
  for (const id of usedStyles) {
    const kind = sheet.kind(id) ?? 'paragraph';
    if (!sheet.builtIn(id)) f.add(`styles.named.${kind}`);
    if (sheet.chainLength(id) >= 3) f.add(`styles.basedOnChain.${kind}`);
    if (sheet.chainLength(id) >= 4) f.add('styles.basedOnChain.fourDeep');
    const carried = sheet.get(id, 'numbering') as Numbering | undefined;
    if (carried && kind === 'paragraph') {
      f.add('numbering.inStyle');
      usedNumbering.add(carried.numberingId);
    }
  }
  const levelsOf = (id: string): Array<Record<string, unknown>> =>
    (attr(numberingDefs.get(id) ?? { type: 'x' }, 'levels') as
      Array<Record<string, unknown>> | undefined) ?? [];
  for (const id of usedNumbering) {
    const levels = levelsOf(id);
    if (levels.some((l) => l['legal'] === true)) f.add('numbering.legal');
    if (levels.some((l) => typeof l['restartAfter'] === 'number')) f.add('numbering.restartAfter');
  }

  // Page setups in use.
  for (const id of usedSetups) {
    const ps = setups.get(id);
    if (!ps) continue;
    if (num(ps, 'pageNumberStart') !== undefined) f.add('pageNumbers.restart');
    if ((str(ps, 'pageNumberFormat') ?? 'decimal') !== 'decimal') f.add('pageNumbers.format');
    if (attr(ps, 'differentFirstPage') === true && str(ps, 'headerFirst'))
      f.add('headers.firstPage');
    if (attr(ps, 'differentOddEven') === true && str(ps, 'headerEven')) f.add('headers.evenPage');
  }

  // Sections, and table heights at the width of the section they are in.
  const est = new PageEstimator(doc);
  let columns = (num(setups.get(bodySetup ?? ''), 'columns') ?? 1) > 1;
  let maxTablePages = 0;
  let maxRowPages = 0;
  for (const top of body?.content ?? []) {
    if (top.type === 'section_break') {
      const ps = setups.get(str(top, 'pageSetup') ?? '');
      if (str(top, 'pageSetup') !== bodySetup) f.add('sections.secondPageSetup');
      if (str(ps, 'orientation') === 'landscape') f.add('sections.landscape');
      columns = (num(ps, 'columns') ?? 1) > 1;
      if (columns) f.add('sections.columns');
      f.add(`sections.start.${str(top, 'start') ?? 'nextPage'}`);
    }
    for (const t of top.type === 'region' ? (top.content ?? []) : [top]) {
      if (t.type !== 'table') continue;
      const h = est.tableInPages(t);
      maxTablePages = Math.max(maxTablePages, h.pages);
      maxRowPages = Math.max(maxRowPages, h.tallestRowPages);
      if (columns) f.add('tables.inColumns');
    }
    est.add(top);
  }
  if (maxTablePages > 1) f.add('tables.longerThanPage');
  if (maxRowPages > 1) f.add('tables.rowTallerThanPage');

  // Everything else, node by node.
  const listsByDef = new Map<string, Set<string>>();
  const levelsByList = new Map<string, Set<number>>();
  for (const [n, anc] of walk(doc)) {
    const inside = (t: string): boolean => anc.some((a) => a.type === t);
    switch (n.type) {
      case 'story':
        f.add(str(n, 'kind') === 'footer' ? 'footers' : 'headers');
        break;
      case 'paragraph': {
        const numbering = attr(n, 'numbering') as Numbering | null | undefined;
        if (numbering) {
          const format = levelsOf(numbering.numberingId)[numbering.level]?.['format'];
          f.add(format === 'bullet' ? 'numbering.bullets' : 'numbering.numbered');
          if (!listsByDef.has(numbering.numberingId))
            listsByDef.set(numbering.numberingId, new Set());
          listsByDef.get(numbering.numberingId)!.add(numbering.listId);
          if (!levelsByList.has(numbering.listId)) levelsByList.set(numbering.listId, new Set());
          levelsByList.get(numbering.listId)!.add(numbering.level);
        }
        if (typeof attr(n, 'numberingRestart') === 'number') f.add('numbering.restart');
        const level = outlineLevelOf(n, sheet);
        if (level !== undefined) f.add('headings');
        const length = countText(inlineText(n)).characters;
        if (length > 5000) f.add('paragraphs.over5000');
        for (const key of ['align', 'lineRule'])
          if (str(n, key)) f.add(`paragraphs.${key}.${str(n, key)}`);
        for (const key of [
          'tabs',
          'borders',
          'shading',
          'indentFirstLine',
          'keepNext',
          'keepLines',
          'pageBreakBefore',
        ])
          if (attr(n, key) !== undefined && attr(n, key) !== null) f.add(`paragraphs.${key}`);
        const hasNote = (n.content ?? []).some((c) => c.type === 'footnote');
        if (hasNote && inside('table_cell')) f.add('footnotes.inTable');
        if (hasNote && level !== undefined) f.add('footnotes.inHeading');
        break;
      }
      case 'table':
        f.add('tables');
        if ((num(n, 'headerRows') ?? 0) > 0) f.add('tables.headerRows');
        break;
      case 'table_row':
        if (str(n, 'heightRule')) f.add(`tables.rowHeight.${str(n, 'heightRule')}`);
        if (attr(n, 'cantSplit') === true) f.add('tables.cantSplit');
        break;
      case 'table_cell':
        if ((num(n, 'colspan') ?? 1) > 1) f.add('tables.colspan');
        if ((num(n, 'rowspan') ?? 1) > 1) f.add('tables.rowspan');
        if (attr(n, 'shading')) f.add('tables.cellShading');
        if (attr(n, 'vAlign')) f.add('tables.cellVAlign');
        if (attr(n, 'borders')) f.add('tables.cellBorders');
        break;
      case 'figure':
        f.add('figures');
        if (childrenOf(n, 'caption').length) f.add('figures.caption');
        if (str(n, 'placement') === 'float') f.add('figures.float');
        if (inside('table_cell')) f.add('figures.inTable');
        break;
      case 'image':
        f.add('images.inline');
        if (inside('story')) f.add('images.inHeaderFooter');
        if (inside('footnote')) f.add('images.inFootnote');
        if (inside('caption')) f.add('images.inCaption');
        if (inside('table_cell')) f.add('images.inTable');
        break;
      case 'footnote':
        f.add('footnotes');
        break;
      case 'equation':
        f.add('math.inline');
        if (inside('footnote')) f.add('math.inFootnote');
        break;
      case 'equation_block':
        f.add('math.display');
        if (attr(n, 'numbered') === true) f.add('math.numbered');
        if (inside('table_cell')) f.add('math.inTable');
        break;
      case 'field': {
        f.add(`fields.${str(n, 'kind') ?? 'page'}`);
        if (str(n, 'kind') === 'seq') f.add(`fields.seq.${str(n, 'name')}`);
        const target = str(n, 'target');
        if (target) f.add(`fields.target.${target.split(':')[0]}`);
        if (inside('story')) f.add('fields.inHeaderFooter');
        if (inside('footnote')) f.add('fields.inFootnote');
        break;
      }
      case 'anchor':
        f.add('bookmarks');
        break;
      case 'toc':
        f.add(str(n, 'of') && str(n, 'of') !== 'headings' ? 'toc.captions' : 'toc.headings');
        break;
      case 'region':
        f.add(`regions.${str(n, 'policy') ?? 'inherit'}`);
        break;
      case 'section_break':
        f.add('sections');
        break;
      case 'break':
        f.add(`breaks.${str(n, 'kind') ?? 'line'}`);
        break;
      case 'tab':
        f.add('tabs');
        break;
      case 'form_field':
        f.add('fields.form');
        f.add(`fields.form.${str(n, 'kind') ?? 'text'}`);
        if (str(n, 'assignee')) f.add('fields.form.assigned');
        if (inside('table_cell')) f.add('fields.form.inTable');
        break;
      case 'text': {
        const t = n.text ?? '';
        if (HAN.test(t) || KANA.test(t) || HANGUL.test(t)) {
          const lang = (n.marks ?? []).find((m) => m.type === 'lang')?.attrs?.['value'];
          if (typeof lang === 'string') f.add(`cjk.${lang.split('-')[0]}`);
          if (KANA.test(t)) f.add('cjk.kana');
          if (HANGUL.test(t)) f.add('cjk.hangul');
          if (HAN.test(t)) f.add('cjk.han');
        }
        if (/[\\{}$&#_%^~]/.test(t)) f.add('text.texSpecials');
        if (t.includes(' ')) f.add('text.noBreakSpace');
        if (t.includes('­')) f.add('text.softHyphen');
        if (t.includes('  ')) f.add('text.repeatedSpaces');
        for (const m of n.marks ?? []) {
          f.add(`marks.${m.type}`);
          if (m.type === 'link') {
            const href = String(m.attrs?.['href'] ?? '');
            f.add(
              href.startsWith('#')
                ? 'links.internal'
                : href.startsWith('mailto:')
                  ? 'links.mailto'
                  : 'links.web',
            );
          }
        }
        break;
      }
    }
  }
  for (const lists of listsByDef.values())
    if (lists.size >= 2) f.add('numbering.twoListsOneDefinition');
  for (const levels of levelsByList.values()) if (levels.size >= 3) f.add('numbering.threeLevels');
  return [...f].sort();
}
