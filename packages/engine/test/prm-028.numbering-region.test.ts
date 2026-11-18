/**
 * PRM-028 criterion 6 at the engine (lane w9): making a region around the middle of a numbered list
 * does not change the numbers, because they are computed (`computeLabels`, 03 §7) and a region is
 * transparent to them; the web view's list positions follow the same labels
 * (`fe-105-continuation.test.ts`, FE-105 criterion 4) and the layout prints them
 * (`packages/layout/src/prm-028-numbering-region.test.ts`).
 */
import { computeLabels } from '@docedit/model';
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { ownerAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const LIST = 'lList000000000001';
const numbered = (id: string) => ({
  type: 'paragraph',
  attrs: { id, style: null, numbering: { numberingId: 'num1', level: 0, listId: LIST } },
  content: [{ type: 'text', text: `Item ${id}` }],
});

function document(): CdmEnvelope {
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
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            numbered('pOne0000000001'),
            numbered('pTwo0000000001'),
            numbered('pThree00000001'),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

function labelsOf(doc: PMNode): Record<string, string | undefined> {
  const computed = computeLabels(doc as never);
  const out: Record<string, string | undefined> = {};
  doc.descendants((n) => {
    if (n.type.name === 'paragraph')
      out[String(n.attrs['id'])] = computed.lists.get(String(n.attrs['id']))?.text;
    return true;
  });
  return out;
}

describe('a region made inside a numbered list keeps the numbers (PRM-028 criterion 6)', () => {
  it('marks the middle item as a region: the three labels stay 1., 2. and 3.', () => {
    const c = new DocumentCore({ doc: document(), access: ownerAccess(), schedule: microtask });
    const i = internals(c);
    expect(labelsOf(i.state.doc)).toEqual({
      pOne0000000001: '1.',
      pTwo0000000001: '2.',
      pThree00000001: '3.',
    });

    const from = posOf(i.state.doc, 'pTwo0000000001') + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, from, from + 2)));
    expect(c.run('markRegion', { title: 'Middle' })).toBe(true);

    let regions = 0;
    internals(c).state.doc.descendants((n) => {
      if (n.type.name === 'region') regions += 1;
      return true;
    });
    expect(regions).toBe(1);
    expect(labelsOf(internals(c).state.doc)).toEqual({
      pOne0000000001: '1.',
      pTwo0000000001: '2.',
      pThree00000001: '3.',
    });
  });
});
