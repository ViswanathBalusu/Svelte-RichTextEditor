/**
 * CDM-042 criterion 1, layout side (Node.js): the layout computes no list label of its own. The
 * model's `computeLabels` is replaced by a version that returns marked labels (`<n>` in place of
 * each real label); every label the flow prints is then a marked one, and none of the real labels
 * (`(iv)`, `(v)`, `(v.a)`, `(vi)`, `Part IV`) appears. A second code path that counted list items
 * would print a real label.
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Model from '@docedit/model';
import { flowParagraphs, toFlow, type CdmEnvelopeLike } from './flow.ts';

vi.mock('@docedit/model', async (original) => {
  const model = await original<typeof Model>();
  return {
    ...model,
    computeLabels: (...args: Parameters<typeof model.computeLabels>) => {
      const labels = model.computeLabels(...args);
      let n = 0;
      const lists = new Map(
        [...labels.lists].map(([id, label]) => [id, { ...label, text: `<${++n}>` }]),
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

const item = (id: string, text: string, lvl: number, attrs: Record<string, unknown> = {}) => ({
  type: 'paragraph',
  attrs: {
    id,
    numbering: { numberingId: 'roman', level: lvl, listId: 'listAxxxxxxxxxxx' },
    ...attrs,
  },
  content: [{ type: 'text', text }],
});

const document: CdmEnvelopeLike = {
  doc: {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: { defaultParagraphStyle: 'Normal' } },
          { type: 'style_def', attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal' } },
          {
            type: 'style_def',
            attrs: {
              id: 'Heading1',
              kind: 'paragraph',
              name: 'Heading 1',
              basedOn: 'Normal',
              outlineLevel: 1,
              numbering: { numberingId: 'parts', level: 0, listId: 'listBxxxxxxxxxxx' },
            },
          },
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
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
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
      },
    ],
  },
} as unknown as CdmEnvelopeLike;

describe('the layout prints the labels of computeLabels and counts none itself (CDM-042)', () => {
  it('prints the marked label for every numbered paragraph, in a table cell too', () => {
    const flow = toFlow(document);
    const printed = new Map<string, string>();
    const all: string[] = [];
    for (const section of flow.sections)
      for (const p of flowParagraphs(section.blocks))
        for (const inline of p.inlines) {
          if (inline.kind !== 'text') continue;
          all.push(inline.text);
          if (inline.role === 'label') printed.set(p.id, inline.text);
        }
    expect(Object.fromEntries(printed)).toEqual({
      pHeadxxxxxxxxxxx: '<1>',
      pOnexxxxxxxxxxxx: '<2>',
      pTwoxxxxxxxxxxxx: '<3>',
      pTwoAxxxxxxxxxxx: '<4>',
      pThreexxxxxxxxxx: '<5>',
    });
    const text = all.join('\n');
    for (const real of ['(iv)', '(v)', '(v.a)', '(vi)', 'Part IV'])
      expect(text).not.toContain(real);
  });
});
