/**
 * Spike S9 (SPK-022): caret movement for the page view. Movement by line, by page, to the start and
 * end of a line, and left and right is computed from the layout tree and the document's block
 * order, never from the bridge or the DOM (02 §9.6): the bridge holds one line of text, so the
 * browser could not know where the next line is. The bridge hands the key to this module and is
 * re-projected at the new position.
 *
 * No DOM and no Node.js API.
 */
import {
  lineBounds,
  moveVertical,
  movePage,
  type DocPosition,
  type LayoutTree,
  type SpanWidth,
} from '@docedit/layout';
import type { SpikeDoc } from './doc.ts';

export type NavKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'CtrlHome'
  | 'CtrlEnd';

export interface Navigated {
  readonly pos: DocPosition;
  /** The goal x to carry to the next vertical move; undefined after a horizontal move. */
  readonly goalX: number | undefined;
}

/** The keys this module handles; the bridge lets every other key through to the input method. */
export function navKey(e: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): NavKey | null {
  if (e.altKey || e.metaKey || e.shiftKey) return null;
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'PageUp':
    case 'PageDown':
      return e.ctrlKey ? null : e.key;
    case 'Home':
      return e.ctrlKey ? 'CtrlHome' : 'Home';
    case 'End':
      return e.ctrlKey ? 'CtrlEnd' : 'End';
    default:
      return null;
  }
}

export function navigate(
  key: NavKey,
  doc: SpikeDoc,
  tree: LayoutTree,
  pos: DocPosition,
  goalX: number | undefined,
  span: SpanWidth,
): Navigated {
  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown':
      return moveVertical(tree, pos, key === 'ArrowUp' ? 'up' : 'down', goalX, span);
    case 'PageUp':
    case 'PageDown':
      return movePage(tree, pos, key === 'PageUp' ? 'up' : 'down', goalX, span);
    case 'Home':
    case 'End': {
      const bounds = lineBounds(tree, pos);
      if (!bounds) return { pos, goalX: undefined };
      return { pos: key === 'Home' ? bounds.start : bounds.end, goalX: undefined };
    }
    case 'CtrlHome': {
      const first = doc.blocks[0];
      return { pos: first ? { blockId: first.id, offset: 0 } : pos, goalX: undefined };
    }
    case 'CtrlEnd': {
      const last = doc.blocks[doc.blocks.length - 1];
      return {
        pos: last ? { blockId: last.id, offset: last.text.length } : pos,
        goalX: undefined,
      };
    }
    case 'ArrowLeft':
    case 'ArrowRight': {
      const i = doc.blocks.findIndex((b) => b.id === pos.blockId);
      const block = doc.blocks[i];
      if (!block) return { pos, goalX: undefined };
      if (key === 'ArrowLeft') {
        if (pos.offset > 0)
          return { pos: { blockId: pos.blockId, offset: pos.offset - 1 }, goalX: undefined };
        const prev = doc.blocks[i - 1];
        return {
          pos: prev ? { blockId: prev.id, offset: prev.text.length } : pos,
          goalX: undefined,
        };
      }
      if (pos.offset < block.text.length) {
        return { pos: { blockId: pos.blockId, offset: pos.offset + 1 }, goalX: undefined };
      }
      const next = doc.blocks[i + 1];
      return { pos: next ? { blockId: next.id, offset: 0 } : pos, goalX: undefined };
    }
  }
}
