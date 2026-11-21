/**
 * The web view's drawing of the regions the user cannot edit (PRM-026; 07 §7): the plain specs of
 * `region-lock.ts` turned into `prosemirror-view` decorations.
 *
 * - The region's own element takes the class `de-region-locked`, which the element's stylesheet
 *   shades, and is described by its lock indicator (`aria-describedby`), so that assistive technology
 *   that enters the group hears that it is read-only and who can edit it.
 * - The lock indicator is a note at the start of the region: an icon drawn by the stylesheet, a short
 *   text label and the sentence that says who can edit the region. It is real text, never colour
 *   alone, and it is not part of the document: nothing in it can be edited or selected into a commit.
 *
 * The indicator is built with DOM APIs and no HTML string, and holds no `svg` or `img` element
 * (FE-067). Its key carries its words, so it is drawn again only when they change.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { RegionLockSpec } from '../region-lock.ts';

/** The class of a region the user cannot edit. */
export const REGION_LOCKED_CLASS = 'de-region-locked';
/** The class of a lock indicator. */
export const REGION_LOCK_CLASS = 'de-region-lock';

/** The element identifier of a region's lock indicator, unique in the editor's shadow root. */
export function regionLockElementId(regionId: string): string {
  return `de-region-lock-${regionId}`;
}

function indicator(spec: RegionLockSpec): HTMLElement {
  const note = document.createElement('div');
  note.className = REGION_LOCK_CLASS;
  note.id = regionLockElementId(spec.id);
  note.contentEditable = 'false';
  note.setAttribute('role', 'note');
  note.dataset['region'] = spec.id;
  if (spec.unlisted) note.dataset['unlisted'] = 'true';
  const icon = document.createElement('span');
  icon.className = 'de-region-lock-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  label.className = 'de-region-lock-label';
  label.textContent = spec.label.indicator;
  note.append(icon, label);
  if (spec.label.description !== '') {
    const description = document.createElement('span');
    description.className = 'de-region-lock-description';
    description.textContent = spec.label.description;
    // A space between the two, so that the note reads as two phrases when it is read as one text.
    note.append(' ', description);
  }
  return note;
}

/** The decorations of the locked regions: the shading class on each, and its indicator inside it. */
export function regionLockDecorations(
  doc: PMNode,
  specs: readonly RegionLockSpec[],
): DecorationSet {
  if (specs.length === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  for (const spec of specs) {
    out.push(
      Decoration.node(spec.from, spec.to, {
        class: REGION_LOCKED_CLASS,
        'data-locked': spec.unlisted ? 'unlisted' : 'true',
        'aria-describedby': regionLockElementId(spec.id),
      }),
      Decoration.widget(spec.from + 1, () => indicator(spec), {
        side: -1,
        ignoreSelection: true,
        key: `${REGION_LOCK_CLASS}:${JSON.stringify([
          spec.id,
          spec.unlisted,
          spec.label.indicator,
          spec.label.description,
        ])}`,
      }),
    );
  }
  return DecorationSet.create(doc, out);
}
