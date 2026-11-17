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

function assetOf(node: PmNode): string | undefined {
  const asset = node.attrs['asset'];
  return typeof asset === 'string' && asset !== '' ? asset : undefined;
}

export function imageView(lookup: AssetImageLookup | undefined): NodeViewConstructor {
  return (node): NodeView => {
    const dom = document.createElement('span');
    dom.className = 'de-image';
    dom.setAttribute('role', 'img');
    dom.setAttribute('aria-label', String(node.attrs['alt'] ?? ''));
    let current = node;
    let destroyed = false;

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
        })
        .catch(() => {});
    }

    return {
      dom,
      // A change of the asset or the alt text builds the view again.
      update: (next) => {
        if (next.type !== current.type) return false;
        if (assetOf(next) !== assetOf(current) || next.attrs['alt'] !== current.attrs['alt'])
          return false;
        current = next;
        return true;
      },
      // The picture is added after the view is made; ProseMirror must not read it as an edit.
      ignoreMutation: () => true,
      destroy: () => {
        destroyed = true;
      },
    };
  };
}
