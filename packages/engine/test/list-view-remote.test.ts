/**
 * List semantics follow remote work (FE-105 criterion 5): a remote change that renumbers a list
 * arrives as a rebuild (remote.ts) and the exposed position updates. The rebuild is built the way
 * the sync client hands it over (no unconfirmed local steps), so the transaction is the one the
 * editor receives in production.
 */
import { EditorState } from 'prosemirror-state';
import { Fragment, Slice } from 'prosemirror-model';
import type { Node as PMNode } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import type { Decoration } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { rebuildTransaction } from '../src/remote.ts';
import { editingSchema } from '../src/schema.ts';
import { listSemanticsKey, listSemanticsPlugin } from '../src/view/list-view.ts';
import type { Rebuild } from '../src/sync/state.ts';

const LIST = 'lList000000000001';

function para(id: string, text: string, level: number | null) {
  return {
    type: 'paragraph',
    attrs: {
      id,
      style: null,
      numbering: level === null ? null : { numberingId: 'num1', level, listId: LIST },
    },
    content: [{ type: 'text', text }],
  };
}

function stateOf(body: unknown[]): EditorState {
  const schema = editingSchema();
  const doc = schema.nodeFromJSON({
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
  });
  return EditorState.create({ doc, plugins: [listSemanticsPlugin()] });
}

function posOf(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no paragraph ${id}`);
  return found;
}

function attrsById(state: EditorState): Record<string, Record<string, string>> {
  const set = listSemanticsKey.getState(state)!;
  const out: Record<string, Record<string, string>> = {};
  for (const d of set.find() as Array<Decoration & { type: { attrs: Record<string, string> } }>) {
    out[String(state.doc.nodeAt(d.from)!.attrs['id'])] = d.type.attrs;
  }
  return out;
}

/** A remote rebuild whose only confirmed change is `step`, applied to the state's document. */
function remoteRebuild(state: EditorState, step: ReplaceStep): Rebuild {
  const result = step.apply(state.doc);
  if (!result.doc) throw new Error('the remote step does not apply');
  return {
    kind: 'rebuild',
    base: state.doc,
    before: [],
    over: [step],
    overOrigins: [-1],
    after: [],
    afterOrigins: [],
    doc: result.doc,
  };
}

describe('list semantics after remote work (FE-105 criterion 5)', () => {
  it('moves the position of a paragraph when a remote paragraph joins the list before it', () => {
    const state = stateOf([para('p1', 'One', 0), para('p2', 'Two', 0), para('p3', 'Three', 0)]);
    expect(attrsById(state)['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '3' });
    const schema = state.schema;
    const inserted = schema.nodeFromJSON(para('pNew', 'Remote', 0));
    const at = posOf(state.doc, 'p2');
    const rebuild = remoteRebuild(
      state,
      new ReplaceStep(at, at, new Slice(Fragment.from(inserted), 0, 0)),
    );
    const next = state.apply(rebuildTransaction(state, rebuild));
    expect(next.doc.eq(rebuild.doc)).toBe(true);
    expect(attrsById(next)['p2']).toMatchObject({ 'aria-posinset': '3', 'aria-setsize': '4' });
    expect(attrsById(next)['pNew']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '4' });
  });

  it('renumbers the rest of the list when a remote deletion removes an item', () => {
    const state = stateOf([para('p1', 'One', 0), para('p2', 'Two', 0), para('p3', 'Three', 0)]);
    const node = state.doc.nodeAt(posOf(state.doc, 'p2'))!;
    const from = posOf(state.doc, 'p2');
    const rebuild = remoteRebuild(state, new ReplaceStep(from, from + node.nodeSize, Slice.empty));
    const next = state.apply(rebuildTransaction(state, rebuild));
    const attrs = attrsById(next);
    expect(Object.keys(attrs).sort()).toEqual(['p1', 'p3']);
    expect(attrs['p3']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });
});
