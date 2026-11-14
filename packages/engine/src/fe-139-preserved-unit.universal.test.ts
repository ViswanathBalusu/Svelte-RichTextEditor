/**
 * FE-139 criterion 2 in a browser (lane U-FE-129-141, round 7): a preserved atom behaves as one
 * unit. The atom has no editable content in the page, a whole-atom selection deletes it in one
 * step, and a text selection that runs into it takes it whole and never leaves part of it behind.
 * A live `EditorView` on the editing schema is used, so the DOM and the state are both checked in
 * Chromium, Firefox and WebKit (`pnpm vitest run --project browser <this file>`). In the node
 * project the suite is skipped, as it needs a live document.
 */
import { deleteSelection } from 'prosemirror-commands';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import { editingSchema } from './schema.ts';

const inBrowser = typeof globalThis.document !== 'undefined';

const BEFORE = 'pFe139A0000000001';
const AFTER = 'pFe139B0000000001';

/** The position and node of the preserved block in the document. */
function findAtom(doc: PMNode): { pos: number; node: PMNode } {
  let found: { pos: number; node: PMNode } | null = null;
  doc.descendants((node, pos) => {
    if (found === null && node.type.name === 'preserved_block') found = { pos, node };
    return found === null;
  });
  if (found === null) throw new Error('the document holds no preserved block');
  return found;
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

function holdsAtom(doc: PMNode): boolean {
  let kept = false;
  doc.descendants((node) => {
    if (node.type.name === 'preserved_block') kept = true;
    return !kept;
  });
  return kept;
}

/**
 * A document with the text before the atom, a preserved block, and the text after it. The defs and
 * the body follow the content expression of the editing schema, as the authoring fixture does.
 */
function documentWithAtom(schema: Schema): PMNode {
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
          paragraph('pFe139A0000000001', 'before'),
          {
            type: 'preserved_block',
            attrs: { label: 'chart', fallbackText: 'Sales by quarter', fragment: null },
          },
          paragraph('pFe139B0000000001', 'after'),
        ],
      },
    ],
  });
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

describe.skipIf(!inBrowser)('FE-139 criterion 2 in a browser: a preserved atom is one unit', () => {
  it('has no editable content in the page, and no content node in the document', () => {
    const schema = editingSchema();
    const view = mount(documentWithAtom(schema), schema);
    const { node } = findAtom(view.state.doc);
    expect(node.childCount).toBe(0);
    const el = view.dom.querySelector('.de-preserved');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('contenteditable')).toBe('false');
    expect(el?.querySelector('[contenteditable="true"]')).toBeNull();
  });

  it('a whole-atom selection deletes the atom in one step and leaves the text around it', () => {
    const schema = editingSchema();
    const view = mount(documentWithAtom(schema), schema);
    const { pos } = findAtom(view.state.doc);
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
    expect(deleteSelection(view.state, view.dispatch)).toBe(true);
    expect(holdsAtom(view.state.doc)).toBe(false);
    expect(view.state.doc.textContent).toBe('beforeafter');
    expect(view.dom.querySelector('.de-preserved')).toBeNull();
  });

  it('a text selection that runs into the atom takes the atom whole, never part of it', () => {
    const schema = editingSchema();
    const view = mount(documentWithAtom(schema), schema);
    const doc = view.state.doc;
    // From inside "before" to inside "after": the atom lies between the two ends.
    const from = insideParagraph(doc, BEFORE, 3);
    const to = insideParagraph(doc, AFTER, 3);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)));
    expect(deleteSelection(view.state, view.dispatch)).toBe(true);
    expect(holdsAtom(view.state.doc)).toBe(false);
    expect(view.state.doc.textContent.includes('Sales')).toBe(false);
    expect(view.dom.querySelector('.de-preserved')).toBeNull();
  });
});
