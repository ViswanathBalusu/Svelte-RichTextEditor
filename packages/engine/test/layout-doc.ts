/**
 * A small document for the layout authoring commands of FE-134, FE-135 and FE-136: a header story,
 * two page setups, a body with a paragraph, a table cell, a figure with a caption, a footnote, a
 * region and a second paragraph. Built on the editing schema, as the core builds its state.
 */
import { editingSchema } from '../src/schema.ts';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';

export const LAYOUT_IDS = {
  header: 'hdrLayout00000001',
  setup1: 'ps1Layout0000000001',
  setup2: 'ps2Layout0000000001',
  pA: 'pLayoutA0000000001',
  pB: 'pLayoutB0000000001',
  cell: 'pLayoutCell000001',
  figure: 'figLayout00000001',
  figure2: 'figLayout00000002',
  caption: 'capLayout0000000001',
  pNote: 'pLayoutNote000001',
  footnote: 'fnLayout00000000001',
  region: 'rgLayout00000000001',
  inRegion: 'pLayoutR0000000001',
  pHeader: 'pLayoutHdr0000001',
} as const;

const paragraph = (id: string, text: string): Record<string, unknown> => ({
  type: 'paragraph',
  attrs: { id, style: null },
  content: text === '' ? [] : [{ type: 'text', text }],
});

export function layoutEnvelope(): Record<string, unknown> {
  return {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
          {
            type: 'style_def',
            attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
          },
          { type: 'page_setup', attrs: { id: LAYOUT_IDS.setup1 } },
          { type: 'page_setup', attrs: { id: LAYOUT_IDS.setup2, marginTop: 2880 } },
        ],
      },
      {
        type: 'story',
        attrs: { id: LAYOUT_IDS.header, kind: 'header' },
        content: [paragraph(LAYOUT_IDS.pHeader, 'Running head')],
      },
      {
        type: 'body',
        attrs: { pageSetup: LAYOUT_IDS.setup1 },
        content: [
          {
            type: 'paragraph',
            attrs: { id: LAYOUT_IDS.pA, style: null },
            content: [
              { type: 'text', text: 'Alpha ' },
              {
                type: 'footnote',
                attrs: { id: LAYOUT_IDS.footnote },
                content: [paragraph(LAYOUT_IDS.pNote, 'Note text')],
              },
              { type: 'text', text: 'beta' },
            ],
          },
          {
            type: 'table',
            attrs: { grid: [1440] },
            content: [
              {
                type: 'table_row',
                content: [{ type: 'table_cell', content: [paragraph(LAYOUT_IDS.cell, 'Cell')] }],
              },
            ],
          },
          {
            type: 'figure',
            attrs: { id: LAYOUT_IDS.figure },
            content: [
              {
                type: 'caption',
                content: [{ type: 'text', text: 'A caption' }],
              },
            ],
          },
          { type: 'figure', attrs: { id: LAYOUT_IDS.figure2 } },
          paragraph(LAYOUT_IDS.pB, 'Gamma delta'),
          {
            type: 'region',
            attrs: { id: LAYOUT_IDS.region, title: 'Clause', policy: 'restricted' },
            content: [paragraph(LAYOUT_IDS.inRegion, 'Protected text')],
          },
        ],
      },
    ],
  };
}

/** The editor state of the layout document, on the editing schema. */
export function layoutState(): EditorState {
  return EditorState.create({ doc: editingSchema().nodeFromJSON(layoutEnvelope()) });
}

/** The position inside the paragraph, the table cell, the caption or the footnote with `id`. */
export function inside(doc: Node, id: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos + 1 + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** A state with the caret at `offset` into the node with identifier `id`. */
export function caretIn(state: EditorState, id: string, offset = 0): EditorState {
  const at = inside(state.doc, id, offset);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

/** The position of the node with identifier `id` (before it), or -1. */
export function posOfNode(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  return found;
}
