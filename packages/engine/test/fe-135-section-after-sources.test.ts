/**
 * FE-135 criterion 2 (lane V-FE-129-141, round 4): a section break in a document whose `defs` hold
 * source definitions. The new `page_setup` goes after the last page setup, so the content expression
 * of `defs` (`page_setup+ role_def* rule_def* source_def*`) still holds, and the section names a page
 * setup that exists. Before this lane the page setup was appended after the sources, which left the
 * document invalid and dropped the page setup (I4). Node.js: `pnpm vitest run <this file>`.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { insertSectionBreak, pageSetupNode } from '../src/breaks-sections.ts';
import { editingSchema } from '../src/schema.ts';

const PARA = 'pFe135S00000000001';
const SETUP1 = 'ps1Fe135S000000001';
const NEW_SETUP = 'ps2Fe135S000000001';
const SECTION = 'secFe135S0000000001';

function documentWithSources(): PMNode {
  return editingSchema().nodeFromJSON({
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
          { type: 'page_setup', attrs: { id: SETUP1 } },
          { type: 'source_def', attrs: { id: 'smith2026', kind: 'book', title: 'A book' } },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: SETUP1 },
        content: [
          {
            type: 'paragraph',
            attrs: { id: PARA, style: null },
            content: [{ type: 'text', text: 'Alpha beta' }],
          },
        ],
      },
    ],
  });
}

describe('a section break keeps the definitions of a document valid (FE-135 criterion 2)', () => {
  it('places the new page setup after the last page setup, before the sources, and stays valid', () => {
    const schema = editingSchema();
    const doc = documentWithSources();
    let pos = -1;
    doc.descendants((node, p) => {
      if (pos < 0 && node.attrs['id'] === PARA) pos = p + 1 + 5;
      return pos < 0;
    });
    const state = EditorState.create({ doc, schema });
    const caret = state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));

    const dispatched: EditorState[] = [];
    const result = insertSectionBreak(
      caret,
      { start: 'nextPage', sectionId: SECTION, pageSetupId: NEW_SETUP, writable: () => true },
      (tr) => {
        dispatched.push(caret.apply(tr));
      },
    );
    expect(result).toEqual({ ok: true });
    const after = dispatched[0];
    if (!after) throw new Error('the section break was not dispatched');

    // The document still satisfies its content expressions.
    expect(() => after.doc.check()).not.toThrow();

    const defs = after.doc.firstChild!;
    const kinds: string[] = [];
    defs.forEach((child) => kinds.push(child.type.name));
    expect(kinds).toEqual(['settings', 'style_def', 'page_setup', 'page_setup', 'source_def']);

    expect(pageSetupNode(after.doc, NEW_SETUP)).not.toBeNull();
    let sectionSetup: unknown = null;
    after.doc.descendants((node) => {
      if (node.type.name === 'section_break') sectionSetup = node.attrs['pageSetup'];
      return true;
    });
    expect(sectionSetup).toBe(NEW_SETUP);
  });
});
