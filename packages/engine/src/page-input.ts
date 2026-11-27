/**
 * What the page view needs from the editing core (02 §9.6; FE-098; ADR 0380): the selection and the
 * text as block identifiers and offsets, an edit of one block's text, and a key press. The page view
 * paints pages from the layout tree and has no ProseMirror of its own, so every change it makes goes
 * through the core's transaction path: the guards, suggestion mode, the sync queue and the history
 * see it as they see an edit in the web view.
 *
 * A block is a text block of the body that has an `id` (a paragraph, a heading, a paragraph in a
 * table cell). Text blocks inside a footnote or a story (header, footer) are edited in the panel, as
 * in the web view (FE-056), so a position there is not a page-view position. An offset counts as the
 * layout counts (CDM positions in the block): a character is one, and an inline atom is one.
 *
 * No DOM; the pure functions here take a ProseMirror state.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { CdmEnvelope, CommandName } from './api.ts';
import { press } from './keys.ts';

/** A place in the body: a block and an offset inside it. */
export interface BlockPoint {
  readonly blockId: string;
  readonly offset: number;
}

/** A selection of the body as two block points. */
export interface BlockSelection {
  readonly anchor: BlockPoint;
  readonly head: BlockPoint;
}

/** The character that stands for an inline atom in `blockText`, so that offsets still count. */
export const ATOM_CHAR = '￼';

/** Node types whose text blocks are not body text blocks (they have their own panel). */
const OUTSIDE = new Set(['defs', 'story', 'footnote']);

/** The text of a text block as the layout counts it: text as it is, an atom as `ATOM_CHAR` for each position. */
export function blockText(node: PMNode): string {
  let out = '';
  node.forEach((child) => {
    out += child.isText ? (child.text ?? '') : ATOM_CHAR.repeat(child.nodeSize);
  });
  return out;
}

/** The text block of the body with this identifier, with the position before it; null when there is none. */
export function findBlock(
  doc: PMNode,
  id: string,
): { readonly pos: number; readonly node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (OUTSIDE.has(node.type.name)) return false;
    if (node.isTextblock && node.attrs['id'] === id) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/** The block point of a document position, or null when it is not in a body text block with an identifier. */
export function pointAt(doc: PMNode, pos: number): BlockPoint | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  const id: unknown = parent.attrs['id'];
  if (!parent.isTextblock || typeof id !== 'string') return null;
  for (let d = $pos.depth; d > 0; d--) if (OUTSIDE.has($pos.node(d).type.name)) return null;
  return { blockId: id, offset: $pos.parentOffset };
}

/** The document position of a block point, or null for a block that is not there. The offset is clamped. */
export function positionOf(doc: PMNode, point: BlockPoint): number | null {
  const block = findBlock(doc, point.blockId);
  if (block === null) return null;
  const offset = Math.max(0, Math.min(point.offset, block.node.content.size));
  return block.pos + 1 + offset;
}

/** The selection as block points; null when it is not a text range in the body (a node or gap selection, a story). */
export function selectionOf(state: EditorState): BlockSelection | null {
  const { $anchor, $head } = state.selection;
  const anchor = pointAt(state.doc, $anchor.pos);
  const head = pointAt(state.doc, $head.pos);
  if (anchor === null || head === null) return null;
  return { anchor, head };
}

/** A transaction that selects between two block points; null when either block is not there. */
export function selectTransaction(
  state: EditorState,
  anchor: BlockPoint,
  head: BlockPoint,
): Transaction | null {
  const a = positionOf(state.doc, anchor);
  const h = positionOf(state.doc, head);
  if (a === null || h === null) return null;
  return state.tr.setSelection(TextSelection.create(state.doc, a, h)).scrollIntoView();
}

/**
 * A transaction that replaces `[from, to)` of a block's text with `text` and puts the caret at
 * `caret` (an offset in the block after the change; the end of the new text when absent). The text
 * takes the marks at the start of the range, or the stored marks. Null when the block is not there
 * or the range is not inside it.
 */
export function replaceTransaction(
  state: EditorState,
  blockId: string,
  from: number,
  to: number,
  text: string,
  caret?: number,
): Transaction | null {
  const block = findBlock(state.doc, blockId);
  if (block === null) return null;
  const size = block.node.content.size;
  if (from < 0 || to < from || to > size) return null;
  const start = block.pos + 1;
  const tr = state.tr;
  if (text === '') tr.delete(start + from, start + to);
  else tr.insertText(text, start + from, start + to);
  const after = Math.max(
    0,
    Math.min(caret ?? from + text.length, tr.doc.nodeAt(block.pos)?.content.size ?? 0),
  );
  // The block keeps its place: an edit inside it moves nothing before it.
  if (tr.doc.nodeAt(block.pos)?.attrs['id'] === blockId)
    tr.setSelection(TextSelection.create(tr.doc, start + after));
  return tr;
}

/**
 * The point one step from `point` in reading order: one position in the block, or the end of the
 * previous text block or the start of the next one. The same point when there is no such block.
 */
export function stepFrom(doc: PMNode, point: BlockPoint, direction: 'left' | 'right'): BlockPoint {
  const blocks: Array<{ id: string; size: number }> = [];
  doc.descendants((node) => {
    if (OUTSIDE.has(node.type.name)) return false;
    const id: unknown = node.attrs['id'];
    if (node.isTextblock && typeof id === 'string') blocks.push({ id, size: node.content.size });
    return true;
  });
  const i = blocks.findIndex((b) => b.id === point.blockId);
  const here = blocks[i];
  if (here === undefined) return point;
  if (direction === 'left') {
    if (point.offset > 0) return { blockId: point.blockId, offset: point.offset - 1 };
    const prev = blocks[i - 1];
    return prev ? { blockId: prev.id, offset: prev.size } : point;
  }
  if (point.offset < here.size) return { blockId: point.blockId, offset: point.offset + 1 };
  const next = blocks[i + 1];
  return next ? { blockId: next.id, offset: 0 } : point;
}

/** The block identifiers and sizes of the body's text blocks, in document order. */
export function textBlocks(doc: PMNode): Array<{ readonly id: string; readonly size: number }> {
  const out: Array<{ id: string; size: number }> = [];
  doc.descendants((node) => {
    if (OUTSIDE.has(node.type.name)) return false;
    const id: unknown = node.attrs['id'];
    if (node.isTextblock && typeof id === 'string') out.push({ id, size: node.content.size });
    return true;
  });
  return out;
}

/** What the page view tells the core it needs (`EditorCore.attachPageView`). */
export interface PageViewHooks {
  /**
   * A new state was applied: `docChanged` when the document differs (a local or remote change, or a
   * replaced document), `replaced` when the state was replaced and not changed by a transaction.
   */
  update(docChanged: boolean, replaced: boolean): void;
  /** Something asked the core to take focus; the page view takes it in its input bridge. */
  focus(): void;
}

/** The page view's handle on the core (`EditorCore.attachPageView`). */
export interface PageViewHandle {
  /** The document as the core holds it now, for the layout. */
  content(): CdmEnvelope;
  /** The selection as block points; null when it is not a text range in the body. */
  selection(): BlockSelection | null;
  /** Selects between two block points (a caret when `head` is absent). False when a block is not there. */
  select(anchor: BlockPoint, head?: BlockPoint): boolean;
  /** The text of a block as the layout counts it (`ATOM_CHAR` for an atom); null when it is not there. */
  text(blockId: string): string | null;
  /** The body's text blocks in document order. */
  blocks(): Array<{ readonly id: string; readonly size: number }>;
  /**
   * Replaces `[from, to)` of a block's text and puts the caret at `caret`. False when nothing changed:
   * the block is not there, the core is read-only, or the guard refused the change.
   */
  replace(blockId: string, from: number, to: number, text: string, caret?: number): boolean;
  /** Runs the body view's binding for a key name such as `Enter`, `Backspace` or `Mod-b`; false when none applies. */
  key(key: string): boolean;
  /** The point one step to the left or right in reading order. */
  step(point: BlockPoint, direction: 'left' | 'right'): BlockPoint;
  /** The blocks changed since the last call, for the incremental layout (`takeLayoutDirty`). */
  takeDirty(): ReadonlySet<string>;
  /** Copy, cut and paste at the selection, through the core's policy as in the web view (FE-050 to FE-055). */
  copy(event: ClipboardEvent): void;
  cut(event: ClipboardEvent): void;
  /** True, and the event is cancelled, when the paste was taken. */
  paste(event: ClipboardEvent): boolean;
  /** Runs a core command by name (`undo`, `redo`, `bold`, ...); false when it did not apply. */
  run(command: CommandName): boolean;
  /** Tells the core which block an input method is composing in (null when it ended), so a remote change waits (FE-034). */
  composing(blockId: string | null): void;
  readOnly(): boolean;
  /**
   * The control of a form field of the document, the one the web view draws (FRW-004; FE-101
   * criterion 5): the same element for the same field until `keepFieldControls` lets it go, drawn
   * from the field as it is now. Null when the field is not in the document, or when the module that
   * draws fields is not loaded yet; it is then loaded, and `hooks.update(true, false)` follows.
   */
  fieldControl(id: string): HTMLElement | null;
  /** Lets go of the controls of the fields not in `ids`: the page view painted these and no others. */
  keepFieldControls(ids: ReadonlySet<string>): void;
  detach(): void;
}

/** The key presses of the body view's bindings that the page view hands on (`Enter`, `Backspace`, `Mod-b`, ...). */
export function pressKey(
  state: EditorState,
  key: string,
  dispatch: (tr: Transaction) => void,
): boolean {
  return press(state.schema, key, state, dispatch);
}
