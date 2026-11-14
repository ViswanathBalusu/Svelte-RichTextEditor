/**
 * A list that continues across a region or a table keeps its position (FE-105 criterion 4). The
 * exposed `aria-posinset` and `aria-setsize` are checked against the model's computed label
 * (`computeLabels`, 03 §7): the label of each item is the ordinal the position gives.
 */
import { computeLabels } from '@docedit/model';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { Decoration } from 'prosemirror-view';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import { listSemanticsKey, listSemanticsPlugin } from '../src/view/list-view.ts';

const LIST = 'lList000000000001';
const OTHER = 'lList000000000002';

const level = { format: 'decimal', text: '%1.', start: 1 };

function numbered(id: string, listId = LIST, lvl = 0) {
  return {
    type: 'paragraph',
    attrs: { id, style: null, numbering: { numberingId: 'num1', level: lvl, listId } },
    content: [{ type: 'text', text: id }],
  };
}

function plain(id: string) {
  return {
    type: 'paragraph',
    attrs: { id, style: null, numbering: null },
    content: [{ type: 'text', text: id }],
  };
}

function region(id: string, content: unknown[]) {
  return { type: 'region', attrs: { title: id }, content };
}

function table(cells: unknown[][]) {
  return {
    type: 'table',
    content: cells.map((row) => ({
      type: 'table_row',
      content: row.map((c) => ({
        type: 'table_cell',
        attrs: { colspan: 1, rowspan: 1 },
        content: [c],
      })),
    })),
  };
}

function numberedWith(id: string, extra: Record<string, unknown>, listId = LIST, lvl = 0) {
  const p = numbered(id, listId, lvl);
  return { ...p, attrs: { ...p.attrs, ...extra } };
}

/** A paragraph numbered only through its paragraph style. */
function styled(id: string, style: string) {
  return {
    type: 'paragraph',
    attrs: { id, style, numbering: null },
    content: [{ type: 'text', text: id }],
  };
}

/** A paragraph that holds a footnote, whose own paragraph is `inner`. */
function withFootnote(id: string, inner: unknown) {
  return {
    type: 'paragraph',
    attrs: { id, style: null, numbering: null },
    content: [
      { type: 'text', text: id },
      { type: 'footnote', attrs: { id: `f${id}` }, content: [inner] },
    ],
  };
}

function stateOf(body: unknown[], extraDefs: unknown[] = [], start = 1): EditorState {
  const schema = editingSchema();
  const nine = Array.from({ length: 9 }, () => ({ ...level, start }));
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
          ...extraDefs,
          { type: 'numbering_def', attrs: { id: 'num1', levels: nine } },
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  });
  return EditorState.create({ doc, plugins: [listSemanticsPlugin()] });
}

/** The decoration attributes by paragraph identifier, and the labels of the same paragraphs. */
function readBack(state: EditorState): {
  attrs: Record<string, Record<string, string>>;
  labels: Record<string, string | undefined>;
} {
  const set = listSemanticsKey.getState(state)!;
  const attrs: Record<string, Record<string, string>> = {};
  for (const d of set.find() as Array<Decoration & { type: { attrs: Record<string, string> } }>) {
    attrs[String(state.doc.nodeAt(d.from)!.attrs['id'])] = d.type.attrs;
  }
  const computed = computeLabels(state.doc as unknown as PMNode);
  const labels: Record<string, string | undefined> = {};
  state.doc.descendants((n) => {
    if (n.type.name === 'paragraph') {
      const id = String(n.attrs['id']);
      labels[id] = computed.lists.get(id)?.text;
    }
    return true;
  });
  return { attrs, labels };
}

describe('a list across a region or a table (FE-105 criterion 4)', () => {
  it('continues the position and the size across a table', () => {
    const state = stateOf([numbered('p1'), table([[plain('c1'), plain('c2')]]), numbered('p2')]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', p2: '2.' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(attrs['p1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '2' });
  });

  it('continues the position and the size across a region boundary', () => {
    const state = stateOf([
      numbered('p1'),
      region('R', [numbered('p2'), numbered('p3')]),
      numbered('p4'),
    ]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', p2: '2.', p3: '3.', p4: '4.' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '4' });
    expect(attrs['p4']).toMatchObject({ 'aria-posinset': '4', 'aria-setsize': '4' });
  });

  it('counts a numbered paragraph inside a table cell in the list', () => {
    const state = stateOf([numbered('p1'), table([[numbered('c1')]]), numbered('p2')]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', c1: '2.', p2: '3.' });
    expect(attrs['c1']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '3' });
  });

  it('does not end a list at a paragraph without numbering', () => {
    const state = stateOf([numbered('p1'), plain('x'), numbered('p2')]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', p2: '2.' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('counts a list across an item of another list, as its computed label does', () => {
    // A numbered cell of another list inside the table the list continues across.
    const state = stateOf([numbered('p1'), table([[numbered('q1', OTHER)]]), numbered('p2')]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', q1: '1.', p2: '2.' });
    expect(attrs['q1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '1' });
    expect(attrs['p1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '2' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('counts two interleaved lists each on its own, across a region', () => {
    const state = stateOf([
      numbered('p1'),
      numbered('q1', OTHER),
      region('R', [numbered('p2'), numbered('q2', OTHER)]),
      numbered('p3'),
    ]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', q1: '1.', p2: '2.', q2: '2.', p3: '3.' });
    expect(attrs['p3']).toMatchObject({ 'aria-posinset': '3', 'aria-setsize': '3' });
    expect(attrs['q2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('gives ordinal positions from 1 to a list whose level starts at 3', () => {
    const state = stateOf([numbered('p1'), region('R', [numbered('p2')]), numbered('p3')], [], 3);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '3.', p2: '4.', p3: '5.' });
    expect(attrs['p1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '3' });
    expect(attrs['p3']).toMatchObject({ 'aria-posinset': '3', 'aria-setsize': '3' });
  });

  it('starts a new set at a numberingRestart, where the computed label restarts', () => {
    const state = stateOf([
      numbered('p1'),
      numbered('p2'),
      table([[numberedWith('p3', { numberingRestart: 1 })]]),
      numbered('p4'),
    ]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', p2: '2.', p3: '1.', p4: '2.' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(attrs['p3']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '2' });
    expect(attrs['p4']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('restarts only the level of the restarting item', () => {
    const state = stateOf([
      numbered('p1'),
      numbered('a1', LIST, 1),
      numbered('a2', LIST, 1),
      numberedWith('a3', { numberingRestart: 1 }, LIST, 1),
      numbered('p2'),
    ]);
    const { attrs } = readBack(state);
    expect(attrs['a2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
    expect(attrs['a3']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '1' });
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '2', 'aria-setsize': '2' });
  });

  it('counts numbering that comes from a paragraph style', () => {
    const listStyle = {
      type: 'style_def',
      attrs: {
        id: 'ListNumber',
        kind: 'paragraph',
        name: 'List Number',
        builtIn: false,
        numbering: { numberingId: 'num1', level: 0, listId: LIST },
      },
    };
    const state = stateOf(
      [styled('p1', 'ListNumber'), table([[numbered('p2')]]), styled('p3', 'ListNumber')],
      [listStyle],
    );
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', p2: '2.', p3: '3.' });
    expect(attrs['p1']).toMatchObject({ 'aria-posinset': '1', 'aria-setsize': '3' });
    expect(attrs['p3']).toMatchObject({ 'aria-posinset': '3', 'aria-setsize': '3' });
  });

  it("counts a footnote's numbered paragraph at its place, without decorating it", () => {
    const state = stateOf([numbered('p1'), withFootnote('x', numbered('n1')), numbered('p2')]);
    const { attrs, labels } = readBack(state);
    expect(labels).toMatchObject({ p1: '1.', n1: '2.', p2: '3.' });
    expect(attrs['n1']).toBeUndefined();
    expect(attrs['p2']).toMatchObject({ 'aria-posinset': '3', 'aria-setsize': '3' });
  });

  it('gives every item the position its computed label gives, for random layouts of two lists', () => {
    // Each slot is a plain paragraph, or a numbered item of one of two lists, alone or in a region
    // or a table, possibly restarting its list at 1.
    const slot = fc.record({
      kind: fc.constantFrom('item', 'plain', 'region', 'table'),
      list: fc.constantFrom(LIST, OTHER),
      restart: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(slot, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        (slots, start) => {
          let n = 0;
          const body = slots.map(({ kind, list, restart }) => {
            n += 1;
            const id = `s${n}`;
            const item = restart
              ? numberedWith(id, { numberingRestart: start }, list)
              : numbered(id, list);
            if (kind === 'plain') return plain(id);
            if (kind === 'item') return item;
            if (kind === 'region') return region(id, [item]);
            return table([[item]]);
          });
          const state = stateOf(body, [], start);
          const { attrs, labels } = readBack(state);
          // The expected sets: per list, in document order, a new set at each restart.
          for (const list of [LIST, OTHER]) {
            const sets: string[][] = [];
            slots.forEach((s, i) => {
              if (s.kind === 'plain' || s.list !== list) return;
              if (s.restart || sets.length === 0) sets.push([]);
              sets[sets.length - 1]!.push(`s${i + 1}`);
            });
            for (const set of sets) {
              set.forEach((id, i) => {
                // The label's ordinal from the level's start is the position in its set.
                expect(labels[id]).toBe(`${start + i}.`);
                expect(attrs[id]).toMatchObject({
                  'aria-posinset': String(i + 1),
                  'aria-setsize': String(set.length),
                });
              });
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
