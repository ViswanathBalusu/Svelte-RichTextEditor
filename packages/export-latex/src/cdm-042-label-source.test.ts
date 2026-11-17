/**
 * CDM-042 criterion 1, writers' side (Node.js): the LaTeX converter and the HTML and Markdown
 * writers compute no list label of their own. The model's `computeLabels` is replaced by a version
 * that returns marked labels (`ZQ<n>Z` in place of each real label); every numbered paragraph is
 * then written with its marked label, and none of the real labels (`(iv)`, `(v)`, `(v.a)`, `(vi)`,
 * `Part IV`) appears. A second code path that counted list items would write a real label.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Model from '@docedit/model';
import { blockLines, decodeStrings, doc, run } from '../test/docs.ts';
import { htmlText } from './html-writer.ts';
import { markdownText } from './markdown-writer.ts';

vi.mock('@docedit/model', async (original) => {
  const model = await original<typeof Model>();
  return {
    ...model,
    computeLabels: (...args: Parameters<typeof model.computeLabels>) => {
      const labels = model.computeLabels(...args);
      let n = 0;
      const lists = new Map(
        [...labels.lists].map(([id, label]) => [id, { ...label, text: `ZQ${++n}Z` }]),
      );
      return { ...labels, lists };
    },
  };
});

const level = (format: string, text: string, start: number) => ({
  format,
  text,
  start,
  indentLeft: 720,
  hanging: 360,
});

const item = (id: string, text: string, lvl: number) => ({
  type: 'paragraph',
  attrs: { id, numbering: { numberingId: 'roman', level: lvl, listId: 'listAxxxxxxxxxxx' } },
  content: [{ type: 'text', text }],
});

const IDS = {
  pHeadxxxxxxxxxxx: 'ZQ1Z',
  pOnexxxxxxxxxxxx: 'ZQ2Z',
  pTwoxxxxxxxxxxxx: 'ZQ3Z',
  pTwoAxxxxxxxxxxx: 'ZQ4Z',
  pThreexxxxxxxxxx: 'ZQ5Z',
} as const;
const REAL = ['(iv)', '(v)', '(v.a)', '(vi)', 'Part IV'];

const envelope = () =>
  doc(
    [
      {
        type: 'paragraph',
        attrs: { id: 'pHeadxxxxxxxxxxx', style: 'Heading1' },
        content: [{ type: 'text', text: 'Heading' }],
      },
      item('pOnexxxxxxxxxxxx', 'One', 0),
      item('pTwoxxxxxxxxxxxx', 'Two', 0),
      item('pTwoAxxxxxxxxxxx', 'Two a', 1),
      {
        type: 'table',
        attrs: { id: 'tablexxxxxxxxxxx', grid: [9000] },
        content: [
          {
            type: 'table_row',
            attrs: { id: 'rowxxxxxxxxxxxxx' },
            content: [
              {
                type: 'table_cell',
                attrs: { id: 'cellxxxxxxxxxxxx' },
                content: [item('pThreexxxxxxxxxx', 'Three', 0)],
              },
            ],
          },
        ],
      },
    ],
    {
      styles: [
        {
          type: 'style_def',
          attrs: {
            id: 'Heading1',
            kind: 'paragraph',
            name: 'Heading 1',
            builtIn: true,
            basedOn: 'Normal',
            outlineLevel: 1,
            numbering: { numberingId: 'parts', level: 0, listId: 'listBxxxxxxxxxxx' },
          },
        },
      ],
      numberings: [
        {
          type: 'numbering_def',
          attrs: {
            id: 'roman',
            levels: [level('lowerRoman', '(%1)', 4), level('lowerLetter', '(%1.%2)', 1)],
          },
        },
        {
          type: 'numbering_def',
          attrs: { id: 'parts', levels: [level('upperRoman', 'Part %1', 4)] },
        },
      ],
    },
  );

describe('the writers print the labels of computeLabels and count none themselves (CDM-042)', () => {
  it('LaTeX: every numbered paragraph carries its marked label as literal text', async () => {
    const b = await run(envelope());
    for (const [id, label] of Object.entries(IDS))
      expect(decodeStrings(blockLines(b, id).join('\n')), id).toContain(label);
    const main = decodeStrings(b.files['main.tex']!);
    for (const real of REAL) expect(main).not.toContain(real);
    // No counter of TeX numbers the items: the class is given the label, never asked for one.
    expect(main).not.toMatch(/\\(arabic|roman|Roman|alph|Alph|stepcounter|refstepcounter)\b/);
  });

  it('HTML: every numbered paragraph carries its marked label', () => {
    const html = htmlText(envelope()).text;
    for (const label of Object.values(IDS)) expect(html).toContain(label);
    for (const real of REAL) expect(html).not.toContain(real);
  });

  it('Markdown: every numbered paragraph outside a table carries its marked label', () => {
    const md = markdownText(envelope()).text;
    for (const label of ['ZQ1Z', 'ZQ2Z', 'ZQ3Z', 'ZQ4Z']) expect(md).toContain(label);
    for (const real of REAL) expect(md).not.toContain(real);
  });
});
