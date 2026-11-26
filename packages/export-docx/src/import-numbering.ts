/**
 * Word numbering as the model holds it (EXP-100 criterion 3; 03 §4.1, §4.3, §4.5, §7.1). Reads
 * `word/numbering.xml` into `numbering_def` nodes and answers, for a paragraph or a style that names
 * a `w:num`, the `numbering` attribute (`numberingId`, `level`, `listId`) and the restart that the
 * `w:num` carries.
 *
 * Word counts per abstract numbering: every `w:num` of one `w:abstractNum` continues one count unless
 * it carries a start override. So each abstract numbering becomes one definition and one list
 * instance (a fresh `listId`), and a start override of a `w:num` becomes the `numberingRestart` of
 * the first paragraph of that `w:num` at that level (the writer does the reverse, writer-styles.ts).
 * Identifiers are fresh, never taken from the file (03 §9). Nothing is lost on the way back: the
 * part and the paragraph's `w:numPr` stay in the package and the paragraph's preserved formatting.
 *
 * What the grammar of 03 §4.1 cannot hold is reduced and reported: a level template is cut to the
 * placeholders `%1` to `%9` and the punctuation the grammar allows, number formats the model lacks
 * become `decimal`, and a symbol-font bullet becomes the nearest character of the published list.
 */
import type { JsonNode, JsonValue } from '@docedit/model';
import { BULLET_CHARS } from '@docedit/model/definition';
import { NS } from './ooxml.ts';
import { type XmlElement, attr, child, elements } from './xml.ts';

/** Bounds against a hostile part; a real file has a few dozen. */
const MAX_ABSTRACTS = 1024;
const MAX_NUMS = 8192;
const LEVELS = 9;

const FORMATS: Readonly<Record<string, string>> = {
  decimal: 'decimal',
  lowerLetter: 'lowerLetter',
  upperLetter: 'upperLetter',
  lowerRoman: 'lowerRoman',
  upperRoman: 'upperRoman',
  bullet: 'bullet',
  none: 'none',
};

/** Private-use bullets of the symbol fonts (Symbol, Wingdings) and their nearest published character. */
const SYMBOL_BULLETS: Readonly<Record<string, string>> = {
  '': '•',
  '': '▪',
  '': '□',
  '': '➢',
  '': '✓',
  '': '◆',
  '': '□',
  o: '◦',
  '·': '•',
  '§': '▪',
};

const PUBLISHED = new Set<string>(BULLET_CHARS);

interface LevelInfo {
  value: Record<string, JsonValue>;
  /** The paragraph style (Word identifier) this level is linked to, if any. */
  style: string | null;
}

interface AbstractInfo {
  defId: string;
  listId: string;
  levels: LevelInfo[];
}

interface NumInfo {
  abstract: string;
  /** Start overrides, by level. */
  starts: Map<number, number>;
  /** Levels the `w:num` redefines in full, which the model cannot hold per instance. */
  redefined: number;
}

export interface ParagraphNumbering {
  numbering: { numberingId: string; level: number; listId: string };
  restart: number | null;
}

const val = (el: XmlElement | undefined): string | undefined =>
  el ? attr(el, NS.w, 'val') : undefined;

const int = (s: string | undefined): number | null =>
  s !== undefined && /^-?\d{1,9}$/.test(s) ? Number(s) : null;

/**
 * The number format of a level. A format that only Word 2010 and later know (a custom one) sits in
 * `mc:AlternateContent` with a `decimal` fallback; the choice is what Word shows, so it is read.
 */
function numFmtOf(l: XmlElement): string | undefined {
  const direct = val(child(l, NS.w, 'numFmt'));
  if (direct !== undefined) return direct;
  for (const alt of elements(l)) {
    if (alt.ns !== NS.mc || alt.local !== 'AlternateContent') continue;
    const choice = child(alt, NS.mc, 'Choice');
    const fmt = choice ? val(child(choice, NS.w, 'numFmt')) : undefined;
    if (fmt !== undefined) return fmt;
  }
  return undefined;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export class NumberingImport {
  readonly defs: JsonNode[] = [];
  /** Where each definition came from, for the source map: its node, its `w:abstractNum` and the range of that element. */
  readonly sources: Array<{ node: JsonNode; abstractId: string; start: number; end: number }> = [];
  private readonly abstracts = new Map<string, AbstractInfo>();
  private readonly nums = new Map<string, NumInfo>();
  /** The `w:num` and level pairs whose start override has been used. */
  private readonly started = new Set<string>();
  private readonly counts = new Map<string, number>();

  private readonly fresh: () => string;
  private readonly warn: (message: string) => void;

  constructor(root: XmlElement | null, fresh: () => string, warn: (message: string) => void) {
    this.fresh = fresh;
    this.warn = warn;
    if (!root) return;
    const abstractEls = elements(root).filter((e) => e.ns === NS.w && e.local === 'abstractNum');
    for (const el of abstractEls.slice(0, MAX_ABSTRACTS)) this.readAbstract(el);
    if (abstractEls.length > MAX_ABSTRACTS)
      this.warn(`numbering: only the first ${MAX_ABSTRACTS} abstract numberings are read`);
    const numEls = elements(root).filter((e) => e.ns === NS.w && e.local === 'num');
    for (const el of numEls.slice(0, MAX_NUMS)) this.readNum(el);
    for (const [what, n] of this.counts)
      this.warn(`numbering: ${what}${n > 1 ? ` (${n} times)` : ''}`);
  }

  private count(what: string): void {
    this.counts.set(what, (this.counts.get(what) ?? 0) + 1);
  }

  private readAbstract(el: XmlElement): void {
    const id = attr(el, NS.w, 'abstractNumId');
    if (id === undefined || this.abstracts.has(id)) return;
    const byIndex = new Map<number, XmlElement>();
    for (const l of elements(el)) {
      if (l.ns !== NS.w || l.local !== 'lvl') continue;
      const k = int(attr(l, NS.w, 'ilvl'));
      if (k !== null && k >= 0 && k < LEVELS && !byIndex.has(k)) byIndex.set(k, l);
    }
    const highest = Math.max(-1, ...byIndex.keys());
    const levels: LevelInfo[] = [];
    for (let k = 0; k <= highest; k++) levels.push(this.readLevel(byIndex.get(k), k));
    if (levels.length === 0) return;
    const name = val(child(el, NS.w, 'name'));
    const defId = this.fresh();
    this.abstracts.set(id, { defId, listId: this.fresh(), levels });
    const node: JsonNode = {
      type: 'numbering_def',
      attrs: {
        id: defId,
        name: [...(name && name.length <= 128 ? name : `List ${this.abstracts.size}`)]
          .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
          .join(''),
        levels: levels.map((l) => l.value) as JsonValue,
      },
    };
    this.defs.push(node);
    this.sources.push({ node, abstractId: id, start: el.start, end: el.end });
  }

  private readLevel(l: XmlElement | undefined, k: number): LevelInfo {
    if (!l) {
      // A level the file does not define (a gap): the model has no gaps.
      this.count('a level the file leaves undefined is given a default');
      return {
        value: { format: 'decimal', text: `%${k + 1}`, start: 1, restartAfter: null, legal: false },
        style: null,
      };
    }
    const rawFormat = numFmtOf(l) ?? 'decimal';
    let format = FORMATS[rawFormat];
    if (format === undefined) {
      format = 'decimal';
      this.count(`number format ${rawFormat.slice(0, 40)} becomes decimal`);
    }
    const start = int(val(child(l, NS.w, 'start')));
    const rawText = val(child(l, NS.w, 'lvlText')) ?? '';
    const value: Record<string, JsonValue> = {
      format,
      text: '',
      start: clamp(start ?? 0, 0, 32767),
      restartAfter: null,
      legal: child(l, NS.w, 'isLgl') !== undefined && val(child(l, NS.w, 'isLgl')) !== '0',
    };
    if (format === 'bullet') {
      const ch = [...rawText][0] ?? '•';
      const mapped = PUBLISHED.has(ch) ? ch : (SYMBOL_BULLETS[ch] ?? '•');
      if (!PUBLISHED.has(ch))
        this.count('a bullet outside the published list becomes the nearest one');
      value['bulletChar'] = mapped;
    } else if (format !== 'none') {
      const cleaned = (rawText.match(/%[1-9]|[.()§ -]/gu) ?? []).join('').slice(0, 64);
      if (cleaned !== rawText)
        this.count(
          'a level text with characters the grammar lacks is cut to its placeholders and punctuation',
        );
      value['text'] = cleaned;
    }
    const restart = int(val(child(l, NS.w, 'lvlRestart')));
    // The reverse of the writer: Word's value is 1-based, and 0 means never restart.
    if (restart !== null) value['restartAfter'] = restart === 0 ? k : clamp(restart - 1, 0, 8);
    const pPr = child(l, NS.w, 'pPr');
    const ind = pPr ? child(pPr, NS.w, 'ind') : undefined;
    if (ind) {
      const left = int(attr(ind, NS.w, 'left') ?? attr(ind, NS.w, 'start'));
      const hanging = int(attr(ind, NS.w, 'hanging'));
      const first = int(attr(ind, NS.w, 'firstLine'));
      if (left !== null) value['indentLeft'] = clamp(left, -31680, 31680);
      if (hanging !== null) value['hanging'] = clamp(hanging, 0, 31680);
      else if (first !== null && first > 0)
        this.count('a first-line indent of a level is not kept');
    }
    const jc = val(child(l, NS.w, 'lvlJc'));
    if (jc === 'center') value['align'] = 'center';
    else if (jc === 'right' || jc === 'end') value['align'] = 'end';
    else if (jc !== undefined) value['align'] = 'start';
    if (child(l, NS.w, 'rPr'))
      this.count('the formatting of a number label is kept in the file but not shown');
    return { value, style: val(child(l, NS.w, 'pStyle')) ?? null };
  }

  private readNum(el: XmlElement): void {
    const id = attr(el, NS.w, 'numId');
    const abs = val(child(el, NS.w, 'abstractNumId'));
    if (id === undefined || this.nums.has(id) || abs === undefined || !this.abstracts.has(abs))
      return;
    const starts = new Map<number, number>();
    let redefined = 0;
    for (const o of elements(el)) {
      if (o.ns !== NS.w || o.local !== 'lvlOverride') continue;
      const k = int(attr(o, NS.w, 'ilvl'));
      if (k === null || k < 0 || k >= LEVELS) continue;
      const s = int(val(child(o, NS.w, 'startOverride')));
      if (s !== null) starts.set(k, clamp(s, 0, 32767));
      if (child(o, NS.w, 'lvl')) {
        redefined++;
        this.count('a list that redefines a level of its numbering uses the numbering’s own level');
      }
    }
    this.nums.set(id, { abstract: abs, starts, redefined });
  }

  /** The numbering a paragraph with `w:numPr` has; null when the file's `w:num` is not known or is 0. */
  forParagraph(numId: string | undefined, ilvl: string | undefined): ParagraphNumbering | null {
    if (numId === undefined) return null;
    const num = this.nums.get(numId);
    if (!num) return null;
    const abs = this.abstracts.get(num.abstract)!;
    const level = clamp(int(ilvl) ?? 0, 0, LEVELS - 1);
    if (level >= abs.levels.length) return null;
    let restart: number | null = null;
    const start = num.starts.get(level);
    if (start !== undefined && !this.started.has(`${numId}:${level}`)) {
      restart = start;
      this.started.add(`${numId}:${level}`);
    }
    return {
      numbering: { numberingId: abs.defId, level, listId: abs.listId },
      restart,
    };
  }

  /** The numbering of a paragraph style (headings numbered through their style). */
  forStyle(
    numId: string | undefined,
    ilvl: string | undefined,
    styleWordId: string,
  ): { numberingId: string; level: number; listId: string } | null {
    if (numId === undefined) return null;
    const num = this.nums.get(numId);
    if (!num) return null;
    const abs = this.abstracts.get(num.abstract)!;
    let level = int(ilvl);
    if (level === null) {
      const linked = abs.levels.findIndex((l) => l.style === styleWordId);
      level = linked >= 0 ? linked : 0;
    }
    level = clamp(level, 0, LEVELS - 1);
    if (level >= abs.levels.length) return null;
    return { numberingId: abs.defId, level, listId: abs.listId };
  }
}
