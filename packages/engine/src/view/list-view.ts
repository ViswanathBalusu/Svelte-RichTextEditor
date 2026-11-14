/**
 * List semantics in the web view (02 §10; 03 §4.3; FE-105). The model has no list nodes: a
 * paragraph with `numbering` is a list item of the list named by its `listId` (CDM-042). This
 * plugin gives each such paragraph `role="listitem"`, `aria-level`, `aria-posinset` and
 * `aria-setsize` as node decorations, from `listSemantics` (list-semantics.ts), so that a screen
 * reader can announce its position, the list's size and its level.
 *
 * - Positions are counted per `listId` over the whole body in document order, through regions,
 *   tables, cells and items of other lists, with the numbering resolved through the style cascade,
 *   so a list keeps the numbering and position of its computed label (FE-105 criterion 4).
 *   Paragraphs without numbering are skipped, as the computed label skips them.
 * - A numbered heading keeps its heading role: it is counted in its list, but no list attributes
 *   replace the heading semantics, which navigation by headings needs. This is a reading taken
 *   here, not stated by the spec (FE-105 notes).
 * - Nothing gives the items a `role="list"` parent yet, which ARIA requires of a `listitem`
 *   (FE-105 criterion 3 stays open).
 */
import type { Node as PMNode, Fragment } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceStep,
} from 'prosemirror-transform';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { type StyleTable, paragraphNumbering, styleTable } from '@docedit/model';
import { type ListParagraph, listSemantics } from '../list-semantics.ts';
import { headingLevel } from '../schema.ts';

export const listSemanticsKey = new PluginKey<DecorationSet>('docedit-list-semantics');

/** Levels 0 to 8 (CDM-042); `computeLabels` counts no paragraph outside them. */
const LEVELS = 9;

/**
 * An item of a list, in document order: the paragraph, its position in the body view (null for a
 * paragraph the body view does not show, such as a footnote's), and what the list rules read.
 */
interface Item {
  readonly node: PMNode;
  readonly pos: number | null;
  readonly list: ListParagraph;
}

interface Walk {
  readonly table: StyleTable;
  /** The style of the table being walked, which the numbering cascade reads (layer 2). */
  tableStyle: string | null;
  readonly out: Item[];
}

/**
 * The paragraph's list item, or null when it is in no list. The numbering is resolved as
 * `computeLabels` resolves it (`paragraphNumbering`: the paragraph's own `numbering`, else its
 * styles'), and a paragraph whose style chain is broken counts only through its own numbering, as
 * there.
 */
function itemOf(w: Walk, node: PMNode, pos: number | null): Item | null {
  const found = paragraphNumbering(w.table, node.attrs, w.tableStyle);
  const n = found.ok ? found.value : null;
  if (!n || n.listId === '' || n.level < 0 || n.level >= LEVELS) return null;
  const restart = typeof node.attrs['numberingRestart'] === 'number';
  return { node, pos, list: { listId: n.listId, level: n.level, ...(restart ? { restart } : {}) } };
}

/**
 * The paragraphs of `container` in document order, whose content starts at `start`, in the order
 * `computeLabels` counts them (03 §7): regions, tables, rows and cells are transparent, and a
 * footnote's paragraphs count at the footnote's place in the text.
 */
function collect(w: Walk, container: PMNode, start: number): void {
  container.forEach((child, offset) => {
    const pos = start + offset;
    if (child.type.name === 'paragraph') {
      const item = itemOf(w, child, pos);
      if (item) w.out.push(item);
      collectFootnotes(w, child);
      return;
    }
    if (child.isTextblock || child.isLeaf || child.inlineContent) return;
    if (child.type.name === 'table') {
      const outer = w.tableStyle;
      const style = child.attrs['style'];
      w.tableStyle = typeof style === 'string' ? style : null;
      collect(w, child, pos + 1);
      w.tableStyle = outer;
      return;
    }
    collect(w, child, pos + 1);
  });
}

/** A footnote's paragraphs: counted in their lists, not decorated (the body view shows the mark). */
function collectFootnotes(w: Walk, paragraph: PMNode): void {
  paragraph.forEach((inline) => {
    if (inline.type.name !== 'footnote') return;
    const outer = w.tableStyle;
    w.tableStyle = null;
    inline.forEach((p) => {
      if (p.type.name !== 'paragraph') return;
      const item = itemOf(w, p, null);
      if (item) w.out.push(item);
    });
    w.tableStyle = outer;
  });
}

/**
 * The list decorations of the body (definitions and stories are not in the body view).
 *
 * The position follows the computed label (`computeLabels`, 03 §7), which counts each list by its
 * `listId` across the whole body: the items are grouped by `listId` and each list is passed to
 * `listSemantics` on its own, so a paragraph without numbering, a region or table boundary, or an
 * item of another list between two items does not end the list. A `numberingRestart` starts a new
 * set at its level. Positions are ordinals from 1 whatever the level's `start`, as in an HTML
 * `<ol start>`.
 */
export function listDecorations(doc: PMNode): DecorationSet {
  const w: Walk = { table: styleTable(doc), tableStyle: null, out: [] };
  doc.forEach((child, offset) => {
    if (child.type.name === 'body') collect(w, child, offset + 1);
  });
  const lists = new Map<string, Item[]>();
  for (const item of w.out) {
    const group = lists.get(item.list.listId);
    if (group) group.push(item);
    else lists.set(item.list.listId, [item]);
  }
  const out: Decoration[] = [];
  for (const group of lists.values()) {
    listSemantics(group.map((item) => item.list)).forEach((s, i) => {
      const { node, pos } = group[i]!;
      if (!s || pos === null || headingLevel(node.attrs['style']) !== null) return;
      out.push(
        Decoration.node(pos, pos + node.nodeSize, {
          role: s.role,
          'aria-level': String(s['aria-level']),
          'aria-posinset': String(s['aria-posinset']),
          'aria-setsize': String(s['aria-setsize']),
        }),
      );
    });
  }
  return DecorationSet.create(doc, out);
}

const inlineOnly = (content: Fragment): boolean => {
  let inline = true;
  content.forEach((n) => {
    if (!n.isInline) inline = false;
  });
  return inline;
};

/**
 * Whether a transaction may change list membership, positions or levels. Typing and mark changes
 * inside one paragraph cannot, so the decorations only move with the text; anything else (a split,
 * a join, an attribute such as `numbering`, a remote rebuild) recomputes them.
 */
export function mayRelist(tr: Transaction): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!;
    if (
      step instanceof AddMarkStep ||
      step instanceof RemoveMarkStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    )
      continue;
    if (step instanceof ReplaceStep) {
      const doc = tr.docs[i]!;
      const { slice } = step;
      if (slice.openStart === 0 && slice.openEnd === 0 && inlineOnly(slice.content)) {
        const $from = doc.resolve(step.from);
        if ($from.parent.inlineContent && $from.sameParent(doc.resolve(step.to))) continue;
      }
    }
    return true;
  }
  return false;
}

/** The list semantics of numbered paragraphs as node decorations (FE-105). */
export function listSemanticsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: listSemanticsKey,
    state: {
      init: (_config, state) => listDecorations(state.doc),
      apply: (tr, value) => {
        if (!tr.docChanged) return value;
        return mayRelist(tr) ? listDecorations(tr.doc) : value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return listSemanticsKey.getState(state) ?? null;
      },
    },
  });
}
