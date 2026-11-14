/**
 * Paragraph styles (13 §2, §4; 03 §4.1, §6; FE-127) and the outline (02 §5.1; FE-026).
 *
 * - Applying a style sets the `style` attribute of every selected paragraph the user may edit, with
 *   an attribute step, which keeps the paragraph's identity (CDM-012); nothing else changes, so no
 *   direct formatting is added.
 * - Enter at the end of a paragraph gives the new paragraph the style's `next`; without `next` the
 *   new paragraph keeps the style (OOXML's rule for an absent `w:next`; ADR 0038).
 * - Headings are paragraphs whose style has an `outlineLevel` through `basedOn` (03 §4.3), resolved
 *   with the model's cascade, so custom heading styles count.
 */
import { outlineLevelOf, paragraphStyleOf, styleTable, type StyleTable } from '@docedit/model';
import type { Node } from 'prosemirror-model';
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import type { OutlineItem, StyleInfo } from './api.ts';
import { bodyRange } from './body.ts';

const tables = new WeakMap<Node, StyleTable>();

/** The style table of a document; cached per `defs` node, which changes rarely. */
export function stylesOf(doc: Node): StyleTable {
  const defs = doc.firstChild;
  const key = defs ?? doc;
  let table = tables.get(key);
  if (!table) {
    table = styleTable(doc);
    tables.set(key, table);
  }
  return table;
}

/** The paragraph styles the document defines, in definition order. */
export function paragraphStyles(doc: Node): StyleInfo[] {
  const table = stylesOf(doc);
  const out: StyleInfo[] = [];
  for (const [id, attrs] of table.styles) {
    const kind = attrs['kind'] ?? 'paragraph';
    if (kind !== 'paragraph') continue;
    out.push({
      id,
      name: typeof attrs['name'] === 'string' ? attrs['name'] : id,
      outlineLevel: outlineLevelOf(table, { style: id }),
    });
  }
  return out;
}

/** Whether `id` is a paragraph style of the document. */
export function isParagraphStyle(doc: Node, id: string): boolean {
  const attrs = stylesOf(doc).styles.get(id);
  return attrs !== undefined && (attrs['kind'] ?? 'paragraph') === 'paragraph';
}

/** The paragraphs a selection covers, with their positions, in document order. */
export function selectedParagraphs(state: EditorState): Array<{ node: Node; pos: number }> {
  const { from, to } = state.selection;
  const out: Array<{ node: Node; pos: number }> = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      out.push({ node, pos });
      return false;
    }
    // Footnotes are edited in their own panel; their paragraphs are not part of a body selection.
    return node.type.name !== 'footnote';
  });
  return out;
}

/** The style of the selected paragraphs, or null when they differ or none is selected. */
export function currentStyle(state: EditorState): string | null {
  const table = stylesOf(state.doc);
  let style: string | null = null;
  for (const { node } of selectedParagraphs(state)) {
    const s = paragraphStyleOf(table, node.attrs);
    if (style === null) style = s;
    else if (style !== s) return null;
  }
  return style;
}

/**
 * Applies a paragraph style to the selected paragraphs that `writable` allows (FE-127 criterion 4:
 * only the paragraphs the user may edit change, consistently with the region guard).
 */
export function setParagraphStyle(styleId: string, writable: (pos: number) => boolean): Command {
  return (state, dispatch) => {
    if (!isParagraphStyle(state.doc, styleId)) return false;
    const targets = selectedParagraphs(state).filter(
      ({ node, pos }) => writable(pos) && node.attrs['style'] !== styleId,
    );
    const editable = selectedParagraphs(state).some(({ pos }) => writable(pos));
    if (!editable) return false;
    if (dispatch && targets.length) {
      const tr = state.tr;
      for (const { pos } of targets) tr.setNodeAttribute(pos, 'style', styleId);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Enter at the end of a paragraph: the new paragraph gets the style's `next`, or the same style
 * when the style has none (ADR 0038). Elsewhere it does not apply, and the base keymap splits.
 */
export const enterWithNextStyle: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $pos = sel.$from;
  const para = $pos.parent;
  if (para.type.name !== 'paragraph' || $pos.parentOffset !== para.content.size) return false;
  const table = stylesOf(state.doc);
  const current = paragraphStyleOf(table, para.attrs);
  const next = table.styles.get(current)?.['next'];
  const style = typeof next === 'string' ? next : (para.attrs['style'] ?? null);
  if (dispatch) {
    const tr = state.tr.split($pos.pos, 1, [{ type: para.type, attrs: { style } }]);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Enter at the start of a paragraph that holds content: an empty paragraph with the same attributes
 * (its identifier null, filled in the same update) is inserted before it. The paragraph keeps its
 * node and its identifier, the outcome ADR 0018 asks of a split at the start, and no identifier ever
 * moves between nodes, so neither the change nor its undo carries a step that changes one (I2; the
 * authority refuses such a step).
 */
export const enterAtStart: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty) return false;
  const $pos = sel.$from;
  const para = $pos.parent;
  if (para.type.name !== 'paragraph' || $pos.parentOffset !== 0 || para.content.size === 0)
    return false;
  const index = $pos.index(-1);
  if (!$pos.node(-1).canReplaceWith(index, index, para.type)) return false;
  if (dispatch) {
    const empty = para.type.create({ ...para.attrs, id: null });
    dispatch(state.tr.insert($pos.before(), empty).scrollIntoView());
  }
  return true;
};

const NO_HEADINGS: readonly OutlineItem[] = Object.freeze([]);

/**
 * The headings of each block of the body, by style table and block node. Both are immutable, so a
 * keystroke recomputes the outline of the one block it changed (FE-118: the whole body was walked
 * on every change).
 */
const blockOutlines = new WeakMap<StyleTable, WeakMap<Node, readonly OutlineItem[]>>();

function blockOutline(block: Node, table: StyleTable): readonly OutlineItem[] {
  const out: OutlineItem[] = [];
  const visit = (node: Node): void => {
    if (node.type.name === 'paragraph') {
      const level = outlineLevelOf(table, node.attrs);
      if (level !== null && typeof node.attrs['id'] === 'string')
        out.push({ id: node.attrs['id'], level, text: node.textContent });
      return;
    }
    if (node.type.name !== 'footnote') node.forEach(visit);
  };
  visit(block);
  return out.length ? out : NO_HEADINGS;
}

/** The headings of the body, in document order (02 §5.1 `outline()`; FE-026 criterion 5). */
export function outlineOf(doc: Node): OutlineItem[] {
  const table = stylesOf(doc);
  bodyRange(doc);
  let cache = blockOutlines.get(table);
  if (!cache) {
    cache = new WeakMap();
    blockOutlines.set(table, cache);
  }
  const items: OutlineItem[] = [];
  doc.lastChild!.forEach((block) => {
    let list = cache.get(block);
    if (!list) {
      list = blockOutline(block, table);
      cache.set(block, list);
    }
    for (const item of list) items.push(item);
  });
  return items;
}

/** Whether two outlines are the same, item by item. */
export function sameOutline(a: readonly OutlineItem[], b: readonly OutlineItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x !== y && (x.id !== y.id || x.level !== y.level || x.text !== y.text)) return false;
  }
  return true;
}
