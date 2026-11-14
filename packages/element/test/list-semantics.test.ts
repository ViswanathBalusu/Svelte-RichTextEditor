// ARIA list semantics of numbered and bulleted paragraphs (FE-105, criteria 1 and 2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type ListParagraph, listSemantics } from '../src/list-semantics.ts';

const para = (listId: string, level = 0): ListParagraph => ({ listId, level });

describe('listSemantics', () => {
  it('gives three consecutive paragraphs of one list their position and the list size (criterion 1)', () => {
    const out = listSemantics([para('L1'), para('L1'), para('L1')]);
    expect(out).toEqual([
      { role: 'listitem', 'aria-level': 1, 'aria-posinset': 1, 'aria-setsize': 3 },
      { role: 'listitem', 'aria-level': 1, 'aria-posinset': 2, 'aria-setsize': 3 },
      { role: 'listitem', 'aria-level': 1, 'aria-posinset': 3, 'aria-setsize': 3 },
    ]);
  });

  it('announces the nesting level of a paragraph at a nested level (criterion 2)', () => {
    const out = listSemantics([para('L1', 0), para('L1', 1), para('L1', 2), para('L1', 0)]);
    expect(out[1]?.['aria-level']).toBe(2);
    expect(out[2]?.['aria-level']).toBe(3);
    expect(out[0]?.['aria-level']).toBe(1);
  });

  it('counts siblings inside a parent segment, so a sub-list does not change the top-level count', () => {
    // Top-level items 1 and 2 with a sub-list under item 1.
    const out = listSemantics([para('L', 0), para('L', 1), para('L', 1), para('L', 0)]);
    expect(out[0]).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 2 });
    expect(out[3]).toMatchObject({ 'aria-posinset': 2, 'aria-setsize': 2 });
    expect(out[1]).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 2 });
    expect(out[2]).toMatchObject({ 'aria-posinset': 2, 'aria-setsize': 2 });
  });

  it('breaks a run at a paragraph of another list or without a list', () => {
    const out = listSemantics([para('A'), para('B'), para(''), para('A')]);
    expect(out[0]).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 1 });
    expect(out[1]).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 1 });
    expect(out[2]).toBeNull();
    expect(out[3]).toMatchObject({ 'aria-posinset': 1, 'aria-setsize': 1 });
  });

  it('property: each listitem has a level and a position inside its size', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            listId: fc.constantFrom('A', 'B', ''),
            level: fc.integer({ min: 0, max: 8 }),
          }),
          { maxLength: 40 },
        ),
        (paragraphs) => {
          const out = listSemantics(paragraphs);
          expect(out).toHaveLength(paragraphs.length);
          for (let i = 0; i < paragraphs.length; i += 1) {
            const p = paragraphs[i];
            const s = out[i];
            if (!p || p.listId === '') {
              expect(s).toBeNull();
              continue;
            }
            expect(s).not.toBeNull();
            if (!s) continue;
            expect(s['aria-level']).toBe(p.level + 1);
            expect(s['aria-posinset']).toBeGreaterThanOrEqual(1);
            expect(s['aria-posinset']).toBeLessThanOrEqual(s['aria-setsize']);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
