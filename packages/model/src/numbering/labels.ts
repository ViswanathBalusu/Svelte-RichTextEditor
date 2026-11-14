/**
 * The one numbering algorithm of 03 §7 (CDM-042): list and heading labels, `seq` caption numbers,
 * numbered equations, footnote marks and the text of cross-references, computed in document order
 * across regions and tables from `numbering_def`, `numbering`, `listId` and `numberingRestart`.
 * Writers print these labels as literal text and keep no counters of their own; page numbers are
 * the one exception (only the typesetter knows them).
 *
 * Counting rules (docs/adr/0032-layout-semantics.md):
 *
 * - A list instance is a `listId`. Each of its nine levels holds a counter that starts at
 *   `start - 1` ("not counted yet"). A paragraph at level L adds one to level L, or sets it to its
 *   `numberingRestart`. Deeper levels then restart (back to `start - 1`) as `restartAfter` says:
 *   null restarts after any higher level; a value r below the level restarts only after levels 0 to
 *   r; a value at or above the level itself means "never restart".
 * - A placeholder `%k` shows level k-1's counter in that level's format (decimal under `legal` for
 *   levels above the paragraph's); a level that was not counted shows `start - 1`, never below 0; a
 *   level that the definition lacks shows nothing.
 * - `seq` fields count per `name`; numbered equation blocks count in the `Equation` sequence.
 * - Footnotes count through the body; with `footnoteRestart: perPageSection` they restart at every
 *   section break. A footnote's paragraph (CDM-001) counts at the footnote's place in the text.
 * - Each header and footer story is numbered on its own; footnotes in stories get no mark.
 *
 * Opaque blocks: a `hidden_region` placeholder (ADR 0019), a `preserved_block` or an
 * `extension_block` contributes nothing of its own. When the caller supplies a `CounterEffect` for
 * its identifier, the effect is applied at its position, so that a projection can show the same
 * numbers as the full document (SR-C3; the owner decides which numbers readers see).
 *
 * The functions read plain JSON or ProseMirror nodes (see `TreeNode`), never write to them, and
 * return the same result for the same input.
 */
import { type NumberingRef, paragraphNumbering } from '../cascade/resolve.ts';
import {
  type Attrs,
  type CascadeError,
  type StyleTable,
  type TreeNode,
  attrsOf,
  eachChild,
  styleTable,
  typeOf,
} from '../cascade/styles.ts';
import { DEFAULT_BULLET, footnoteMark, formatNumber, sequenceFormat } from './format.ts';

/** Levels 0 to 8. */
const LEVELS = 9;
/** The sequence that numbered equation blocks count in (CDM-030). */
export const EQUATION_SEQUENCE = 'Equation';
/** Blocks that contribute only through a supplied effect. */
const OPAQUE_BLOCKS = new Set(['hidden_region', 'preserved_block', 'extension_block']);

export interface ListLabel {
  /** The label to print: the level's template filled in, or its bullet character. */
  readonly text: string;
  readonly kind: 'number' | 'bullet' | 'none';
  readonly numberingId: string;
  readonly level: number;
  readonly listId: string;
}

export interface SequenceLabel {
  /** The `seq` field's `name`; null for a field without one, which counts in no sequence. */
  readonly name: string | null;
  /** The number, 0 for a field without a name. */
  readonly value: number;
  /** The number in the field's format; empty for a field without a name. */
  readonly text: string;
}

export interface DocumentLabels {
  /** Numbered paragraphs (lists and headings), by paragraph identifier. */
  readonly lists: ReadonlyMap<string, ListLabel>;
  /**
   * `seq` fields, by the identifier of the block that holds them (the paragraph, a footnote's
   * paragraph included, or the figure for a figure caption), in the order they occur in it.
   */
  readonly sequences: ReadonlyMap<string, readonly SequenceLabel[]>;
  /** Numbered equation blocks, by identifier: the number, without the parentheses shown at the equation. */
  readonly equations: ReadonlyMap<string, string>;
  /** Footnote marks, by footnote identifier. */
  readonly footnotes: ReadonlyMap<string, string>;
  /**
   * By bookmark name, the block whose label a `ref` to it prints: the footnote for a bookmark in a
   * footnote, else the paragraph or the figure that holds it.
   */
  readonly bookmarks: ReadonlyMap<string, string>;
  /** The equation block of each equation label (for `ref` fields). */
  readonly equationLabels: ReadonlyMap<string, string>;
  /** Styles that could not be resolved; their paragraphs count only through their own `numbering`. */
  readonly problems: readonly CascadeError[];
}

/** How a counter changes across opaque content: by a number of steps, or to a fixed value. */
export type LevelEffect = { readonly add: number } | { readonly set: number };

/**
 * What a stretch of content does to the counters, without its content: per list instance, the
 * definition it was first counted with and one effect per level (missing levels are unchanged);
 * per sequence name, how many numbers it takes; and the footnote marks it takes. Plain JSON, so a
 * server can send it with a projection.
 */
export interface CounterEffect {
  readonly lists?: Readonly<
    Record<string, { readonly numberingId: string; readonly levels: readonly LevelEffect[] }>
  >;
  readonly sequences?: Readonly<Record<string, number>>;
  readonly footnotes?: LevelEffect;
}

export interface LabelOptions {
  /** The document's style table, when the caller already has one. */
  readonly table?: StyleTable;
  /** Effects of opaque blocks, by block identifier (a projection's hidden regions). */
  readonly effects?:
    ReadonlyMap<string, CounterEffect> | Readonly<Record<string, CounterEffect>> | undefined;
}

// ---------------------------------------------------------------------------------------------
// Counter state. A counter is absolute (`abs`: a value) or relative (an increment over an unknown
// value). The real computation starts every new list instance absolute; the computation of an
// effect starts it relative, so that what it ends with is the effect.

interface Counter {
  abs: boolean;
  value: number;
}

interface ListCounters {
  numberingId: string;
  levels: Counter[];
}

class Counters {
  readonly lists = new Map<string, ListCounters>();
  readonly sequences = new Map<string, Counter>();
  footnotes: Counter;
  readonly symbolic: boolean;

  constructor(symbolic: boolean) {
    this.symbolic = symbolic;
    this.footnotes = { abs: !symbolic, value: 0 };
  }

  list(listId: string, numberingId: string, levels: readonly Attrs[]): ListCounters {
    let c = this.lists.get(listId);
    if (!c) {
      c = {
        numberingId,
        levels: Array.from({ length: LEVELS }, (_, k) =>
          this.symbolic ? { abs: false, value: 0 } : { abs: true, value: startOf(levels[k]) - 1 },
        ),
      };
      this.lists.set(listId, c);
    }
    return c;
  }

  sequence(name: string): Counter {
    let c = this.sequences.get(name);
    if (!c) {
      c = { abs: !this.symbolic, value: 0 };
      this.sequences.set(name, c);
    }
    return c;
  }

  apply(effect: CounterEffect, table: StyleTable): void {
    for (const [listId, e] of Object.entries(effect.lists ?? {})) {
      const c = this.list(listId, e.numberingId, table.numberings.get(e.numberingId) ?? []);
      e.levels.forEach((le, k) => {
        if (k < LEVELS) applyLevel(c.levels[k]!, le);
      });
    }
    for (const [name, n] of Object.entries(effect.sequences ?? {})) this.sequence(name).value += n;
    if (effect.footnotes) applyLevel(this.footnotes, effect.footnotes);
  }

  effect(): CounterEffect {
    const lists: Record<string, { numberingId: string; levels: LevelEffect[] }> = {};
    for (const [listId, c] of this.lists) {
      const levels = c.levels.map(toEffect);
      while (levels.length && isIdentity(levels[levels.length - 1]!)) levels.pop();
      lists[listId] = { numberingId: c.numberingId, levels };
    }
    const sequences: Record<string, number> = {};
    for (const [name, c] of this.sequences) if (c.value !== 0) sequences[name] = c.value;
    const out: { -readonly [K in keyof CounterEffect]: CounterEffect[K] } = {};
    if (Object.keys(lists).length) out.lists = lists;
    if (Object.keys(sequences).length) out.sequences = sequences;
    if (!isIdentity(toEffect(this.footnotes))) out.footnotes = toEffect(this.footnotes);
    return out;
  }
}

function applyLevel(c: Counter, e: LevelEffect): void {
  if ('set' in e) {
    c.abs = true;
    c.value = e.set;
  } else c.value += e.add;
}

function toEffect(c: Counter): LevelEffect {
  return c.abs ? { set: c.value } : { add: c.value };
}

function isIdentity(e: LevelEffect): boolean {
  return 'add' in e && e.add === 0;
}

function startOf(level: Attrs | undefined): number {
  const start = level?.['start'];
  return typeof start === 'number' ? start : 1;
}

/** Whether counting a paragraph at `counted` restarts level `level` (`restartAfter`, ADR 0032). */
export function restarts(levelDef: Attrs | undefined, level: number, counted: number): boolean {
  const r = levelDef?.['restartAfter'];
  if (typeof r !== 'number') return true;
  return r < level ? counted <= r : false;
}

/** Fills a level's `text` template (03 §4.1) from the counters of one list instance. */
export function fillTemplate(
  levels: readonly Attrs[],
  level: number,
  values: readonly number[],
): string {
  const own = levels[level];
  const text = own?.['text'];
  if (typeof text !== 'string') return '';
  const legal = own?.['legal'] === true;
  return text.replace(/%([1-9])/g, (_m, digit: string) => {
    const k = Number(digit) - 1;
    const def = levels[k];
    if (!def) return '';
    const format = legal && k < level ? 'decimal' : String(def['format'] ?? 'decimal');
    const bullet = def['bulletChar'];
    return formatNumber(values[k] ?? 0, format, typeof bullet === 'string' ? bullet : null);
  });
}

// ---------------------------------------------------------------------------------------------
// The walk.

interface Sink {
  lists: Map<string, ListLabel>;
  sequences: Map<string, SequenceLabel[]>;
  equations: Map<string, string>;
  footnotes: Map<string, string>;
  bookmarks: Map<string, string>;
  equationLabels: Map<string, string>;
  problems: Map<string, CascadeError>;
}

interface Walk {
  readonly table: StyleTable;
  readonly counters: Counters;
  readonly sink: Sink | null;
  readonly effects: (id: string) => CounterEffect | undefined;
  /** Footnotes get marks in the body only. */
  readonly footnotes: boolean;
  tableStyle: string | null;
}

function idOf(node: TreeNode): string | null {
  const id = attrsOf(node)['id'];
  return typeof id === 'string' ? id : null;
}

function visitBlocks(w: Walk, node: TreeNode): void {
  eachChild(node, (child) => visitBlock(w, child));
}

function visitBlock(w: Walk, node: TreeNode): void {
  const type = typeOf(node);
  switch (type) {
    case 'paragraph':
      visitParagraph(w, node);
      return;
    case 'region':
      visitBlocks(w, node);
      return;
    case 'table': {
      const outer = w.tableStyle;
      const style = attrsOf(node)['style'];
      w.tableStyle = typeof style === 'string' ? style : null;
      eachChild(node, (row) => eachChild(row, (cell) => visitBlocks(w, cell)));
      w.tableStyle = outer;
      return;
    }
    case 'figure': {
      const id = idOf(node);
      eachChild(node, (caption) => visitInlines(w, caption, id, id));
      return;
    }
    case 'equation_block': {
      const attrs = attrsOf(node);
      const id = idOf(node);
      if (attrs['numbered'] === true) {
        const c = w.counters.sequence(EQUATION_SEQUENCE);
        c.value += 1;
        if (w.sink && id) w.sink.equations.set(id, String(c.value));
      }
      const label = attrs['label'];
      if (w.sink && id && typeof label === 'string') w.sink.equationLabels.set(label, id);
      return;
    }
    case 'section_break':
      if (w.footnotes && w.table.settings.footnoteRestart === 'perPageSection')
        w.counters.footnotes = { abs: true, value: 0 };
      return;
    default: {
      if (!OPAQUE_BLOCKS.has(type)) return;
      const id = idOf(node);
      const effect = id ? w.effects(id) : undefined;
      if (effect) w.counters.apply(effect, w.table);
    }
  }
}

/** `note` is the footnote that holds the paragraph, if any: it holds the paragraph's bookmarks. */
function visitParagraph(w: Walk, node: TreeNode, note: string | null = null): void {
  const attrs = attrsOf(node);
  const id = idOf(node);
  // A broken style chain (I4, I5) leaves only the paragraph's own numbering, which
  // `paragraphNumbering` returns before it reads any style.
  const found = paragraphNumbering(w.table, attrs, w.tableStyle);
  let numbering: NumberingRef | null = null;
  if (found.ok) numbering = found.value;
  else w.sink?.problems.set(found.error.styleId, found.error);
  if (numbering) count(w, numbering, attrs['numberingRestart'], id);
  visitInlines(w, node, id, note ?? id);
}

function count(w: Walk, n: NumberingRef, restart: unknown, id: string | null): void {
  const levels = w.table.numberings.get(n.numberingId);
  const level = levels?.[n.level];
  if (!levels || !level || n.level < 0 || n.level >= LEVELS) return;
  const c = w.counters.list(n.listId, n.numberingId, levels);
  const own = c.levels[n.level]!;
  if (typeof restart === 'number') {
    own.abs = true;
    own.value = restart;
  } else own.value += 1;
  for (let d = n.level + 1; d < LEVELS; d++)
    if (restarts(levels[d], d, n.level)) c.levels[d] = { abs: true, value: startOf(levels[d]) - 1 };
  if (!w.sink || !id) return;
  const format = level['format'];
  if (format === 'bullet') {
    const bullet = level['bulletChar'];
    w.sink.lists.set(id, {
      text: typeof bullet === 'string' ? bullet : DEFAULT_BULLET,
      kind: 'bullet',
      ...n,
    });
    return;
  }
  const values = c.levels.map((x) => x.value);
  w.sink.lists.set(id, {
    text: fillTemplate(levels, n.level, values),
    kind: format === 'none' ? 'none' : 'number',
    numberingId: n.numberingId,
    level: n.level,
    listId: n.listId,
  });
}

/**
 * The inline content of a paragraph or caption. `holder` holds its `seq` fields; `anchors` holds
 * its bookmarks, which is the footnote for content in a footnote.
 */
function visitInlines(
  w: Walk,
  node: TreeNode,
  holder: string | null,
  anchors: string | null,
): void {
  eachChild(node, (child) => {
    switch (typeOf(child)) {
      case 'field': {
        const attrs = attrsOf(child);
        if (attrs['kind'] !== 'seq') return;
        const name = attrs['name'];
        let label: SequenceLabel = { name: null, value: 0, text: '' };
        if (typeof name === 'string') {
          const c = w.counters.sequence(name);
          c.value += 1;
          label = {
            name,
            value: c.value,
            text: formatNumber(c.value, sequenceFormat(attrs['format'])),
          };
        }
        if (w.sink && holder) {
          const list = w.sink.sequences.get(holder);
          if (list) list.push(label);
          else w.sink.sequences.set(holder, [label]);
        }
        return;
      }
      case 'footnote': {
        const id = idOf(child);
        if (w.footnotes) {
          w.counters.footnotes.value += 1;
          if (w.sink && id)
            w.sink.footnotes.set(
              id,
              footnoteMark(w.counters.footnotes.value, w.table.settings.footnoteFormat),
            );
        }
        // The note's content counts here, in document order. It is set at the foot of the page,
        // not in a table, so no table style applies to it. A footnote holds paragraphs (CDM-001);
        // an earlier draft held inline content directly, which is still read.
        const outer = w.tableStyle;
        w.tableStyle = null;
        let inline = false;
        eachChild(child, (inner) => {
          if (typeOf(inner) === 'paragraph') visitParagraph(w, inner, id);
          else inline = true;
        });
        if (inline) visitInlines(w, child, id, id);
        w.tableStyle = outer;
        return;
      }
      case 'anchor': {
        const name = attrsOf(child)['name'];
        if (w.sink && anchors && typeof name === 'string') w.sink.bookmarks.set(name, anchors);
        return;
      }
    }
  });
}

function effectLookup(effects: LabelOptions['effects']): (id: string) => CounterEffect | undefined {
  if (!effects) return () => undefined;
  if (effects instanceof Map) return (id) => effects.get(id);
  const record = effects as Readonly<Record<string, CounterEffect>>;
  return (id) => (Object.hasOwn(record, id) ? record[id] : undefined);
}

function newSink(): Sink {
  return {
    lists: new Map(),
    sequences: new Map(),
    equations: new Map(),
    footnotes: new Map(),
    bookmarks: new Map(),
    equationLabels: new Map(),
    problems: new Map(),
  };
}

/**
 * Computes every label of a document: the body first, then each header and footer story on its
 * own. `doc` is the `doc` node (plain JSON or ProseMirror), not the envelope.
 */
export function computeLabels(doc: TreeNode, options: LabelOptions = {}): DocumentLabels {
  const table = options.table ?? styleTable(doc);
  const sink = newSink();
  const effects = effectLookup(options.effects);
  eachChild(doc, (top) => {
    const type = typeOf(top);
    if (type === 'body')
      visitBlocks(
        { table, counters: new Counters(false), sink, effects, footnotes: true, tableStyle: null },
        top,
      );
  });
  eachChild(doc, (top) => {
    if (typeOf(top) === 'story')
      visitBlocks(
        { table, counters: new Counters(false), sink, effects, footnotes: false, tableStyle: null },
        top,
      );
  });
  return {
    lists: sink.lists,
    sequences: sink.sequences,
    equations: sink.equations,
    footnotes: sink.footnotes,
    bookmarks: sink.bookmarks,
    equationLabels: sink.equationLabels,
    problems: [...sink.problems.values()],
  };
}

/**
 * The counter effects of body-level blocks of a full document (normally confidential regions), by
 * identifier, for a projection that replaces them with placeholders. An identifier that names no
 * direct child of the body is left out.
 */
export function counterEffects(
  doc: TreeNode,
  blockIds: Iterable<string>,
  options: Pick<LabelOptions, 'table'> = {},
): Map<string, CounterEffect> {
  const table = options.table ?? styleTable(doc);
  const wanted = new Set(blockIds);
  const out = new Map<string, CounterEffect>();
  eachChild(doc, (top) => {
    if (typeOf(top) !== 'body') return;
    eachChild(top, (block) => {
      const id = idOf(block);
      if (!id || !wanted.has(id)) return;
      const w: Walk = {
        table,
        counters: new Counters(true),
        sink: null,
        effects: () => undefined,
        footnotes: true,
        tableStyle: null,
      };
      visitBlock(w, block);
      out.set(id, w.counters.effect());
    });
  });
  return out;
}

/**
 * The text a `ref` field prints for its `target` (03 §4.4; CDM-036, CDM-042): the label the target
 * carries, as literal text. `node:` names a numbered paragraph or a caption paragraph; `bookmark:`
 * the block that holds the bookmark (a footnote prints its mark); `eq:` a numbered equation. Null
 * when the target carries no label, is hidden from this reader, or is computed elsewhere
 * (`styleRef` needs the page; `formValue` is the fields package's).
 */
export function referenceText(labels: DocumentLabels, target: string): string | null {
  const colon = target.indexOf(':');
  if (colon < 0) return null;
  const scheme = target.slice(0, colon);
  const name = target.slice(colon + 1);
  switch (scheme) {
    case 'node':
      return blockLabel(labels, name);
    case 'bookmark': {
      const holder = labels.bookmarks.get(name);
      if (holder === undefined) return null;
      return labels.footnotes.get(holder) ?? blockLabel(labels, holder);
    }
    case 'eq': {
      const id = labels.equationLabels.get(name);
      return id === undefined ? null : (labels.equations.get(id) ?? null);
    }
    default:
      return null;
  }
}

function blockLabel(labels: DocumentLabels, id: string): string | null {
  const list = labels.lists.get(id);
  if (list) return list.text;
  const seq = labels.sequences.get(id)?.find((s) => s.name !== null);
  return seq ? seq.text : null;
}
