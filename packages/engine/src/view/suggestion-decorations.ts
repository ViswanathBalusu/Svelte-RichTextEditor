/**
 * The web view's decoration set of a markup view (FE-046 criterion 4): the plain specs of
 * `suggestion-markup.ts` turned into `prosemirror-view` decorations. Kept out of the headless core
 * so that `@docedit/engine/headless` reaches no view module (FE-121).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { type MarkupView, suggestionSpecs } from '../suggestion-markup.ts';

/** The decoration set of `doc` for `view`. */
export function suggestionDecorations(doc: PMNode, view: MarkupView): DecorationSet {
  const decorations = suggestionSpecs(doc, view).map((s) =>
    s.block
      ? Decoration.node(s.from, s.to, { ...s.attrs })
      : Decoration.inline(s.from, s.to, { ...s.attrs }),
  );
  return DecorationSet.create(doc, decorations);
}
