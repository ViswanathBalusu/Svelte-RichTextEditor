/**
 * FE-141 criterion 1 in a browser (lane V-FE-129-141, round 4): a `hidden_region` placeholder is one
 * non-editable atom in a live editor, with nothing inside it that the page can edit, and a text
 * selection that runs across it takes it whole. A live `EditorView` on the editing schema is used, so
 * the DOM and the selection are checked in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser <this file>`). The fixed size is checked by
 * `fe-141-hidden-region-size.universal.test.ts`. In the node project the suite is skipped.
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER, editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

const BEFORE = 'pFe141A0000000001';
const AFTER = 'pFe141B0000000001';
const HIDDEN = 'hFe141C0000000001';

/** A document with text, a hidden region with a title, and text after it. */
function documentWithPlaceholder(schema: Schema): PMNode {
  const paragraph = (id: string, text: string) => ({
    type: 'paragraph',
    attrs: { id, style: null },
    content: [{ type: 'text', text }],
  });
  return schema.nodeFromJSON({
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
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          paragraph(BEFORE, 'before'),
          { type: PLACEHOLDER, attrs: { id: HIDDEN, title: 'Clause 4' } },
          paragraph(AFTER, 'after'),
        ],
      },
    ],
  });
}

/** The position inside the paragraph with `id`, `offset` characters in. */
function insideParagraph(doc: PMNode, id: string, offset: number): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos + 1 + offset;
    return found < 0;
  });
  if (found < 0) throw new Error(`no paragraph ${id}`);
  return found;
}

const mounted: EditorView[] = [];

/** Mounts a live editor on the document in the page. */
function mount(doc: PMNode, schema: Schema): EditorView {
  const host = globalThis.document.createElement('div');
  globalThis.document.body.append(host);
  const view = new EditorView(host, { state: EditorState.create({ doc, schema }) });
  mounted.push(view);
  return view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
});

describe.skipIf(!inBrowser)('FE-141 criterion 1 in a browser: a hidden region is one unit', () => {
  it('is rendered as one non-editable element with no editable content inside it', () => {
    const schema = editingSchema();
    const view = mount(documentWithPlaceholder(schema), schema);
    let placeholder: PMNode | null = null;
    view.state.doc.descendants((node) => {
      if (node.type.name === PLACEHOLDER) placeholder = node;
      return placeholder === null;
    });
    expect(placeholder).not.toBeNull();
    expect((placeholder as unknown as PMNode).childCount).toBe(0);
    const el = view.dom.querySelector(`[data-id="${HIDDEN}"]`);
    expect(el).not.toBeNull();
    expect(el?.getAttribute('contenteditable')).toBe('false');
    expect(el?.querySelector('[contenteditable="true"]')).toBeNull();
    expect(el?.querySelector('input, textarea, select')).toBeNull();
    expect(el?.textContent).toBe('Clause 4');
  });

  it('a text selection that runs across the placeholder contains it whole, and no part of it', () => {
    const schema = editingSchema();
    const view = mount(documentWithPlaceholder(schema), schema);
    const doc = view.state.doc;
    const from = insideParagraph(doc, BEFORE, 3);
    const to = insideParagraph(doc, AFTER, 3);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)));
    const slice = view.state.selection.content();
    const placeholders: PMNode[] = [];
    slice.content.descendants((node) => {
      if (node.type.name === PLACEHOLDER) placeholders.push(node);
      return true;
    });
    expect(placeholders.length).toBe(1);
    const [node] = placeholders;
    expect(node?.childCount).toBe(0);
    expect(node?.attrs['id']).toBe(HIDDEN);
    expect(node?.attrs['title']).toBe('Clause 4');
  });
});
