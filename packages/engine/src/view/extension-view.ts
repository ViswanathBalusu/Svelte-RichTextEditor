/**
 * The node view of a custom block that no extension draws (UX-058 criterion 1; 13 §7.3).
 *
 * It draws what the schema's `extensionDOM` draws: a named group with the notice that the content
 * comes from an unavailable extension, the fallback picture's placeholder and the fallback text as an
 * ordinary paragraph. When the block has a fallback picture, the picture is drawn inside its
 * placeholder from the signed URL the backend gives for the asset identifier (image-source.ts); no
 * other URL is ever used, and a failed or unsafe answer leaves the placeholder. The `<img>` has an
 * empty `alt`: the placeholder carries the name. The payload is never read.
 */
import { DOMSerializer, type Node as PmNode } from 'prosemirror-model';
import type { NodeView, NodeViewConstructor } from 'prosemirror-view';
import { type AssetImageLookup, imageSource } from '../image-source.ts';
import { extensionDOM } from '../schema.ts';

function fallbackAssetOf(node: PmNode): string | undefined {
  const asset = node.attrs['fallbackAsset'];
  return typeof asset === 'string' && asset !== '' ? asset : undefined;
}

export function extensionBlockView(lookup: AssetImageLookup | undefined): NodeViewConstructor {
  return (node): NodeView => {
    const { dom } = DOMSerializer.renderSpec(document, extensionDOM(node));
    const root = dom as HTMLElement;
    let current = node;
    let destroyed = false;

    const asset = fallbackAssetOf(node);
    const placeholder = root.querySelector<HTMLElement>('.de-extension-image');
    if (lookup && asset !== undefined && placeholder) {
      lookup(asset)
        .then((answer) => {
          if (destroyed || fallbackAssetOf(current) !== asset) return;
          const src = imageSource(answer);
          if (src === undefined) return;
          const img = document.createElement('img');
          img.alt = '';
          img.referrerPolicy = 'no-referrer';
          img.decoding = 'async';
          img.src = src;
          placeholder.append(img);
        })
        .catch(() => {});
    }

    return {
      dom: root,
      // A change of the asset, the text or the extension builds the view again; a payload change does not.
      update: (next) => {
        if (next.type !== current.type) return false;
        for (const name of ['extension', 'fallbackText', 'fallbackAsset']) {
          if (next.attrs[name] !== current.attrs[name]) return false;
        }
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
