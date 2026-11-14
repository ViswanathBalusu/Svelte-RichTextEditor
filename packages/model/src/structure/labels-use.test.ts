// The criteria of the model's node stories that rest on the shared numbering algorithm (CDM-042,
// src/numbering): equations in the Equation sequence (CDM-030), footnote marks from the settings
// (CDM-034), captions per sequence name across regions and tables, and references that print the
// label their target carries (CDM-036).
import { describe, expect, it } from 'vitest';
import {
  addDefs,
  bodyOf,
  cell,
  exampleDoc,
  footnote,
  para,
  row,
  style,
  table,
  text,
  type Json,
} from '../../test/support.ts';
import type { TreeNode } from '../cascade/styles.ts';
import { computeLabels, referenceText } from '../numbering/labels.ts';
import { validate } from '../validate/validate.ts';
import { fieldText } from './field-text.ts';

const seq = (name: string): Json => ({ type: 'field', attrs: { kind: 'seq', name } });
const eq = (id: string, label?: string): Json => ({
  type: 'equation_block',
  attrs: { id, latex: 'x', numbered: true, ...(label ? { label } : {}) },
});
const labels = (d: Json) => computeLabels(d['doc'] as TreeNode);

describe('labels the model stories rely on (CDM-030, CDM-034, CDM-036)', () => {
  it('counts numbered equation blocks in the Equation sequence, and a ref to a label prints it (CDM-030)', () => {
    const d = exampleDoc();
    bodyOf(d).push(
      eq('eqOne00000000001'),
      eq('eqTwo00000000001', 'second'),
      para('pRef000000000001', [
        text('See '),
        { type: 'field', attrs: { kind: 'ref', target: 'eq:second' } },
      ]),
    );
    expect(validate(d).valid).toBe(true);
    const l = labels(d);
    expect([...l.equations.values()]).toEqual(['1', '2']);
    expect(referenceText(l, 'eq:second')).toBe('2');
  });

  it('numbers footnote marks in the format of settings.footnoteFormat (CDM-034)', () => {
    const d = exampleDoc();
    d['doc'].content[0].content[0].attrs.footnoteFormat = 'lowerRoman';
    bodyOf(d)[2]!.content = [
      text('a'),
      footnote('fnOne00000000001'),
      text('b'),
      footnote('fnTwo00000000001'),
    ];
    expect(validate(d).valid).toBe(true);
    expect([...labels(d).footnotes.values()]).toEqual(['i', 'ii']);
  });

  it('numbers captions per sequence name in document order across regions and tables, table and figure captions apart (CDM-036)', () => {
    const d = addDefs(exampleDoc(), style('Caption', { builtIn: true, basedOn: 'Normal' }));
    bodyOf(d)[1]!.content.push(
      para('pCapRegion000001', [text('Table '), seq('Table')], { style: 'Caption' }),
    );
    bodyOf(d).push(
      {
        type: 'figure',
        attrs: {
          id: 'fgFigure00000001',
          asset: '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10',
          width: 10,
          height: 10,
        },
        content: [{ type: 'caption', content: [text('Figure '), seq('Figure')] }],
      },
      table(
        'tTable0000000001',
        [1000],
        [
          row('rRow000000000001', [
            cell('cCell0000000000A', [para('pCapCell00000001', [text('Table '), seq('Table')])]),
          ]),
        ],
      ),
      para('pCapAfter0000001', [text('Table '), seq('Table')], { style: 'Caption' }),
      para('pRefCaption00001', [
        text('See table '),
        { type: 'field', attrs: { kind: 'ref', target: 'node:pCapAfter0000001' } },
      ]),
    );
    expect(
      validate(d, { attachedAssets: new Set(['0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10']) }).violations,
    ).toEqual([]);
    const l = labels(d);
    const value = (id: string) => l.sequences.get(id)![0]!.value;
    expect([
      value('pCapRegion000001'),
      value('pCapCell00000001'),
      value('pCapAfter0000001'),
    ]).toEqual([1, 2, 3]);
    expect(value('fgFigure00000001')).toBe(1);
    // A ref prints the label its target carries, as literal text.
    const ref = { kind: 'ref', target: 'node:pCapAfter0000001' };
    expect(fieldText(ref, { labelOf: (t) => referenceText(l, t) })).toEqual({
      computed: true,
      text: '3',
    });
  });
});
