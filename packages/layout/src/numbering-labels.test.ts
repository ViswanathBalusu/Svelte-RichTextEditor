/**
 * List and heading labels come from the shared numbering algorithm (FE-077 criterion 2): every
 * numbered paragraph prints the label that `computeLabels` in `packages/model` computes for it, as
 * literal text. The cases are the list fixture of `packages/model` (the one its own label tests
 * check), assembled into a CDM envelope the way that fixture's format says. Each case's `expected`
 * names every label of the document by paragraph identifier, so the comparison is two-way: a
 * paragraph the algorithm numbers must print that label, and no other paragraph may print one.
 */
import lists from '@docedit/model/fixtures/semantics/numbering-lists.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowBlock } from './flow.ts';

type J = Record<string, unknown>;

interface ListCase {
  id: string;
  settings?: J;
  styles?: J[];
  numberings?: J[];
  stories?: J[];
  body?: J[];
  valid?: boolean;
  expected: { lists?: { id: string; text: string }[] };
}

const file = lists as unknown as {
  settings?: J;
  styles?: J[];
  numberings?: J[];
  cases: ListCase[];
};

/** A case's own entries replace the file's with the same identifier, as in the model's test. */
function mergeById(base: readonly J[], extra: readonly J[]): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

/** The CDM envelope of a case: its defs (settings, styles, numberings, page setup `ps1`), stories, body. */
function envelopeOf(c: ListCase): CdmEnvelopeLike {
  const defs = {
    type: 'defs',
    content: [
      { type: 'settings', attrs: { ...file.settings, ...c.settings } },
      ...mergeById(file.styles ?? [], c.styles ?? []),
      ...mergeById(file.numberings ?? [], c.numberings ?? []),
      { type: 'page_setup', attrs: { id: 'ps1' } },
    ],
  };
  const doc = {
    type: 'doc',
    content: [
      defs,
      ...(c.stories ?? []),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body ?? [] },
    ],
  };
  return { doc: doc as unknown as CdmNode };
}

/** The label each flow paragraph prints, by the identifier of its CDM block. */
function printedLabels(blocks: readonly FlowBlock[], into: Map<string, string>): void {
  for (const block of blocks) {
    if (block.kind === 'table') {
      for (const row of block.rows) for (const cell of row.cells) printedLabels(cell.blocks, into);
      continue;
    }
    if (block.kind !== 'paragraph' || block.part !== 0) continue;
    const label = block.inlines.find((i) => i.kind === 'text' && i.role === 'label');
    if (label && label.kind === 'text') {
      if (into.has(block.id)) throw new Error(`two labels for ${block.id}`);
      into.set(block.id, label.text);
    }
  }
}

const cases = file.cases.filter((c) => c.valid !== false);

describe('list and heading labels from the shared numbering algorithm (FE-077 criterion 2)', () => {
  it('has the list fixture to check against', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const c of cases) {
    it(`prints the algorithm's labels for ${c.id}`, () => {
      const flow = toFlow(envelopeOf(c));
      const printed = new Map<string, string>();
      for (const section of flow.sections) printedLabels(section.blocks, printed);
      for (const story of flow.stories.values()) printedLabels(story, printed);
      // A label that is empty (a template Word prints nothing for, decision 238) prints nothing.
      const expected = new Map(
        (c.expected.lists ?? []).filter((e) => e.text !== '').map((e) => [e.id, e.text]),
      );
      expect(Object.fromEntries(printed)).toEqual(Object.fromEntries(expected));
    });
  }
});
