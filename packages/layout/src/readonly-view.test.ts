/**
 * The read-only pages' page count and whether it is final (FE-095 criterion 3). The status is built
 * from a layout result, so these tests build the result directly: the engine's own tests cover how
 * it is produced.
 */
import { describe, expect, it } from 'vitest';
import type { LayoutResult } from './engine.ts';
import { pageStatus } from './readonly-view.ts';
import type { LayoutTree } from './tree.ts';

function resultOf(
  pages: number,
  options: { settled?: boolean; unplaced?: string[] } = {},
): LayoutResult {
  const tree: LayoutTree = {
    engine: 'test',
    measurer: 'test',
    pages: Array.from({ length: pages }, (_, index) => ({
      index,
      section: 0,
      width: 612,
      height: 792,
      fragments: [],
      header: [],
      footer: [],
      footnotes: [],
    })),
  };
  return {
    tree,
    unplaced: options.unplaced ?? [],
    overflowed: [],
    pageCountSettled: options.settled ?? true,
  };
}

describe('pageStatus (FE-095 criterion 3)', () => {
  it('reports the page count as final when the passes settled and every block is placed', () => {
    const status = pageStatus(resultOf(3));
    expect(status).toEqual({ pages: 3, final: true, reasons: [] });
  });

  it('reports a count that has not settled as provisional, and says why', () => {
    const status = pageStatus(resultOf(4, { settled: false }));
    expect(status.pages).toBe(4);
    expect(status.final).toBe(false);
    expect(status.reasons).toEqual(['the page passes did not settle, so the count may change']);
  });

  it('reports a count with an unplaced table as provisional, in the singular and the plural', () => {
    const one = pageStatus(resultOf(2, { unplaced: ['t1'] }));
    expect(one.final).toBe(false);
    expect(one.reasons).toEqual(['1 block is not placed yet (tables, FE-083)']);
    const two = pageStatus(resultOf(2, { unplaced: ['t1', 't2'] }));
    expect(two.reasons).toEqual(['2 blocks are not placed yet (tables, FE-083)']);
  });

  it('lists every reason when more than one holds', () => {
    const status = pageStatus(resultOf(1, { settled: false, unplaced: ['t1'] }));
    expect(status.final).toBe(false);
    expect(status.reasons.length).toBe(2);
  });

  it('returns a frozen status', () => {
    const status = pageStatus(resultOf(1));
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.reasons)).toBe(true);
  });
});
