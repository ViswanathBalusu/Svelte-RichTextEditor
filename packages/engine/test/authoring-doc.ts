/**
 * A small document for the authoring commands of FE-133, FE-137 and FE-140: two sources, a page
 * setup, two paragraphs and a region the tests can write-protect. Built straight on the editing
 * schema, so the commands run as they do in the core, without a backend.
 */
import { editingSchema } from '../src/schema.ts';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';

export const AUTH_IDS = {
  p1: 'pAuthA00000000001',
  p2: 'pAuthB00000000001',
  inRegion: 'pAuthR00000000001',
  region: 'rAuthR00000000001',
} as const;

export function authoringEnvelope(): Record<string, unknown> {
  const paragraph = (id: string, text: string) => ({
    type: 'paragraph',
    attrs: { id, style: null },
    content: [{ type: 'text', text }],
  });
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
          { type: 'page_setup', attrs: { id: 'ps1' } },
          { type: 'source_def', attrs: { id: 'smith2026', kind: 'book', title: 'A book' } },
          {
            type: 'source_def',
            attrs: { id: 'jones2024', kind: 'article-journal', title: 'An article' },
          },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          paragraph(AUTH_IDS.p1, 'Alpha beta'),
          paragraph(AUTH_IDS.p2, 'Gamma delta'),
          {
            type: 'region',
            attrs: { id: AUTH_IDS.region, title: 'Clause', policy: 'restricted' },
            content: [paragraph(AUTH_IDS.inRegion, 'Protected text')],
          },
        ],
      },
    ],
  };
}

/** The editor state of the document, on the editing schema. */
export function authoringState(): EditorState {
  const schema = editingSchema();
  return EditorState.create({ doc: schema.nodeFromJSON(authoringEnvelope()) });
}

/** The position of the first text character of the paragraph with `id` (inside the paragraph). */
export function inside(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos + 1;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

/** A state with the caret at `offset` characters into the paragraph with `id`. */
export function caretIn(state: EditorState, id: string, offset = 0): EditorState {
  const at = inside(state.doc, id) + offset;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
}

/** A state with the text from `from` to `to` (characters) of the paragraph with `id` selected. */
export function selectIn(state: EditorState, id: string, from: number, to: number): EditorState {
  const base = inside(state.doc, id);
  return state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, base + from, base + to)),
  );
}
