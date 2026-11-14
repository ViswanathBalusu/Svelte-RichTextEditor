/**
 * List semantics in the web view (FE-105): the plugin's node decorations carry the ARIA attributes
 * of `listSemantics` for numbered paragraphs, and follow changes. The DOM itself is read in the
 * element's end-to-end test (packages/element/e2e/list-semantics.spec.ts).
 */
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Decoration } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import {
  listDecorations,
  listSemanticsKey,
  listSemanticsPlugin,
  mayRelist,
} from '../src/view/list-view.ts';

const LIST = 'lList000000000001';

function para(id: string, text: string, level: number | null, style: string | null = null) {
  return {
    type: 'paragraph',
    attrs: {
      id,
      style,
      numbering: level === null ? null : { numberingId: 'num1', level, listId: LIST },
    },
    content: [{ type: 'text', text }],
  };
}

function docJson(body: unknown[]) {
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
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  };
}

function stateOf(body: unknown[]): EditorState {
  const schema = editingSchema();
  return EditorState.create({
    doc: schema.nodeFromJSON(docJson(body)),
    plugins: [listSemanticsPlugin()],
  });
}

/** The decoration attributes by paragraph identifier. */
function attrsById(state: EditorState): Record<string, Record<string, string>> {
  const set = listSemanticsKey.getState(state)!;
  const out: Record<string, Record<string, string>> = {};
  for (const d of set.find() as Array<Decoration & { type: { attrs: Record<string, string> } }>) {
    const node = state.doc.nodeAt(d.from)!;
    out[String(node.attrs['id'])] = d.type.attrs;
  }
  return out;
}

describe('list semantics in the web view (FE-105)', () => {
  it('gives three consecutive paragraphs of one list their role, position and the list size', () => {
    const state = stateOf([
      para('pA', 'Before', null),
      para('p1', 'One', 0),
      para('p2', 'Two', 0),
      para('p3', 'Three', 0),
      para('pZ', 'After', null),
    ]);
    const attrs = attrsById(state);
    expect(Object.keys(attrs).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(attrs['p2']).toEqual({
      role: 'listitem',
      'aria-level': '1',
      'aria-posinset': '2',
      'aria-setsize': '3',
    });
  });

  it('gives a nested paragraph its level', () => {
    const state = stateOf([para('p1', 'One', 0), para('p2', 'One.a', 1), para('p3', 'Two', 0)]);
    const attrs = attrsById(state);
    expect(attrs['p2']).toMatchObject({
      'aria-level': '2',
      'aria-posinset': '1',
      'aria-setsize': '1',
    });
    expect(attrs['p3']).toMatchObject({
      'aria-level': '1',
      'aria-posinset': '2',
      'aria-setsize': '2',
    });
  });

  it('keeps a numbered heading a heading: it is counted but not decorated', () => {
    const state = stateOf([para('h1', 'Title', 0, 'Heading1'), para('p2', 'Body', 0)]);
    const attrs = attrsById(state);
    expect(attrs['h1']).toBeUndefined();
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('recomputes when a paragraph joins the list, and only maps while typing', () => {
    let state = stateOf([para('p1', 'One', 0), para('p2', 'Two', null)]);
    // Typing in the first paragraph: no change of membership.
    const typing = state.tr.setSelection(TextSelection.create(state.doc, 4)).insertText('x');
    expect(mayRelist(typing)).toBe(false);
    state = state.apply(typing);
    expect(attrsById(state)['p1']).toMatchObject({ 'aria-setsize': '1' });
    // The second paragraph gets numbering: the list grows to two.
    let p2 = -1;
    state.doc.descendants((n, pos) => {
      if (n.attrs['id'] === 'p2') p2 = pos;
      return p2 < 0;
    });
    const numbered = state.tr.setNodeAttribute(p2, 'numbering', {
      numberingId: 'num1',
      level: 0,
      listId: LIST,
    });
    expect(mayRelist(numbered)).toBe(true);
    state = state.apply(numbered);
    expect(attrsById(state)['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(attrsById(state)['p1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '2' });
  });

  it('decorates nothing in a document without numbering', () => {
    const state = stateOf([para('p1', 'One', null)]);
    expect(listDecorations(state.doc).find()).toHaveLength(0);
  });
});
