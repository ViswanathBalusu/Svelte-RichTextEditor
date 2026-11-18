/**
 * The node view of a `figure` (FE-132 criterion 2; 03 §4.3). It draws what the schema's `toDOM`
 * draws, a `figure` with a picture box that holds the alt text and a hole for the caption, and
 * adds two things: the box takes the figure's stored size (`width` and `height` in twips, drawn in
 * CSS pixels), and a resize handle in its corner (resize-handle.ts).
 *
 * The picture box is not editable, so the handle and the alt text are never document content.
 */
import type { Node as PmNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { drawSize, resizeHandle } from './resize-handle.ts';

const altOf = (node: PmNode): string => String(node.attrs['alt'] ?? '');
const size = (node: PmNode, name: string): number => {
  const value = node.attrs[name];
  return typeof value === 'number' ? value : 0;
};

export const figureView: NodeViewConstructor = (node, view, getPos): NodeView => {
  let current = node;
  const dom = document.createElement('figure');
  dom.className = 'de-figure';
  const picture = document.createElement('div');
  picture.className = 'de-figure-image';
  picture.contentEditable = 'false';
  const label = document.createTextNode(altOf(node));
  picture.append(label);
  const contentDOM = document.createElement('div');
  dom.append(picture, contentDOM);

  const handle = resizeHandle(view, {
    node: () => current,
    pos: () => {
      const pos = getPos();
      return typeof pos === 'number' ? pos : undefined;
    },
    preview: (width, height) => drawSize(picture, width, height),
  });
  picture.append(handle.dom);
  drawSize(picture, size(node, 'width'), size(node, 'height'));

  return {
    dom,
    contentDOM,
    update: (next) => {
      if (next.type !== current.type) return false;
      current = next;
      label.data = altOf(next);
      drawSize(picture, size(next, 'width'), size(next, 'height'));
      handle.sync(next);
      return true;
    },
    // The handle and the label are the view's own: ProseMirror must not read them as an edit.
    stopEvent: (event) => handle.owns(event.target),
    ignoreMutation: (mutation) =>
      mutation.type !== 'selection' && picture.contains(mutation.target),
    destroy: () => handle.destroy(),
  };
};
