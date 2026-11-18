/**
 * The node view of an inline `image` (FE-067 criterion 3; 10 §3.1).
 *
 * It draws what the schema's `toDOM` draws, a `span.de-image` with `role="img"` and the alt text,
 * and adds an `<img>` inside it when the lookup gives a safe answer (image-source.ts): an `http` or
 * `https` URL of a raster type. The picture is built with DOM APIs; the document's `alt` text is a
 * text value, never markup, and no URL comes from the document, only from the backend's answer for
 * the asset identifier. A node without an identifier, a lookup that fails or refuses, an SVG answer
 * or a `data:` URL leaves the placeholder as it is.
 */
import type { Node as PmNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { type AssetImageLookup, imageSource } from '../image-source.ts';
import { drawSize, resizeHandle } from './resize-handle.ts';

const sizeOf = (node: PmNode, name: string): number => {
  const value = node.attrs[name];
  return typeof value === 'number' ? value : 0;
};

function assetOf(node: PmNode): string | undefined {
  const asset = node.attrs['asset'];
  return typeof asset === 'string' && asset !== '' ? asset : undefined;
}

export function imageView(lookup: AssetImageLookup | undefined): NodeViewConstructor {
  return (node, view, getPos): NodeView => {
    const dom = document.createElement('span');
    dom.className = 'de-image';
    dom.setAttribute('role', 'img');
    dom.setAttribute('aria-label', String(node.attrs['alt'] ?? ''));
    let current = node;
    let destroyed = false;
    // The stored size and the handle are drawn once a picture is shown: a placeholder keeps the
    // size it has always had, which is the page's flow and not the picture's (FE-132 criterion 2).
    let shown = false;

    const asset = assetOf(node);
    if (lookup && asset !== undefined) {
      lookup(asset)
        .then((answer) => {
          if (destroyed || assetOf(current) !== asset) return;
          const src = imageSource(answer);
          if (src === undefined) return;
          const img = document.createElement('img');
          // The span carries the name; the picture is part of it.
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.decoding = 'async';
          img.src = src;
          dom.append(img);
          shown = true;
          drawSize(dom, sizeOf(current, 'width'), sizeOf(current, 'height'));
          dom.append(handle.dom);
        })
        .catch(() => {});
    }

    // FE-132 criterion 2: the stored size, and a handle to change it.
    const handle = resizeHandle(view, {
      node: () => current,
      pos: () => {
        const pos = getPos();
        return typeof pos === 'number' ? pos : undefined;
      },
      preview: (width, height) => drawSize(dom, width, height),
    });

    return {
      dom,
      // A change of the asset or the alt text builds the view again; a change of size does not.
      update: (next) => {
        if (next.type !== current.type) return false;
        if (assetOf(next) !== assetOf(current) || next.attrs['alt'] !== current.attrs['alt'])
          return false;
        current = next;
        if (shown) drawSize(dom, sizeOf(next, 'width'), sizeOf(next, 'height'));
        handle.sync(next);
        return true;
      },
      stopEvent: (event) => handle.owns(event.target),
      // The picture is added after the view is made; ProseMirror must not read it as an edit.
      ignoreMutation: () => true,
      destroy: () => {
        destroyed = true;
        handle.destroy();
      },
    };
  };
}
