/**
 * FE-101 criterion 5: a form field is a box of exactly its width on its line (FRW-080). The page view
 * gives the painter a run for it, so the painter leaves the room and places the field's control on
 * it (FE-093), and the widths the caret and the selection use include the box.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike } from '../../layout/src/flow.ts';
import { fixedWidthMeasurer } from '../../layout/src/measure.ts';
import { FlowText } from '../src/page-view/flow-text.ts';

const envelope: CdmEnvelopeLike = {
  doc: {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          {
            type: 'settings',
            attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
          },
          {
            type: 'style_def',
            attrs: {
              id: 'Normal',
              kind: 'paragraph',
              name: 'Normal',
              builtIn: true,
              fontFamily: 'Noto Serif',
              fontSize: 220,
            },
          },
          {
            type: 'page_setup',
            attrs: {
              id: 'ps1',
              width: 11906,
              height: 16838,
              marginTop: 1440,
              marginRight: 1440,
              marginBottom: 1440,
              marginLeft: 1440,
            },
          },
        ],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'p1', style: 'Normal' },
            content: [
              { type: 'text', text: 'Name: ' },
              {
                type: 'form_field',
                attrs: { id: 'f1', key: 'name', kind: 'text', width: 2000, value: null },
              },
              { type: 'text', text: ' end' },
            ],
          },
        ],
      },
    ],
  },
};

describe('a form field in the runs of a line (FE-101 criterion 5)', () => {
  const measurer = fixedWidthMeasurer();
  const flow = toFlow(envelope);
  const text = new FlowText(flow, measurer);

  it('is a run with no text, with the field and the box the layout set (2000 twips is 100 pt)', () => {
    const runs = text.runs('p1', 0, 12)!;
    const box = runs.filter((r) => r.box);
    expect(box).toHaveLength(1);
    expect(box[0]!.text).toBe('');
    expect(box[0]!.box).toMatchObject({ id: 'f1', kind: 'text', offset: 6, widthPt: 100 });
    // The text around it is as it was, in order, with the box between.
    expect(runs.map((r) => (r.box ? '[f1]' : r.text)).join('')).toBe('Name: [f1] end');
  });

  it('is left out of a range that stops before it or starts after it', () => {
    expect(text.runs('p1', 0, 6)!.some((r) => r.box)).toBe(false);
    expect(text.runs('p1', 7, 12)!.some((r) => r.box)).toBe(false);
  });

  it('adds its width to the width of a range, so the caret after it is past the room', () => {
    const before = text.width('p1', 0, 6);
    const after = text.width('p1', 0, 7);
    expect(after - before).toBeCloseTo(100, 6);
    expect(text.width('p1', 6, 7)).toBeCloseTo(100, 6);
  });

  it('lists the fields the layout left room for', () => {
    expect([...text.fieldIds()]).toEqual(['f1']);
  });
});
