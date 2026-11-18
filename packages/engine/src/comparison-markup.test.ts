// A comparison as decoration specs over the newer version (HIS-013 criteria 1 and 4, at the level of
// the specs; the drawing in a browser is `view/comparison-view.universal.test.ts`).
import { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { type ComparisonChange, comparisonSpecs } from './comparison-markup.ts';
import { editingSchema } from './schema.ts';
import { SPIKE_IDS, spikeDocument } from './spike-document.ts';
import { authorTone, suggestionClasses, suggestionSpecs } from './suggestion-markup.ts';

const doc = PMNode.fromJSON(editingSchema(), spikeDocument().doc);

/** The position of a block and the text it holds. */
function block(id: string): { pos: number; size: number; text: string } {
  let found: { pos: number; size: number; text: string } | null = null;
  doc.descendants((n, pos) => {
    if (n.attrs['id'] === id && !found) found = { pos, size: n.nodeSize, text: n.textContent };
    return true;
  });
  if (!found) throw new Error(`no block ${id}`);
  return found;
}

const modified: ComparisonChange = {
  kind: 'modified',
  blockId: SPIKE_IDS.intro,
  spans: [
    { op: 'insert', at: 0, text: 'Alp', user: 'ada', seq: 3 },
    { op: 'delete', at: 4, text: 'old ', user: 'bob', seq: 4 },
  ],
};

describe('a comparison drawn over the newer version (HIS-013)', () => {
  it('draws an insertion over its text with the classes and tone of a suggestion mark (criterion 4)', () => {
    const specs = comparisonSpecs(doc, [modified], { showDeleted: false });
    const intro = block(SPIKE_IDS.intro);
    const ins = specs.find((s) => s.type === 'inline');
    expect(ins).toMatchObject({ type: 'inline', from: intro.pos + 1, to: intro.pos + 1 + 3 });
    expect(ins?.attrs['class']).toBe(suggestionClasses('all', 'ins').join(' '));
    expect(ins?.attrs['data-suggestion-user']).toBe('ada');
    expect(ins?.attrs['data-suggestion-tone']).toBe(String(authorTone('ada')));
    // The block has a change bar in the margin.
    const bar = specs.find((s) => s.type === 'block');
    expect(bar).toMatchObject({ from: intro.pos, to: intro.pos + intro.size });
    expect(bar?.attrs['class']).toContain('de-change-bar');
  });

  it('draws deletions only on demand, so that the layout does not move (criterion 1)', () => {
    const off = comparisonSpecs(doc, [modified], { showDeleted: false });
    expect(off.some((s) => s.type === 'deleted')).toBe(false);
    const on = comparisonSpecs(doc, [modified], { showDeleted: true });
    const del = on.find((s) => s.type === 'deleted');
    expect(del).toMatchObject({
      type: 'deleted',
      text: 'old ',
      at: block(SPIKE_IDS.intro).pos + 1 + 4,
    });
    expect(del?.attrs['class']).toBe(suggestionClasses('all', 'del').join(' '));
    expect(del?.attrs['data-suggestion-user']).toBe('bob');
  });

  it('marks an added block and a formatted block with the kind and a change bar, and skips a removed one', () => {
    const specs = comparisonSpecs(
      doc,
      [
        { kind: 'added', blockId: SPIKE_IDS.legal, user: 'ada', seq: 1 },
        { kind: 'formatted', blockId: SPIKE_IDS.after, user: 'bob', seq: 2 },
        { kind: 'removed', blockId: 'pGone000000000001', user: 'cy', seq: 3 },
      ],
      { showDeleted: true },
    );
    // The removed block is not in the document: nothing to draw, the navigator still lists it.
    expect(specs).toHaveLength(2);
    expect(specs[0]?.attrs['class']).toBe(`${suggestionClasses('all', 'ins')[0]} de-change-bar`);
    expect(specs[1]?.attrs['class']).toBe(`${suggestionClasses('all', 'fmt')[0]} de-change-bar`);
    expect(specs.map((s) => s.index)).toEqual([0, 1]);
  });

  it('is deterministic and clips a span to its block', () => {
    const wide: ComparisonChange = {
      kind: 'modified',
      blockId: SPIKE_IDS.title,
      spans: [{ op: 'insert', at: 0, text: 'x'.repeat(500), user: 'ada' }],
    };
    const a = comparisonSpecs(doc, [wide], { showDeleted: false });
    const b = comparisonSpecs(doc, [wide], { showDeleted: false });
    expect(a).toEqual(b);
    const title = block(SPIKE_IDS.title);
    const ins = a.find((s) => s.type === 'inline');
    expect(ins && ins.type === 'inline' && ins.to).toBe(title.pos + title.size - 1);
  });
});

describe('one change, one identity in both drawings (HIS-042 criterion 3)', () => {
  it('draws an insertion as the mark of the same user is drawn, and names the commit that introduced it', () => {
    // The paragraph's text carries a suggested insertion `sgAAAAAAAAAAAAAA` by ada.
    const json = structuredClone(spikeDocument().doc) as unknown as {
      attrs?: { id?: string };
      content?: Array<{ type?: string; marks?: unknown[] }>;
    };
    const mark = (n: typeof json): boolean => {
      if (n.attrs?.id === SPIKE_IDS.intro) {
        for (const c of n.content ?? [])
          if (c.type === 'text')
            c.marks = [{ type: 'ins', attrs: { id: 'sgAAAAAAAAAAAAAA', user: 'ada' } }];
        return true;
      }
      return (n.content ?? []).some((c) => mark(c as typeof json));
    };
    mark(json);
    const marked = PMNode.fromJSON(editingSchema(), json);

    const asMark = suggestionSpecs(marked, 'all').find((s) => s.attrs['data-suggestion-id'])!;
    const asChange = comparisonSpecs(marked, [modified], { showDeleted: false }).find(
      (s) => s.type === 'inline',
    )!;
    // The same rendering: the classes, the author and the tone are those of the mark.
    for (const name of ['class', 'data-suggestion-user', 'data-suggestion-tone'])
      expect(asChange.attrs[name], name).toBe(asMark.attrs[name]);
    // The same identity: a user, and the suggestion identifier on the mark against the commit on
    // the change. The history index (@docedit/history, suggestionIndex, kept by the service)
    // maps the identifier to the commit that introduced it, here commit 3, so a change and the
    // suggestion it introduced are found by each other.
    const introducedBy = new Map([['sgAAAAAAAAAAAAAA', 3]]);
    expect(String(introducedBy.get(asMark.attrs['data-suggestion-id']!))).toBe(
      asChange.attrs['data-change-seq'],
    );
  });
});
