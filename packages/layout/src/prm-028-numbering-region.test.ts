/**
 * PRM-028 criterion 6 in the layout: a numbered list that continues before and after a region
 * prints its labels in one run, because the labels are computed (`computeLabels`, 03 §7) and a
 * region is transparent to them. The same document without the region prints the same labels.
 */
import { describe, expect, it } from 'vitest';
import {
  flowParagraphs,
  toFlow,
  type CdmEnvelopeLike,
  type FlowParagraph,
  type FlowText,
} from './flow.ts';

const LIST = 'lList000000000001';

const numbered = (id: string) => ({
  type: 'paragraph',
  attrs: { id, style: null, numbering: { numberingId: 'num1', level: 0, listId: LIST } },
  content: [{ type: 'text', text: `Item ${id}` }],
});

function envelope(body: unknown[]): CdmEnvelopeLike {
  const level = { format: 'decimal', text: '%1.', start: 1 };
  return {
    cdm: 1,
    requires: [],
    doc: {
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
            { type: 'numbering_def', attrs: { id: 'num1', levels: Array(9).fill(level) } },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  } as unknown as CdmEnvelopeLike;
}

function labels(env: CdmEnvelopeLike): Array<[string, string | undefined]> {
  const paragraphs: FlowParagraph[] = toFlow(env).sections.flatMap((s) => [
    ...flowParagraphs(s.blocks),
  ]);
  return paragraphs.map((p) => [
    p.id,
    p.inlines.find((i): i is FlowText => i.kind === 'text' && i.role === 'label')?.text,
  ]);
}

describe('a list across a region boundary prints one run of labels (PRM-028 criterion 6)', () => {
  const region = (content: unknown[]) => ({
    type: 'region',
    attrs: { id: 'rRegion000000001', title: 'Middle', policy: 'restricted' },
    content,
  });

  it('numbers the items before, inside and after the region 1 to 4', () => {
    const env = envelope([
      numbered('p1'),
      region([numbered('p2'), numbered('p3')]),
      numbered('p4'),
    ]);
    expect(labels(env)).toEqual([
      ['p1', '1.'],
      ['p2', '2.'],
      ['p3', '3.'],
      ['p4', '4.'],
    ]);
  });

  it('prints the same labels without the region', () => {
    const withRegion = envelope([
      numbered('p1'),
      region([numbered('p2'), numbered('p3')]),
      numbered('p4'),
    ]);
    const without = envelope([numbered('p1'), numbered('p2'), numbered('p3'), numbered('p4')]);
    expect(labels(withRegion)).toEqual(labels(without));
  });

  it('continues across two adjacent regions and a region that is the last block', () => {
    const env = envelope([
      numbered('p1'),
      region([numbered('p2')]),
      {
        ...region([numbered('p3')]),
        attrs: { id: 'rRegion000000002', title: 'B', policy: 'inherit' },
      },
      numbered('p4'),
    ]);
    expect(labels(env).map(([, l]) => l)).toEqual(['1.', '2.', '3.', '4.']);
  });
});
