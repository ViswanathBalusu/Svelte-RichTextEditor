/**
 * The web view's decorations for a comparison (HIS-013): the plain specs of `comparison-markup.ts`
 * turned into `prosemirror-view` decorations. A deletion is a widget holding the removed text; it
 * is `aria-hidden` false and carries `del` semantics through the element name, so that a reader of
 * the page hears that it was deleted.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { ComparisonSpec } from '../comparison-markup.ts';

export function comparisonDecorations(
  doc: PMNode,
  specs: readonly ComparisonSpec[] | null,
): DecorationSet {
  if (specs === null || specs.length === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  for (const s of specs) {
    if (s.type === 'block') out.push(Decoration.node(s.from, s.to, { ...s.attrs }));
    else if (s.type === 'inline') out.push(Decoration.inline(s.from, s.to, { ...s.attrs }));
    else
      out.push(
        Decoration.widget(
          s.at,
          () => {
            const el = document.createElement('del');
            for (const [name, value] of Object.entries(s.attrs)) el.setAttribute(name, value);
            el.classList.add('de-compare-deleted');
            el.textContent = s.text;
            return el;
          },
          { side: -1, key: `deleted-${s.index}-${s.at}` },
        ),
      );
  }
  return DecorationSet.create(doc, out);
}
