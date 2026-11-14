// pageGuideBlockIds (FE-068, criterion 2 in part): guides go before block starts only, never inside
// a paragraph, and nothing is drawn while guides are off. Drawing them is not built here.
import { describe, expect, it } from 'vitest';
import { pageGuideBlockIds, type LayoutReport } from '../src/page-guides.ts';

const layout: LayoutReport = {
  seq: 12,
  starts: [
    { blockId: 'p-1', offset: 0 },
    { blockId: 'p-4', offset: 37 },
    { blockId: 'p-9', offset: 0 },
    { blockId: 'p-9', offset: 0 },
  ],
};

describe('pageGuideBlockIds (FE-068)', () => {
  it('draws nothing while guides are off, which is the default', () => {
    expect(pageGuideBlockIds(layout, false)).toEqual([]);
  });

  it('draws nothing when no layout is known', () => {
    expect(pageGuideBlockIds(null, true)).toEqual([]);
  });

  it('places a guide before each block where a page starts, in document order, once per block', () => {
    expect(pageGuideBlockIds(layout, true)).toEqual(['p-1', 'p-9']);
  });

  it('never places a guide inside a paragraph (offset above 0)', () => {
    const inside: LayoutReport = { seq: 1, starts: [{ blockId: 'p-4', offset: 37 }] };
    expect(pageGuideBlockIds(inside, true)).toEqual([]);
  });
});
