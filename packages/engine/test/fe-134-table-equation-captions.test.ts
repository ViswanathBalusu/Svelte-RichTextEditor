/**
 * FE-134 criterion 1 for tables and equations, and the targets the cross-reference dialog offers
 * (criterion 2), through the core: a table caption is a paragraph with a `seq` field named `Table`,
 * an equation caption numbers the block in the `Equation` sequence, and a reference to either is
 * inserted with the number the model computes.
 */
import { computeLabels } from '@docedit/model';
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { fieldTexts } from '../src/captions-refs.ts';
import { LAYOUT_IDS, layoutEnvelope, posOfNode } from './layout-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

const OWNER: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'owner',
  caps: [...EDIT, 'structure', 'manage'],
  scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
  leases: {},
  fill: null,
  restrictions: [],
};

const EQ1 = 'eqOne0000000000001';
const EQ2 = 'eqTwo0000000000001';
const BOOKMARKED = 'pBookmarked00001';
const FIGURE16 = 'figCapture000001';

/** The layout document with a Caption style, two block equations, and a bookmarked Algorithm caption. */
function envelope(): CdmEnvelope {
  const doc = layoutEnvelope() as unknown as {
    content: Array<{ type: string; content: Array<Record<string, unknown>> }>;
  };
  const defs = doc.content.find((n) => n.type === 'defs')!;
  defs.content.splice(2, 0, {
    type: 'style_def',
    attrs: { id: 'Caption', kind: 'paragraph', name: 'Caption', builtIn: true, basedOn: 'Normal' },
  });
  const body = doc.content.find((n) => n.type === 'body')!;
  body.content.push(
    { type: 'figure', attrs: { id: FIGURE16 } },
    { type: 'equation_block', attrs: { id: EQ1, latex: 'a=b', numbered: false } },
    { type: 'equation_block', attrs: { id: EQ2, latex: 'c=d', numbered: false } },
    {
      type: 'paragraph',
      attrs: { id: BOOKMARKED, style: null },
      content: [
        { type: 'anchor', attrs: { id: null, name: 'marker' } },
        { type: 'text', text: 'Step ' },
        { type: 'field', attrs: { kind: 'seq', name: 'Algorithm', cached: '1' } },
      ],
    },
  );
  return { cdm: 1, requires: [], doc: doc as unknown as CdmJsonNode };
}

function core(): DocumentCore {
  return new DocumentCore({ doc: envelope(), access: OWNER, schedule: microtask });
}

/** The paragraphs that hold a `seq` field of `name`, as `[text, computed number]`. */
function seqParagraphs(c: DocumentCore, name: string): Array<[string, string | null]> {
  const doc = internals(c).state.doc;
  const texts = new Map(fieldTexts(doc).map((f) => [f.pos, f.text]));
  const out: Array<[string, string | null]> = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return true;
    node.forEach((child, offset) => {
      if (
        child.type.name === 'field' &&
        child.attrs['kind'] === 'seq' &&
        child.attrs['name'] === name
      )
        out.push([node.textContent, texts.get(pos + 1 + offset) ?? null]);
    });
    return false;
  });
  return out;
}

describe('a table caption is numbered in the Table sequence (FE-134 criterion 1)', () => {
  it('adds a paragraph with a Table seq field above the table at the caret', () => {
    const c = core();
    caret(c, LAYOUT_IDS.cell, 1);
    expect(c.exec('insertCaption', { caption: { kind: 'table' } })).toBe(true);
    const doc = internals(c).state.doc;
    const table = doc.child(2).child(1);
    expect(table.type.name).toBe('paragraph');
    expect(table.attrs['style']).toBe('Caption');
    expect(seqParagraphs(c, 'Table')).toEqual([['Table 1', '1']]);
    expect(doc.child(2).child(2).type.name).toBe('table');
    doc.check();
  });

  it('counts tables apart from figures, and refuses a second caption on the same table', () => {
    const c = core();
    expect(c.exec('insertCaption', { figure: LAYOUT_IDS.figure2 })).toBe(true);
    caret(c, LAYOUT_IDS.cell, 1);
    expect(c.exec('insertCaption', { caption: { kind: 'table' } })).toBe(true);
    expect(c.exec('insertCaption', { caption: { kind: 'table' } })).toBe(false);
  });

  it('is refused outside a table, and nothing changes', () => {
    const c = core();
    caret(c, LAYOUT_IDS.pB, 1);
    const before = internals(c).state.doc;
    expect(c.exec('insertCaption', { caption: { kind: 'table' } })).toBe(false);
    expect(internals(c).state.doc.eq(before)).toBe(true);
  });

  it('takes the figure, the table or the selected equation with the kind `here`', () => {
    const c = core();
    caret(c, LAYOUT_IDS.cell, 1);
    expect(c.exec('insertCaption', { caption: { kind: 'here' } })).toBe(true);
    expect(seqParagraphs(c, 'Table')).toHaveLength(1);
    caret(c, LAYOUT_IDS.pB, 1);
    expect(c.exec('insertCaption', { caption: { kind: 'here' } })).toBe(false);
  });
});

describe('an equation caption numbers the block in the Equation sequence (FE-134 criterion 1)', () => {
  it('sets numbered and a label, and the model counts the equation', () => {
    const c = core();
    const first = c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } });
    expect(first).toBe(true);
    expect(
      internals(c).state.doc.nodeAt(posOfNode(internals(c).state.doc, EQ1))!.attrs['label'],
    ).toBe('eq1');
    const second = c.exec('insertCaption', { caption: { kind: 'equation', id: EQ2 } });
    expect(second).toBe(true);
    const labels = computeLabels(internals(c).state.doc);
    expect(labels.equations.get(EQ1)).toBe('1');
    expect(labels.equations.get(EQ2)).toBe('2');
    internals(c).state.doc.check();
  });

  it('keeps a label the equation has, refuses a numbered or a missing equation', () => {
    const c = core();
    expect(c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } })).toBe(true);
    expect(c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } })).toBe(false);
    expect(
      c.exec('insertCaption', { caption: { kind: 'equation', id: 'noSuchEquation001' } }),
    ).toBe(false);
  });

  it('numbers by position: an equation placed before takes number 1 and the other moves to 2', () => {
    const c = core();
    c.exec('insertCaption', { caption: { kind: 'equation', id: EQ2 } });
    expect(computeLabels(internals(c).state.doc).equations.get(EQ2)).toBe('1');
    c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } });
    const labels = computeLabels(internals(c).state.doc);
    expect(labels.equations.get(EQ1)).toBe('1');
    expect(labels.equations.get(EQ2)).toBe('2');
  });
});

describe('the targets a cross-reference offers (FE-134 criterion 2)', () => {
  it('lists a caption, a numbered equation and a bookmark with the text a reference prints', () => {
    const c = core();
    caret(c, LAYOUT_IDS.cell, 1);
    c.exec('insertCaption', { caption: { kind: 'table' } });
    c.exec('insertCaption', { figure: FIGURE16 });
    c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } });
    const targets = c.referenceTargets();
    const kinds = targets.map((t) => [t.kind, t.label]);
    expect(kinds).toContainEqual(['caption', '1']);
    expect(kinds).toContainEqual(['equation', '1']);
    expect(targets.find((t) => t.kind === 'equation')).toMatchObject({
      target: 'eq:eq1',
      text: 'eq1',
    });
    expect(targets.find((t) => t.kind === 'caption' && t.text === 'Table 1')).toBeDefined();
    expect(targets.find((t) => t.kind === 'caption' && t.text === 'Figure 1')).toMatchObject({
      target: `node:${FIGURE16}`,
    });
  });

  it('offers a bookmark on a numbered block, and nothing for what has no label', () => {
    const c = core();
    // Unnumbered paragraphs, headings and equations are not offered: they print no number.
    expect(c.referenceTargets().map((t) => [t.kind, t.target, t.label, t.text])).toEqual([
      ['caption', 'node:' + BOOKMARKED, '1', 'Step 1'],
      ['bookmark', 'bookmark:marker', '1', 'marker'],
    ]);
  });

  it('inserts a reference to each kind of target, and the field reads the same number', () => {
    const c = core();
    caret(c, LAYOUT_IDS.cell, 1);
    c.exec('insertCaption', { caption: { kind: 'table' } });
    c.exec('insertCaption', { caption: { kind: 'equation', id: EQ1 } });
    const targets = c.referenceTargets();
    for (const target of targets) {
      caret(c, LAYOUT_IDS.pB, 1);
      expect(c.exec('insertReference', { reference: { target: target.target } })).toBe(true);
    }
    const refs: Array<[string, unknown]> = [];
    internals(c).state.doc.descendants((node) => {
      if (node.type.name === 'field' && node.attrs['kind'] === 'ref')
        refs.push([String(node.attrs['target']), node.attrs['cached']]);
      return true;
    });
    expect(refs.sort()).toEqual(targets.map((t): [string, unknown] => [t.target, t.label]).sort());
  });
});
