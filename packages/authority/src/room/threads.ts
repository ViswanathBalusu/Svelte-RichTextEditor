/**
 * Comment threads as mapped ranges (ADR 0015; 07 §6; SYN-032, SYN-033; PRM-037 to PRM-040;
 * ADR 0050 item 6). A thread targets a text range or a block by identifier. The range is not in
 * the document: the room keeps it, maps it through every stored commit, and hands it to the host
 * to save with checkpoints. Commenting never changes the document.
 *
 * - A range maps like a selection: its start moves right of text typed at it, its end left, so text
 *   typed at either edge stays outside. When everything it covered is deleted it collapses, and the
 *   thread is detached for good: undoing the deletion does not bring the range back (ADR 0015).
 * - A block target follows its identifier, wherever the block moves. When no block holds the
 *   identifier any more, the thread is detached.
 * - A detached thread keeps the scopes it covered when it was last attached, so that who may
 *   resolve or reply to it does not change because its text was deleted.
 */
import type { Node } from 'prosemirror-model';
import type { StepMap } from 'prosemirror-transform';
import { mapRanges } from '../ranges.ts';

/** What a thread is about: a text range at `seq`, or a block by identifier. */
export type ThreadTarget = { range: { from: number; to: number } } | { block: string };

/** A thread's anchor as the room holds it, at the room's durable head. */
export interface ThreadAnchor {
  /** The thread's identifier (05 §6.2). */
  id: string;
  /** The user who created the thread (07 §12 row 5: delete needs the author or `manage`). */
  author: string;
  target: ThreadTarget;
  /** The sequence number the target's positions refer to. */
  seq: number;
  /** The commented text was deleted or the block removed; the thread stays detached. */
  detached: boolean;
  /** The scopes the target covered when it was last attached; set once it is detached. */
  scopes?: string[];
}

/** A copy of an anchor, so that callers never hold the room's own objects. */
export function cloneAnchor(a: ThreadAnchor): ThreadAnchor {
  const target: ThreadTarget =
    'range' in a.target
      ? { range: { from: a.target.range.from, to: a.target.range.to } }
      : { block: a.target.block };
  return {
    id: a.id,
    author: a.author,
    target,
    seq: a.seq,
    detached: a.detached,
    ...(a.scopes ? { scopes: [...a.scopes] } : {}),
  };
}

/** The top-level nodes a comment may not target: the document's frame, not its content. */
const FRAME: ReadonlySet<string> = new Set(['doc', 'defs', 'body', 'story']);

/**
 * The scopes a range of a document covers (07 §5.1): `body`, each `region:<id>` and each
 * `story:<id>` it overlaps; `doc` for positions in the definitions or between the top-level
 * nodes. A collapsed range covers the scope of its position.
 */
export function rangeScopes(doc: Node, from: number, to: number): string[] {
  const out = new Set<string>();
  const overlaps = (start: number, end: number) =>
    from < to ? from < end && to > start : from > start && from < end;
  doc.forEach((top, offset) => {
    const start = offset;
    const end = offset + top.nodeSize;
    if (!overlaps(start, end)) return;
    if (top.type.name === 'story') out.add(`story:${String(top.attrs['id'])}`);
    else if (top.type.name !== 'body') out.add('doc');
    else {
      let inChild = false;
      top.forEach((child, o) => {
        const cs = start + 1 + o;
        const ce = cs + child.nodeSize;
        if (!overlaps(cs, ce)) return;
        inChild = true;
        out.add(child.type.name === 'region' ? `region:${String(child.attrs['id'])}` : 'body');
      });
      if (!inChild) out.add('body');
    }
  });
  if (from === to && out.size === 0) out.add('doc');
  return [...out].sort();
}

/** Where a block with this identifier is, and the scope that holds it, or null. */
export function findBlock(doc: Node, id: string): { pos: number; scope: string } | null {
  let found: { pos: number; scope: string } | null = null;
  doc.forEach((top, offset) => {
    if (found || top.type.name === 'defs') return;
    const topScope = top.type.name === 'story' ? `story:${String(top.attrs['id'])}` : top.type.name;
    const visit = (n: Node, pos: number, scope: string) => {
      if (found) return;
      if (n.isBlock && !FRAME.has(n.type.name) && n.attrs['id'] === id) {
        found = { pos, scope };
        return;
      }
      n.forEach((c, o) => {
        if (found || c.isInline) return;
        const s =
          n.type.name === 'body'
            ? c.type.name === 'region'
              ? `region:${String(c.attrs['id'])}`
              : 'body'
            : scope;
        visit(c, pos + 1 + o, s);
      });
    };
    visit(top, offset, topScope);
  });
  return found;
}

/** A thread's state in the room: the anchor, with the block's position kept as a hint. */
export interface ThreadState {
  anchor: ThreadAnchor;
  /** Where the targeted block was at `anchor.seq`, so that a lookup rarely scans the document. */
  blockPos: number | null;
}

/** The scopes a thread covers now in `doc` (the head), or the frozen ones of a detached thread. */
export function threadScopes(t: ThreadState, doc: Node): string[] {
  const a = t.anchor;
  if (a.detached) return a.scopes ?? [];
  if ('range' in a.target) return rangeScopes(doc, a.target.range.from, a.target.range.to);
  const at = locateBlock(t, doc);
  return at ? [at.scope] : [];
}

function locateBlock(t: ThreadState, doc: Node): { pos: number; scope: string } | null {
  const target = t.anchor.target;
  if (!('block' in target)) return null;
  if (t.blockPos !== null) {
    let node: Node | null;
    try {
      node = doc.nodeAt(t.blockPos);
    } catch {
      node = null;
    }
    if (node?.attrs['id'] === target.block) {
      const scopes = rangeScopes(doc, t.blockPos, t.blockPos + node.nodeSize);
      // A region targeted as a block is its own scope; anything else lies in exactly one scope.
      if (node.type.name === 'region') return { pos: t.blockPos, scope: `region:${target.block}` };
      if (scopes.length === 1) return { pos: t.blockPos, scope: scopes[0]! };
    }
  }
  return findBlock(doc, target.block);
}

/**
 * Moves a thread through one stored commit (SYN-032). `maps` are the commit's step maps, or null
 * for a snapshot commit, across which a range cannot be mapped. Returns the new state.
 */
export function mapThread(
  t: ThreadState,
  maps: readonly StepMap[] | null,
  before: Node,
  after: Node,
  seq: number,
): ThreadState {
  const a = t.anchor;
  if ('range' in a.target) {
    const { from, to } = a.target.range;
    if (maps === null) {
      // A snapshot replaced the document: the range cannot follow, and the thread is detached.
      if (a.detached) return { ...t, anchor: { ...a, seq } };
      return {
        ...t,
        anchor: {
          ...a,
          seq,
          detached: true,
          scopes: rangeScopes(before, from, to),
          target: { range: { from: 0, to: 0 } },
        },
      };
    }
    const [m] = mapRanges([{ from, to }], maps);
    const range = { from: m!.from, to: m!.to };
    if (a.detached || !m!.collapsed) return { ...t, anchor: { ...a, seq, target: { range } } };
    return {
      ...t,
      anchor: {
        ...a,
        seq,
        target: { range },
        detached: true,
        scopes: rangeScopes(before, from, to),
      },
    };
  }
  if (a.detached) return { ...t, anchor: { ...a, seq } };
  let hint = t.blockPos;
  if (hint !== null && maps !== null) {
    let pos = hint;
    let gone = false;
    for (const map of maps) {
      const r = map.mapResult(pos, 1);
      if (r.deletedAfter) gone = true;
      pos = r.pos;
    }
    hint = gone ? null : pos;
  } else hint = null;
  const located = locateBlock({ anchor: a, blockPos: hint }, after);
  if (located) return { anchor: { ...a, seq }, blockPos: located.pos };
  const was = locateBlock(t, before);
  return {
    anchor: { ...a, seq, detached: true, scopes: was ? [was.scope] : (a.scopes ?? []) },
    blockPos: null,
  };
}
