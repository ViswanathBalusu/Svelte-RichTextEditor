/**
 * Creating, changing and deleting a style (UX-022 criteria 2 and 3; 03 §4.1 `style_def`; 07 §5.3,
 * §7). A style is a definition in `defs`. The builders here only edit the document; whether the user
 * may (the `structure` capability, the `defs` scope, the regions that use the style) is decided by
 * the core, which passes the answer in, and the authority decides the same rule again on the server
 * (PRM-012).
 *
 * Decisions taken here, not in the spec (UX-022 Notes):
 * - A built-in style is neither renamed nor deleted; its identifier is a reserved name.
 * - A style that something still uses is not deleted: a paragraph, a table or a run in it, a style
 *   based on it or naming it as `next`, or the document's default paragraph style.
 * - A new style takes a random identifier of the core's own source (03 §4.1), and its name must be
 *   new among the styles of its kind (compared without regard to case).
 * - A style is based on a style of the same kind (the CDM, I4), and never on itself or on a style that
 *   is based on it.
 */
import type { Node } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import type { StyleKind } from './api.ts';

/** Why a style cannot be created, changed or deleted by the document alone. */
export type StyleDocRefusal =
  'unknown-style' | 'built-in' | 'in-use' | 'duplicate-name' | 'bad-name' | 'bad-based-on';

export interface StyleChanges {
  readonly name?: string;
  readonly basedOn?: string | null;
}

interface Located {
  readonly pos: number;
  readonly node: Node;
}

/** The style definitions of `defs`, with their positions, in document order. */
function definitions(doc: Node): { styles: Located[]; insertAt: number } {
  const defs = doc.firstChild;
  const styles: Located[] = [];
  if (!defs || defs.type.name !== 'defs') return { styles, insertAt: 1 };
  let insertAt = 1;
  defs.forEach((child, offset) => {
    const pos = 1 + offset;
    if (child.type.name === 'style_def') {
      styles.push({ pos, node: child });
      insertAt = pos + child.nodeSize;
    } else if (child.type.name === 'settings' && styles.length === 0) {
      insertAt = pos + child.nodeSize;
    }
  });
  return { styles, insertAt };
}

const kindOf = (node: Node): StyleKind => (node.attrs['kind'] as StyleKind | null) ?? 'paragraph';

/** Whether the style `id` has `candidate` among its ancestors through `basedOn`, or is it. */
function basedOnChain(styles: readonly Located[], from: string | null, target: string): boolean {
  const byId = new Map(styles.map((s) => [String(s.node.attrs['id']), s.node] as const));
  for (let cur = from, guard = 0; cur !== null && guard < 64; guard++) {
    if (cur === target) return true;
    const parent: unknown = byId.get(cur)?.attrs['basedOn'];
    cur = typeof parent === 'string' ? parent : null;
  }
  return false;
}

/** How many places of the document name the style: paragraphs, tables, runs, styles and settings. */
export function styleReferences(doc: Node, id: string): number {
  let n = 0;
  doc.descendants((node) => {
    const name = node.type.name;
    if ((name === 'paragraph' || name === 'table') && node.attrs['style'] === id) n++;
    if (name === 'style_def' && node.attrs['id'] !== id) {
      if (node.attrs['basedOn'] === id) n++;
      if (node.attrs['next'] === id) n++;
    }
    if (name === 'settings' && node.attrs['defaultParagraphStyle'] === id) n++;
    for (const m of node.marks) if (m.type.name === 'charStyle' && m.attrs['style'] === id) n++;
    return true;
  });
  return n;
}

/** Why `doc` alone cannot take this change to the style `id`, or null when it can. */
export function styleChangeRefusal(
  doc: Node,
  id: string,
  changes: StyleChanges,
): StyleDocRefusal | null {
  const { styles } = definitions(doc);
  const own = styles.find((s) => s.node.attrs['id'] === id);
  if (!own) return 'unknown-style';
  if (own.node.attrs['builtIn'] === true) return 'built-in';
  if (changes.name !== undefined) {
    const refusal = nameRefusal(styles, kindOf(own.node), changes.name, id);
    if (refusal) return refusal;
  }
  if (changes.basedOn !== undefined && changes.basedOn !== null) {
    const parent = styles.find((s) => s.node.attrs['id'] === changes.basedOn);
    if (!parent || kindOf(parent.node) !== kindOf(own.node)) return 'bad-based-on';
    if (basedOnChain(styles, changes.basedOn, id)) return 'bad-based-on';
  }
  return null;
}

function nameRefusal(
  styles: readonly Located[],
  kind: StyleKind,
  name: string,
  except: string | null,
): 'bad-name' | 'duplicate-name' | null {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > 255) return 'bad-name';
  const lower = trimmed.toLowerCase();
  const taken = styles.some(
    (s) =>
      s.node.attrs['id'] !== except &&
      kindOf(s.node) === kind &&
      String(s.node.attrs['name'] ?? '')
        .trim()
        .toLowerCase() === lower,
  );
  return taken ? 'duplicate-name' : null;
}

/** Why `doc` alone cannot take a new style of this kind, name and parent, or null when it can. */
export function styleCreateRefusal(
  doc: Node,
  kind: StyleKind,
  name: string,
  basedOn: string | null,
): StyleDocRefusal | null {
  const { styles } = definitions(doc);
  const refusal = nameRefusal(styles, kind, name, null);
  if (refusal) return refusal;
  if (basedOn !== null) {
    const parent = styles.find((s) => s.node.attrs['id'] === basedOn);
    if (!parent || kindOf(parent.node) !== kind) return 'bad-based-on';
  }
  return null;
}

/** Why `doc` alone cannot lose the style `id`, or null when it can. */
export function styleDeleteRefusal(doc: Node, id: string): StyleDocRefusal | null {
  const { styles } = definitions(doc);
  const own = styles.find((s) => s.node.attrs['id'] === id);
  if (!own) return 'unknown-style';
  if (own.node.attrs['builtIn'] === true) return 'built-in';
  return styleReferences(doc, id) > 0 ? 'in-use' : null;
}

/** Adds a style definition after the last one, as the CDM's order of `defs` asks (03 §4.1). */
export function createStyle(
  id: string,
  kind: StyleKind,
  name: string,
  basedOn: string | null,
): Command {
  return (state, dispatch) => {
    if (styleCreateRefusal(state.doc, kind, name, basedOn) !== null) return false;
    const type = state.schema.nodes['style_def'];
    if (!type) return false;
    if (dispatch) {
      const { insertAt } = definitions(state.doc);
      const node = type.create({ id, kind, name: name.trim(), basedOn });
      dispatch(state.tr.insert(insertAt, node));
    }
    return true;
  };
}

/** Renames a style or changes its parent. Nothing changes when the values are the style's own. */
export function changeStyle(id: string, changes: StyleChanges): Command {
  return (state, dispatch) => {
    if (styleChangeRefusal(state.doc, id, changes) !== null) return false;
    const own = definitions(state.doc).styles.find((s) => s.node.attrs['id'] === id)!;
    const attrs = { ...own.node.attrs };
    if (changes.name !== undefined) attrs['name'] = changes.name.trim();
    if (changes.basedOn !== undefined) attrs['basedOn'] = changes.basedOn;
    const same = JSON.stringify(attrs) === JSON.stringify(own.node.attrs);
    if (same) return false;
    if (dispatch) dispatch(state.tr.setNodeMarkup(own.pos, undefined, attrs));
    return true;
  };
}

/** Removes a style definition that nothing uses. */
export function deleteStyle(id: string): Command {
  return (state, dispatch) => {
    if (styleDeleteRefusal(state.doc, id) !== null) return false;
    const own = definitions(state.doc).styles.find((s) => s.node.attrs['id'] === id)!;
    if (dispatch) dispatch(state.tr.delete(own.pos, own.pos + own.node.nodeSize));
    return true;
  };
}
