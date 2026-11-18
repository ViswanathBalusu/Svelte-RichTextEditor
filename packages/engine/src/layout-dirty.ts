/**
 * Dirty blocks for the layout (02 §9.5; FE-088 criteria 1 and 6). An edit marks the blocks it
 * changes, so that the layout re-measures only those. The blocks are the nodes with an `id` that a
 * transaction's steps touch: text blocks and the blocks that hold no text (a figure, an equation),
 * with the paragraphs inside a table cell as paragraphs.
 *
 * Local edits and remote work take the same path. A remote commit reaches the document as a
 * transaction (remote.ts), and the plugin reads every transaction that changes the document, so
 * the blocks of a remote commit are marked as those of a local edit. An undone or redone change is
 * a transaction too.
 *
 * Over-marking is safe: the layout re-measures a marked block whose input did not change and keeps
 * the lines of an unmarked block whose input did not change; under-marking is covered because the
 * layout also re-measures an unmarked block whose input changed (incremental.ts). The marks are
 * identifiers only, so nothing here depends on the layout package.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
} from 'prosemirror-transform';

export const layoutDirtyKey = new PluginKey('docedit-layout-dirty');

interface Span {
  from: number;
  to: number;
}

/**
 * The spans of the final document that a transaction's steps changed. A step map gives the range it
 * wrote in the document after that step; a mark or attribute step moves nothing and so has an empty
 * map, and gives its own range. Each span is mapped through the later steps.
 */
function changedSpans(tr: Transaction): Span[] {
  const out: Span[] = [];
  tr.steps.forEach((step, i) => {
    const later = tr.mapping.slice(i + 1);
    const add = (from: number, to: number): void => {
      out.push({ from: later.map(from, -1), to: later.map(to, 1) });
    };
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      add(step.from, step.to);
    } else if (
      step instanceof AttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      add(step.pos, step.pos + 1);
    } else {
      step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => add(newStart, newEnd));
    }
  });
  return out;
}

/** Whether a node is a block that the layout lays out as one unit with its own `id`. */
function isLayoutBlock(node: PMNode): boolean {
  return typeof node.attrs['id'] === 'string' && node.isBlock && (node.isTextblock || node.isLeaf);
}

/**
 * The identifiers of the blocks of `doc` that overlap the given spans. A span that is empty (a
 * deletion) or at the edge of a block marks the text block it touches, on either side.
 */
export function blocksInSpans(doc: PMNode, spans: readonly Span[]): Set<string> {
  const ids = new Set<string>();
  const size = doc.content.size;
  for (const span of spans) {
    const from = Math.max(0, Math.min(span.from, size));
    const to = Math.max(from, Math.min(span.to, size));
    if (to > from) {
      doc.nodesBetween(from, to, (node) => {
        if (isLayoutBlock(node)) ids.add(node.attrs['id'] as string);
        return true;
      });
      continue;
    }
    // An empty span (a deletion): the block that holds the position, and the blocks either side
    // when it lies between blocks.
    const $pos = doc.resolve(from);
    for (let d = $pos.depth; d >= 0; d--) {
      const node = $pos.node(d);
      if (isLayoutBlock(node)) {
        ids.add(node.attrs['id'] as string);
        break;
      }
    }
    for (const side of [$pos.nodeBefore, $pos.nodeAfter])
      if (side && isLayoutBlock(side)) ids.add(side.attrs['id'] as string);
  }
  return ids;
}

/** The identifiers of the blocks a transaction changed, in the document it produced. */
export function dirtyBlocksOf(tr: Transaction): Set<string> {
  if (!tr.docChanged) return new Set();
  return blocksInSpans(tr.doc, changedSpans(tr));
}

export interface LayoutDirtyTracker {
  readonly plugin: Plugin;
  /** The identifiers marked since the last call, then forgets them. */
  take(): ReadonlySet<string>;
}

/**
 * A plugin that records the blocks of every transaction that changes the document, and the
 * function the layout's frame calls to take them (`coalescedLayout`, packages/layout).
 */
export function layoutDirtyTracker(): LayoutDirtyTracker {
  let pending = new Set<string>();
  const plugin = new Plugin({
    key: layoutDirtyKey,
    state: {
      init: () => null,
      apply(tr, value) {
        if (tr.docChanged) for (const id of dirtyBlocksOf(tr)) pending.add(id);
        return value;
      },
    },
  });
  return {
    plugin,
    take() {
      const out = pending;
      pending = new Set<string>();
      return out;
    },
  };
}
