/**
 * The node view of a preserved atom, `preserved_block` and `preserved_inline` (FE-139 criterion 1;
 * 03 §4.6; ADR 0017 part 3).
 *
 * It draws what the schema's `toDOM` draws (`preservedDOM`: a group with the label that names the
 * kind and the fallback text), and adds two things. The atom takes its display size (`width` and
 * `height` in twips, drawn in CSS pixels through the CSSOM, which a strict `style-src` allows). And
 * when the atom has a fallback picture, the picture is drawn after the label, from the signed URL
 * the backend gives for the asset identifier (image-source.ts); no other URL is ever used.
 *
 * The fragment, the original XML, is never read here. The picture is decorative: the group's name
 * already holds the label and the fallback text, so the `<img>` has an empty `alt`.
 */
import { DOMSerializer, type Node as PmNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { type AssetImageLookup, imageSource } from '../image-source.ts';
import { preservedDOM } from '../schema.ts';
import { drawSize } from './resize-handle.ts';

const sizeOf = (node: PmNode, name: string): number => {
  const value = node.attrs[name];
  return typeof value === 'number' ? value : 0;
};

function fallbackAssetOf(node: PmNode): string | undefined {
  const asset = node.attrs['fallbackAsset'];
  return typeof asset === 'string' && asset !== '' ? asset : undefined;
}

export function preservedView(
  tag: 'div' | 'span',
  lookup: AssetImageLookup | undefined,
): NodeViewConstructor {
  return (node): NodeView => {
    const { dom } = DOMSerializer.renderSpec(document, preservedDOM(tag, node));
    const root = dom as HTMLElement;
    let current = node;
    let destroyed = false;
    // An inline atom takes a size only as a box of its own; the content scrolls inside it, so the
    // label and the fallback text are never cut off.
    if (tag === 'span') root.style.display = 'inline-block';
    root.style.maxInlineSize = '100%';
    root.style.overflow = 'auto';
    drawSize(root, sizeOf(node, 'width'), sizeOf(node, 'height'));

    const asset = fallbackAssetOf(node);
    if (lookup && asset !== undefined) {
      lookup(asset)
        .then((answer) => {
          if (destroyed || fallbackAssetOf(current) !== asset) return;
          const src = imageSource(answer);
          if (src === undefined) return;
          const img = document.createElement('img');
          img.className = 'de-preserved-image';
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.decoding = 'async';
          // The picture fits the atom's box, which holds the display size; written through the CSSOM.
          img.style.display = 'block';
          img.style.maxInlineSize = '100%';
          img.style.blockSize = 'auto';
          img.src = src;
          // After the label, before the fallback text.
          root.insertBefore(img, root.querySelector('.de-preserved-fallback'));
        })
        .catch(() => {});
    }

    return {
      dom: root,
      // A change of the label, the fallback or the asset builds the view again; a change of size does not.
      update: (next) => {
        if (next.type !== current.type) return false;
        for (const name of ['label', 'fallbackText', 'fallbackAsset']) {
          if (next.attrs[name] !== current.attrs[name]) return false;
        }
        current = next;
        drawSize(root, sizeOf(next, 'width'), sizeOf(next, 'height'));
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
