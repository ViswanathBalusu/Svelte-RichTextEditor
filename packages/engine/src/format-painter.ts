/**
 * The format painter's core (UX-009; 13 §2; 03 §4.5). `takeFormat` reads the formatting at the
 * start of the selection: the direct character formatting (the marks that clear formatting removes,
 * and the character style) and the paragraph properties of the paragraph that holds it.
 * `paintMarks` and `paintParagraphs` write that onto the selection as transaction steps. The core
 * decides when to dispatch them, so the guard, the access rules and suggestion mode apply as they
 * do to any other change (07 §5, §7; FE-043).
 *
 * Decisions taken here, not in the spec (UX-009 Notes): as in Word, the paragraph properties are
 * taken from a collapsed selection or from one that covers the whole content of the paragraph, and
 * are put only on the paragraphs a collapsed selection is in or a selection covers whole; a part of
 * a paragraph takes the character formatting alone. Which properties are copied is the run
 * properties of 03 §4.5 that clear formatting removes, the character style, and the paragraph
 * style with the alignment, indents, spacing, line spacing and keep rules that `setParagraphFormat`
 * sets. Links, comments, suggestion marks, preserved runs, lists, tabs, borders and shading are not
 * copied. A collapsed selection sets the stored marks, so the next typed text carries the
 * formatting. Under suggestion mode only the paragraph properties that block suggestions record
 * (style and alignment, FE-044) are copied.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Mark, MarkType, Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { PAINTED_MARKS } from './formatting-values.ts';
import { BLOCK_FORMAT_ATTRS } from './suggestion-block.ts';

/** The paragraph properties the painter copies. */
export const PAINTED_PARAGRAPH_ATTRS: readonly string[] = [
  'style',
  'align',
  'indentLeft',
  'indentRight',
  'indentFirstLine',
  'spaceBefore',
  'spaceAfter',
  'lineSpacing',
  'lineRule',
  'keepNext',
  'keepLines',
  'pageBreakBefore',
  'widowControl',
];

/** The formatting taken from a passage. */
export interface FormatSnapshot {
  readonly marks: readonly Mark[];
  readonly paragraph: Readonly<Record<string, unknown>>;
}

/** Whether a selection is collapsed in the paragraph at `pos`, or covers all its content. */
function coversParagraph(pos: number, node: PMNode, from: number, to: number): boolean {
  if (from === to) return true;
  return from <= pos + 1 && to >= pos + node.nodeSize - 1;
}

const isPainted = (m: Mark): boolean => PAINTED_MARKS.includes(m.type.name);

/** The formatting at the start of the selection, or null when the selection is not in a paragraph. */
export function takeFormat(state: EditorState): FormatSnapshot | null {
  const { $from, from, to, empty } = state.selection;
  const paragraph = $from.parent;
  if (paragraph.type.name !== 'paragraph') return null;
  let marks: readonly Mark[];
  if (empty) marks = state.storedMarks ?? $from.marks();
  else {
    let first: readonly Mark[] | null = null;
    state.doc.nodesBetween(from, to, (node) => {
      if (first === null && node.isText) first = node.marks;
      return first === null;
    });
    marks = first ?? [];
  }
  const attrs: Record<string, unknown> = {};
  for (const key of PAINTED_PARAGRAPH_ATTRS)
    if (key in paragraph.attrs) attrs[key] = paragraph.attrs[key];
  return { marks: marks.filter(isPainted), paragraph: attrs };
}

/**
 * Puts the snapshot's character formatting on the selection: the direct formatting the selection
 * had is replaced by it. With a collapsed selection the stored marks are set instead.
 */
export function paintMarks(tr: Transaction, snapshot: FormatSnapshot): Transaction {
  const { from, to, empty, $from } = tr.selection;
  if (empty) {
    const kept = (tr.storedMarks ?? $from.marks()).filter((m) => !isPainted(m));
    return tr.setStoredMarks([...kept, ...snapshot.marks]);
  }
  const types: MarkType[] = PAINTED_MARKS.map((n) => tr.doc.type.schema.marks[n]).filter(
    (t): t is MarkType => t !== undefined,
  );
  for (const type of types) {
    const keep = snapshot.marks.find((m) => m.type === type);
    // A range that already holds exactly the snapshot's mark of this type gets no step for it.
    let differs = false;
    tr.doc.nodesBetween(from, to, (node) => {
      if (
        node.isText &&
        node.marks.some((m) => m.type === type && (keep === undefined || !m.eq(keep)))
      )
        differs = true;
      return !differs;
    });
    if (differs) tr.removeMark(from, to, type);
  }
  for (const mark of snapshot.marks) tr.addMark(from, to, mark);
  return tr;
}

/**
 * Sets the snapshot's paragraph properties on the selected paragraphs that `writable` allows, as
 * attribute steps. With `suggesting`, only the properties a block suggestion records are set.
 * Returns the number of properties changed.
 */
export function paintParagraphs(
  tr: Transaction,
  snapshot: FormatSnapshot,
  writable: (pos: number) => boolean,
  suggesting: boolean,
): number {
  let changed = 0;
  const targets: Array<{ node: PMNode; pos: number }> = [];
  tr.doc.nodesBetween(tr.selection.from, tr.selection.to, (node, pos) => {
    if (node.type.name === 'paragraph') {
      targets.push({ node, pos });
      return false;
    }
    // Footnotes are edited in their own panel; their paragraphs are not part of a body selection.
    return node.type.name !== 'footnote';
  });
  for (const { node, pos } of targets) {
    if (!writable(pos) || !coversParagraph(pos, node, tr.selection.from, tr.selection.to)) continue;
    for (const [key, value] of Object.entries(snapshot.paragraph)) {
      if (suggesting && !BLOCK_FORMAT_ATTRS.has(key)) continue;
      if (!(key in node.attrs) || JSON.stringify(node.attrs[key]) === JSON.stringify(value))
        continue;
      tr.setNodeAttribute(pos, key, value);
      changed++;
    }
  }
  return changed;
}
