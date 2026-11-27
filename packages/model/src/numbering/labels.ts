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

/** The counters of one list instance after a stretch of content (a counter effect, below). */
export interface ListState {
  readonly numberingId: string;
  /** The counter of each level, from level 0. */
  readonly levels: readonly number[];
  /** The value each level starts at (the definition's `start`, or the last restart value). */
  readonly starts: readonly number[];
}

/**
 * What a stretch of opaque content did to the counters: the state it left behind, for each list
 * instance, sequence and footnote counter it changed (the others are unchanged). The server
 * computes it from the full document (`counterEffects`), so a projection that applies it before
 * the next visible block shows the full document's numbers (ADR 0019, SR-C3). Plain JSON, so a
 * server can send it with a projection. Lists in footnotes count apart from the body's (ADR 0032;
 * owner decision 238), so they have their own entry.
 */
export interface CounterEffect {
  readonly lists?: Readonly<Record<string, ListState>>;
  readonly noteLists?: Readonly<Record<string, ListState>>;
  /** The sequences of the footnote story, which count apart from the body's. */
  readonly noteSequences?: Readonly<Record<string, number>>;
  readonly sequences?: Readonly<Record<string, number>>;
  readonly footnotes?: number;
}

export interface LabelOptions {
  /** The document's style table, when the caller already has one. */
  readonly table?: StyleTable;
  /** Effects of opaque blocks, by block identifier (a projection's hidden regions). */
  readonly effects?:
    ReadonlyMap<string, CounterEffect> | Readonly<Record<string, CounterEffect>> | undefined;
}

// ---------------------------------------------------------------------------------------------
// Counter state.

interface Counter {
  value: number;
}

interface ListCounters {
  numberingId: string;
  levels: Counter[];
  /**
   * The value each level starts at: the definition's `start`, or the value of the last
   * `numberingRestart` at that level, which Word keeps for every later restart of the level (owner
   * decision 238).
   */
  starts: number[];
}

/** Separates the list identifier from a second numbering definition's identifier in a list key. */
const KEY_SEPARATOR = '\u0000';

/** The counters of one story: lists by instance, sequences by name, and the footnote marks. */
class Counters {
  readonly lists = new Map<string, ListCounters>();
  readonly sequences = new Map<string, Counter>();
  /** The definition each `listId` was first counted with: it keeps the plain `listId` as its key. */
  private readonly firstDefinition = new Map<string, string>();
  footnotes: Counter = { value: 0 };

  /**
   * The counters of a list instance. Word counts each numbering definition of a list on its own
   * (owner decision 238), so the instance is the pair of `listId` and definition: the first
   * definition used keeps the plain `listId` as its key, another one gets a longer key.
   */
  list(listId: string, numberingId: string, levels: readonly Attrs[]): ListCounters {
    const first = this.firstDefinition.get(listId);
    if (first === undefined) this.firstDefinition.set(listId, numberingId);
    return this.listByKey(
      first === undefined || first === numberingId
        ? listId
        : `${listId}${KEY_SEPARATOR}${numberingId}`,
      numberingId,
      levels,
    );
  }

  private listByKey(key: string, numberingId: string, levels: readonly Attrs[]): ListCounters {
    let c = this.lists.get(key);
    if (!c) {
      c = {
        numberingId,
        levels: Array.from({ length: LEVELS }, (_, k) => ({ value: startOf(levels[k]) - 1 })),
        starts: Array.from({ length: LEVELS }, (_, k) => startOf(levels[k])),
      };
      this.lists.set(key, c);
    }
    return c;
  }

  sequence(name: string): Counter {
    let c = this.sequences.get(name);
    if (!c) {
      c = { value: 0 };
      this.sequences.set(name, c);
    }
    return c;
  }

  /** Puts the state an effect describes in place of the counters' own. */
  apply(effect: CounterEffect, table: StyleTable): void {
    for (const [key, e] of Object.entries(effect.lists ?? {})) {
      const listId = key.split(KEY_SEPARATOR)[0]!;
      if (key === listId && !this.firstDefinition.has(listId))
        this.firstDefinition.set(listId, e.numberingId);
      this.lists.delete(key);
      const c = this.listByKey(key, e.numberingId, table.numberings.get(e.numberingId) ?? []);
      e.levels.forEach((v, k) => {
        if (k < LEVELS) c.levels[k] = { value: v };
      });
      e.starts.forEach((v, k) => {
        if (k < LEVELS) c.starts[k] = v;
      });
    }
    for (const [name, n] of Object.entries(effect.sequences ?? {})) this.sequence(name).value = n;
    if (effect.footnotes !== undefined) this.footnotes = { value: effect.footnotes };
  }

  /** The state of every list instance, as plain values. */
  listStates(): Map<string, ListState> {
    const out = new Map<string, ListState>();
    for (const [key, c] of this.lists)
      out.set(key, {
        numberingId: c.numberingId,
        levels: c.levels.map((l) => l.value),
        starts: [...c.starts],
      });
    return out;
  }

  sequenceValues(): Map<string, number> {
    return new Map([...this.sequences].map(([name, c]) => [name, c.value]));
  }
}

/** The entries of `after` that differ from `before` (or are new), as a record; null when none. */
function changed<T>(
  before: ReadonlyMap<string, T>,
  after: ReadonlyMap<string, T>,
): Record<string, T> | null {
  const out: Record<string, T> = {};
  for (const [key, value] of after)
    if (JSON.stringify(before.get(key)) !== JSON.stringify(value)) out[key] = value;
  return Object.keys(out).length ? out : null;
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
  // Word prints no label at all for a template that names a level below its own or one the
  // definition lacks (owner decision 238).
  let invalid = false;
  const filled = text.replace(/%([1-9])/g, (_m, digit: string) => {
    const k = Number(digit) - 1;
    const def = levels[k];
    if (!def || k > level) {
      invalid = true;
      return '';
    }
    const format = legal && k < level ? 'decimal' : String(def['format'] ?? 'decimal');
    const bullet = def['bulletChar'];
    return formatNumber(values[k] ?? 0, format, typeof bullet === 'string' ? bullet : null);
  });
  return invalid ? '' : filled;
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
  /** The lists of the footnote story: Word counts them on their own (owner decision 238). */
  readonly noteCounters: Counters;
  /** Whether the walk is inside a footnote's content. */
  inNote: boolean;
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
        w.counters.footnotes = { value: 0 };
      return;
    default: {
      if (!OPAQUE_BLOCKS.has(type)) return;
      const id = idOf(node);
      const effect = id ? w.effects(id) : undefined;
      if (effect) {
        w.counters.apply(effect, w.table);
        w.noteCounters.apply(
          { lists: effect.noteLists ?? {}, sequences: effect.noteSequences ?? {} },
          w.table,
        );
      }
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
  const c = (w.inNote ? w.noteCounters : w.counters).list(n.listId, n.numberingId, levels);
  const own = c.levels[n.level]!;
  // A level above this one that was never counted is counted once, at its start, as Word does
  // for a skipped level (owner decision 238; it shows 1.1.1, not 1.0.1).
  for (let k = 0; k < n.level; k++) {
    const above = c.levels[k]!;
    if (above.value < c.starts[k]!) above.value = c.starts[k]!;
  }
  if (typeof restart === 'number') {
    own.value = restart;
    // Word keeps a restart value as the level's start for the rest of the list (decision 238).
    c.starts[n.level] = restart;
  } else own.value += 1;
  for (let d = n.level + 1; d < LEVELS; d++)
    if (restarts(levels[d], d, n.level)) c.levels[d] = { value: c.starts[d]! - 1 };
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
          const c = (w.inNote ? w.noteCounters : w.counters).sequence(name);
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
        const outerNote = w.inNote;
        w.tableStyle = null;
        w.inNote = true;
        let inline = false;
        eachChild(child, (inner) => {
          if (typeOf(inner) === 'paragraph') visitParagraph(w, inner, id);
          else inline = true;
        });
        if (inline) visitInlines(w, child, id, id);
        w.tableStyle = outer;
        w.inNote = outerNote;
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
        {
          table,
          counters: new Counters(),
          noteCounters: new Counters(),
          inNote: false,
          sink,
          effects,
          footnotes: true,
          tableStyle: null,
        },
        top,
      );
  });
  eachChild(doc, (top) => {
    if (typeOf(top) === 'story')
      visitBlocks(
        {
          table,
          counters: new Counters(),
          noteCounters: new Counters(),
          inNote: false,
          sink,
          effects,
          footnotes: false,
          tableStyle: null,
        },
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
 * identifier, for a projection that replaces them with placeholders. The document is counted once
 * in full; an effect holds what the block changed. An identifier that names no direct child of the
 * body is left out.
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
    const w: Walk = {
      table,
      counters: new Counters(),
      noteCounters: new Counters(),
      inNote: false,
      sink: null,
      effects: () => undefined,
      footnotes: true,
      tableStyle: null,
    };
    eachChild(top, (block) => {
      const id = idOf(block);
      const keep = id !== null && wanted.has(id);
      const before = {
        lists: w.counters.listStates(),
        noteLists: w.noteCounters.listStates(),
        noteSequences: w.noteCounters.sequenceValues(),
        sequences: w.counters.sequenceValues(),
        footnotes: w.counters.footnotes.value,
      };
      visitBlock(w, block);
      if (!keep || id === null) return;
      const effect: { -readonly [K in keyof CounterEffect]: CounterEffect[K] } = {};
      const lists = changed(before.lists, w.counters.listStates());
      const noteLists = changed(before.noteLists, w.noteCounters.listStates());
      const sequences = changed(before.sequences, w.counters.sequenceValues());
      if (lists) effect.lists = lists;
      const noteSequences = changed(before.noteSequences, w.noteCounters.sequenceValues());
      if (noteLists) effect.noteLists = noteLists;
      if (noteSequences) effect.noteSequences = noteSequences;
      if (sequences) effect.sequences = sequences;
      if (w.counters.footnotes.value !== before.footnotes)
        effect.footnotes = w.counters.footnotes.value;
      out.set(id, effect);
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
  // A reference to a numbered paragraph leaves off the label's closing full stops: Word's
  // `REF \w` does (owner decision 238).
  if (list) return list.text.replace(/\.+$/, '');
  const seq = labels.sequences.get(id)?.find((s) => s.name !== null);
  return seq ? seq.text : null;
}
