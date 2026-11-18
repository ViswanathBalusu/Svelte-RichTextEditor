/**
 * Paragraphs added and removed in suggestion mode (FE-044 criteria 1 and 2; 02 §5.2; 03 §5). The
 * core is headless, in review mode, for the user `alice`. Enter at the end of a paragraph, a paste of
 * whole paragraphs and a deletion of whole paragraphs run through `internals(core).dispatch`, which is
 * the core's own dispatch, so the transaction is recorded by `recordAsSuggestion`.
 *
 * The body of the spike document holds only a table, so the test first adds two body paragraphs in
 * edit mode, then reopens the document in review mode.
 *
 * Node.js only; the authority's check of these marks is in the story Notes (not run here).
 */
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { blockEntries } from '../src/block-suggestion.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import { microtask } from './support.ts';

/** The paragraphs that are direct children of the body, in order: position and node. */
function bodyParagraphs(doc: PMNode): { pos: number; node: PMNode }[] {
  const out: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && doc.resolve(pos).parent.type.name === 'body') {
      out.push({ pos, node });
    }
    return true;
  });
  return out;
}

/** The spike document with two body paragraphs, "alpha" and "beta", built in edit mode. */
function withBodyParagraphs() {
  const edit = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(edit);
  const { schema } = i;
  const paragraphs = ['alpha', 'beta'].map((t) =>
    schema.nodes['paragraph']!.create(null, schema.text(t)),
  );
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, paragraphs));
  return edit.getContent();
}

function reviewer(): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc: withBodyParagraphs(),
    schedule: microtask,
    mode: 'review',
    user: 'alice',
    access: editorAccess(),
    generateId: () => `p${String(++n).padStart(15, '0')}`,
  });
}

function nodeMarks(node: PMNode): { type: string; user: unknown }[] {
  return blockEntries(node).map((e) => ({ type: e.type, user: e.attrs.user }));
}

describe('FE-044 criterion 1: a paragraph the user adds carries ins', () => {
  it('Enter at the end of a paragraph adds an empty paragraph with one ins naming the user', () => {
    const c = reviewer();
    const i = internals(c);
    const before = bodyParagraphs(i.state.doc);
    const alpha = before.find((p) => p.node.textContent === 'alpha')!;
    const end = alpha.pos + alpha.node.nodeSize - 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, end)));
    i.dispatch(i.state.tr.split(end));
    const after = bodyParagraphs(i.state.doc);
    expect(after.length).toBe(before.length + 1);
    const added = after[after.indexOf(after.find((p) => p.pos === alpha.pos)!) + 1]!;
    expect(added.node.content.size).toBe(0);
    expect(nodeMarks(added.node)).toEqual([{ type: 'ins', user: 'alice' }]);
    expect(blockEntries(added.node)[0]!.attrs.id).toBeTruthy();
    expect(validate(c.getContent()).valid).toBe(true);
  });

  it('Enter in the middle of text is refused and the document does not change', () => {
    const c = reviewer();
    const i = internals(c);
    const alpha = bodyParagraphs(i.state.doc).find((p) => p.node.textContent === 'alpha')!;
    const before = JSON.stringify(c.getContent());
    i.dispatch(i.state.tr.split(alpha.pos + 3));
    expect(JSON.stringify(c.getContent())).toBe(before);
  });

  it('a paste of whole paragraphs at a block boundary carries one ins on each', () => {
    const c = reviewer();
    const i = internals(c);
    const { schema } = i;
    const alpha = bodyParagraphs(i.state.doc).find((p) => p.node.textContent === 'alpha')!;
    const at = alpha.pos + alpha.node.nodeSize;
    const pasted = ['one', 'two'].map((t) =>
      schema.nodes['paragraph']!.create(null, schema.text(t)),
    );
    i.dispatch(i.state.tr.insert(at, pasted));
    const inserted = bodyParagraphs(i.state.doc).filter((p) =>
      ['one', 'two'].includes(p.node.textContent),
    );
    expect(inserted.map((p) => p.node.textContent)).toEqual(['one', 'two']);
    for (const p of inserted) expect(nodeMarks(p.node)).toEqual([{ type: 'ins', user: 'alice' }]);
  });
});

describe('FE-044 criterion 2: a whole paragraph the user deletes carries del', () => {
  it('deleting a baseline paragraph keeps it with one del naming the user', () => {
    const c = reviewer();
    const i = internals(c);
    const beta = bodyParagraphs(i.state.doc).find((p) => p.node.textContent === 'beta')!;
    const count = bodyParagraphs(i.state.doc).length;
    i.dispatch(i.state.tr.delete(beta.pos, beta.pos + beta.node.nodeSize));
    const after = bodyParagraphs(i.state.doc);
    expect(after.length).toBe(count);
    const kept = after.find((p) => p.node.textContent === 'beta')!;
    expect(nodeMarks(kept.node)).toEqual([{ type: 'del', user: 'alice' }]);
    expect(validate(c.getContent()).valid).toBe(true);
  });

  it('deleting a paragraph the same user inserted removes it', () => {
    const c = reviewer();
    const i = internals(c);
    const { schema } = i;
    const alpha = bodyParagraphs(i.state.doc).find((p) => p.node.textContent === 'alpha')!;
    i.dispatch(
      i.state.tr.insert(
        alpha.pos + alpha.node.nodeSize,
        schema.nodes['paragraph']!.create(null, schema.text('mine')),
      ),
    );
    const made = bodyParagraphs(i.state.doc).find((p) => p.node.textContent === 'mine')!;
    expect(nodeMarks(made.node)).toEqual([{ type: 'ins', user: 'alice' }]);
    const count = bodyParagraphs(i.state.doc).length;
    i.dispatch(i.state.tr.delete(made.pos, made.pos + made.node.nodeSize));
    expect(bodyParagraphs(i.state.doc).length).toBe(count - 1);
    expect(bodyParagraphs(i.state.doc).some((p) => p.node.textContent === 'mine')).toBe(false);
  });
});
