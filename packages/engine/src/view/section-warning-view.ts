/**
 * The warning for a continuous section break that changes the margins (FE-135 criterion 6; 03 §10).
 * The PDF export reports such a break as unsupported, so the editor says so beside the break, in
 * text that does not depend on colour: a non-editable note after the break's mark.
 *
 * Which breaks warn is `sectionWarnings` (breaks-sections.ts), the same rule the core reports. The
 * note is a decoration, never document content. Typing inside a paragraph cannot change a break or
 * a page setup, so the notes only move with the text then, as the list decorations do.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { sectionWarnings } from '../breaks-sections.ts';
import { mayRelist } from './list-view.ts';

export const sectionWarningKey = new PluginKey<DecorationSet>('docedit-section-warning');

/** What the note says (03 §10: the PDF reports a continuous break that changes margins as unsupported). */
export const SECTION_WARNING_TEXT =
  'This continuous section break changes the margins. The PDF will report it as unsupported.';

/** The notes of the body's section breaks, one after each break that warns. */
export function sectionWarningDecorations(doc: PMNode): DecorationSet {
  const warned = new Set(sectionWarnings(doc).map((w) => w.sectionId));
  if (warned.size === 0) return DecorationSet.empty;
  const out: Decoration[] = [];
  doc.forEach((child, offset) => {
    if (child.type.name !== 'body') return;
    child.forEach((block, at) => {
      if (block.type.name !== 'section_break' || !warned.has(String(block.attrs['id']))) return;
      const after = offset + 1 + at + block.nodeSize;
      out.push(
        Decoration.widget(
          after,
          () => {
            const note = document.createElement('div');
            note.className = 'de-section-warning';
            note.setAttribute('role', 'note');
            note.contentEditable = 'false';
            note.textContent = SECTION_WARNING_TEXT;
            return note;
          },
          {
            side: -1,
            key: `de-section-warning:${String(block.attrs['id'])}`,
            ignoreSelection: true,
          },
        ),
      );
    });
  });
  return DecorationSet.create(doc, out);
}

export function sectionWarningPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: sectionWarningKey,
    state: {
      init: (_config, state) => sectionWarningDecorations(state.doc),
      apply: (tr, value) => {
        if (!tr.docChanged) return value;
        return mayRelist(tr) ? sectionWarningDecorations(tr.doc) : value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return sectionWarningKey.getState(state) ?? null;
      },
    },
  });
}
