/**
 * Alternative text for a picture just inserted (FE-132 criterion 5; UX-066). The core asks the shell
 * for the text when an uploaded picture has none (`AltRequest`); the shell's answer comes back
 * through `setAltText`, which finds the picture by its asset identifier.
 */
import type { Node as PmNode } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';

/** A request to ask the author for the alternative text of a picture. `n` counts requests. */
export interface AltRequest {
  n: number;
  /** The asset identifier of the picture that has no alternative text. */
  asset: string;
}

const isBlank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/** The position of the first `image` of `asset` with no alternative text, or null. */
export function imageWithoutAlt(doc: PmNode, asset: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === 'image' && node.attrs['asset'] === asset && isBlank(node.attrs['alt']))
      found = pos;
    return found === null;
  });
  return found;
}

/**
 * Stores `alt` on the first picture of `asset` that has none. `writable` says whether the position
 * may be changed (the scope's guard). False, and nothing changes, when no such picture is left, when
 * the text is blank or when the position is read-only.
 */
export function setAltText(
  asset: string,
  alt: string,
  writable: (pos: number) => boolean,
): Command {
  return (state, dispatch) => {
    const text = alt.trim();
    if (text === '') return false;
    const pos = imageWithoutAlt(state.doc, asset);
    if (pos === null || !writable(pos)) return false;
    if (dispatch) {
      const node = state.doc.nodeAt(pos)!;
      dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, alt: text }));
    }
    return true;
  };
}
