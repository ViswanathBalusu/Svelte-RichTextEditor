/**
 * The page guides of the web view (FE-068; 02 §7): a dashed rule drawn before each top-level block
 * whose identifier the element gives, where the last typeset PDF started a page. A guide is a widget
 * decoration at the block's start, so it sits between two blocks and never inside a paragraph. The
 * guide has no text and is hidden from assistive technology; it is not a page edge.
 *
 * The identifiers come from the element (`pageGuideBlockIds`, packages/element/src/page-guides.ts);
 * the engine decides nothing about them. This module builds DOM only through `prosemirror-view`'s
 * `Decoration.widget`, with a factory that uses DOM APIs and no HTML string (FE-067).
 */
import type { Node as ProseNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** The class of a page guide element (the element's stylesheet may restyle it). */
export const PAGE_GUIDE_CLASS = 'de-page-guide';

/**
 * The guides of a document: one widget before each block in `ids`, in document order. A block inside
 * a paragraph (an inline node) gets none, so a guide never falls inside a paragraph.
 */
export function pageGuideDecorations(doc: ProseNode, ids: ReadonlySet<string>): DecorationSet {
  if (ids.size === 0) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, offset, parent) => {
    const id = node.attrs['id'];
    if (typeof id !== 'string' || !ids.has(id) || parent === null || parent.isTextblock)
      return true;
    decorations.push(
      Decoration.widget(
        offset,
        () => {
          const guide = document.createElement('div');
          guide.className = PAGE_GUIDE_CLASS;
          guide.setAttribute('aria-hidden', 'true');
          guide.dataset['blockId'] = id;
          // The rule's look is set through the CSSOM, as the editor's other drawn cues are.
          guide.style.borderTop = '1px dashed currentColor';
          guide.style.opacity = '0.5';
          guide.style.margin = '0.5em 0';
          return guide;
        },
        { side: -1, key: `${PAGE_GUIDE_CLASS}:${id}`, ignoreSelection: true },
      ),
    );
    return true;
  });
  return DecorationSet.create(doc, decorations);
}
