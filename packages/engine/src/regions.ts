/**
 * Regions in the editor (02 §5.2; 07 §7; 03 §4.2):
 *
 * - a selection that starts inside a region stays inside it (FE-038), through the view's selection
 *   hook for pointer and touch selections and after any transaction for keyboard ones, because an
 *   isolating node stops joins but not selections; a selection that starts outside is not clamped,
 *   and a collapsed caret moves across a boundary freely;
 * - Backspace at the start of a region's first paragraph and Delete at the end of its last do
 *   nothing (07 §7), instead of letting the browser merge across the boundary;
 * - a body paragraph follows every region (03 §4.2; FE-039), added in the same state update as the
 *   change that left a region without one.
 */
import { Fragment, type Node, type ResolvedPos, Slice } from 'prosemirror-model';
import {
  type Command,
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from 'prosemirror-state';
import { INTERNAL, REMOTE } from './meta.ts';

export interface RegionSpan {
  id: string | null;
  /** Position before the region node. */
  pos: number;
  /** First and last positions inside it. */
  start: number;
  end: number;
}

/**
 * The identifiers and titles of the regions that are direct children of the body, as one string
 * (PRM-034 criterion 1). Two documents give the same string when no region was added, removed or
 * renamed between them.
 */
export function regionTitleKey(doc: Node): string {
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return '';
  const out: Array<[unknown, unknown]> = [];
  body.forEach((child) => {
    if (child.type.name === 'region') out.push([child.attrs['id'], child.attrs['title']]);
  });
  return JSON.stringify(out);
}

/** The region a position lies in, or null (regions are direct children of the body, I3). */
export function regionAt($pos: ResolvedPos): RegionSpan | null {
  if ($pos.depth < 2) return null;
  if ($pos.node(1).type.name !== 'body') return null;
  const region = $pos.node(2);
  if (region.type.name !== 'region') return null;
  const pos = $pos.before(2);
  return {
    id: typeof region.attrs['id'] === 'string' ? region.attrs['id'] : null,
    pos,
    start: pos + 1,
    end: pos + region.nodeSize - 1,
  };
}

/**
 * The DEP scope of a position of `doc` (05 §5.3): the definitions (`defs`), a story (`story:<id>`),
 * a region (`region:<id>`) or the body (`body`).
 */
export function scopeOfPosition(doc: Node, pos: number): string {
  const $pos = doc.resolve(pos);
  const top = $pos.depth > 0 ? $pos.node(1) : null;
  if (top?.type.name === 'defs') return 'defs';
  if (top?.type.name === 'story') return `story:${String(top.attrs['id'])}`;
  const r = regionAt($pos);
  return r ? `region:${r.id ?? ''}` : 'body';
}

/**
 * The identifier of the `hidden_region` placeholder that follows a body-level position (ADR 0019),
 * or null. A placeholder is a leaf child of the body, so a selection that selects it starts there.
 */
export function placeholderAt($pos: ResolvedPos): string | null {
  if ($pos.depth !== 1 || $pos.parent.type.name !== 'body') return null;
  const node = $pos.nodeAfter;
  if (!node || node.type.name !== 'hidden_region') return null;
  return typeof node.attrs['id'] === 'string' ? node.attrs['id'] : '';
}

/** The first or last text position inside a region. */
function regionTextEdge(doc: Node, r: RegionSpan, side: 'start' | 'end'): number | null {
  const found =
    side === 'start'
      ? Selection.findFrom(doc.resolve(r.start), 1, true)
      : Selection.findFrom(doc.resolve(r.end), -1, true);
  if (!found || found.from < r.start || found.to > r.end) return null;
  return side === 'start' ? found.from : found.to;
}

/**
 * The selection clamped to the region its anchor is in, or null when nothing needs clamping: only
 * text selections that start inside a region and reach outside it (07 §7).
 */
export function clampToRegion(doc: Node, anchor: number, head: number): TextSelection | null {
  if (anchor === head) return null;
  const r = regionAt(doc.resolve(anchor));
  if (!r || (head >= r.start && head <= r.end)) return null;
  const edge = regionTextEdge(doc, r, head < r.start ? 'start' : 'end');
  if (edge === null) return null;
  return TextSelection.create(doc, anchor, edge);
}

/**
 * Backspace at the first position of a region and Delete at its last: consumed, so that nothing is
 * joined across the boundary (07 §7; FE-038 criterion 3).
 */
export function stopAtRegionEdge(side: 'start' | 'end'): Command {
  return (state) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const r = regionAt(sel.$head);
    if (!r) return false;
    return regionTextEdge(state.doc, r, side) === sel.head;
  };
}

export const regionClampKey = new PluginKey('docedit-region-clamp');

/** Clamps selections that start in a region (FE-038). */
export function regionClamp(): Plugin {
  return new Plugin({
    key: regionClampKey,
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.selectionSet || tr.docChanged)) return null;
      const sel = state.selection;
      if (!(sel instanceof TextSelection)) return null;
      const clamped = clampToRegion(state.doc, sel.anchor, sel.head);
      return clamped ? state.tr.setSelection(clamped).setMeta(regionClampKey, true) : null;
    },
    props: {
      createSelectionBetween(view, $anchor, $head) {
        return clampToRegion(view.state.doc, $anchor.pos, $head.pos);
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------
// A body paragraph after every region (03 §4.2; FE-039)

/** Regions (by identifier, or by position for one still without) not followed by a paragraph. */
function regionsWithoutParagraph(doc: Node): Array<{ key: string; after: number }> {
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') return [];
  const out: Array<{ key: string; after: number }> = [];
  let pos = doc.content.size - body.nodeSize + 1;
  body.forEach((child, _offset, index) => {
    const end = pos + child.nodeSize;
    if (child.type.name === 'region') {
      const next = index + 1 < body.childCount ? body.child(index + 1) : null;
      if (!next || next.type.name !== 'paragraph') {
        const id = child.attrs['id'];
        out.push({ key: typeof id === 'string' ? id : `@${pos}`, after: end });
      }
    }
    pos = end;
  });
  return out;
}

/**
 * The document with an empty paragraph after each region that lost its paragraph, or gained one, in
 * the change from `before`. A region that already had none before is left alone: documents from
 * elsewhere are not rewritten, and a person who may edit only a region can still type in it.
 */
export function withParagraphsAfterRegions(after: Node, before: Node): Node {
  const missing = missingParagraphs(after, before);
  if (missing.length === 0) return after;
  const paragraph = after.type.schema.nodes['paragraph']!;
  let doc = after;
  // From the end, so that earlier positions stay valid.
  for (let i = missing.length - 1; i >= 0; i--) {
    const at = missing[i]!;
    doc = doc.replace(at, at, new Slice(Fragment.from(paragraph.create()), 0, 0));
  }
  return doc;
}

/**
 * Where paragraphs are missing after `after`'s regions, in document order: after a region that
 * has none now and had one before, and after a region that did not exist before (identified by its
 * identifier; a region still without one is new by definition).
 */
function missingParagraphs(after: Node, before: Node): number[] {
  const now = regionsWithoutParagraph(after);
  if (now.length === 0) return [];
  const already = new Set(regionsWithoutParagraph(before).map((r) => r.key));
  return now.filter((r) => r.key.startsWith('@') || !already.has(r.key)).map((r) => r.after);
}

export const regionParagraphKey = new PluginKey('docedit-region-paragraph');

/** Keeps a body paragraph after every region a local change touches (FE-039). */
export function regionParagraphs(): Plugin {
  return new Plugin({
    key: regionParagraphKey,
    appendTransaction(trs, old: EditorState, state: EditorState) {
      if (!trs.some((tr) => tr.docChanged && tr.getMeta(REMOTE) !== true)) return null;
      const missing = missingParagraphs(state.doc, old.doc);
      if (missing.length === 0) return null;
      const tr = state.tr;
      const paragraph = state.schema.nodes['paragraph']!;
      for (let i = missing.length - 1; i >= 0; i--) tr.insert(missing[i]!, paragraph.create());
      return tr.setMeta(regionParagraphKey, missing.length).setMeta(INTERNAL, true);
    },
  });
}
