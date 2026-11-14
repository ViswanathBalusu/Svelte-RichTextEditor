/**
 * EXP-039 (the rule of splitting a row taller than a page, with the measure supplied by the test).
 * The converter has no height measure yet, so these tests use a weight per block and a page limit.
 * They show the split rule (criterion 1, the part before the converter measures) and the block
 * that is reported when it cannot fit alone (criterion 3, the block). They do not show a PDF, a
 * header repeat or a converter warning: those need the converter and a compile.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitRow } from './tables.split.ts';

interface Block {
  id: string;
  weight: number;
}

/** A part fits when the weight of its blocks, over all cells, is within the limit. */
const weightFits =
  (limit: number) =>
  (part: readonly (readonly Block[])[]): boolean =>
    part.reduce((s, cell) => s + cell.reduce((t, b) => t + b.weight, 0), 0) <= limit;

const cellsArb = fc.array(
  fc.array(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 4 }),
      weight: fc.integer({ min: 1, max: 9 }),
    }),
    {
      maxLength: 6,
    },
  ),
  { minLength: 1, maxLength: 4 },
);

/** Concatenates the parts of one cell, in order. */
function joinCell(parts: readonly (readonly (readonly Block[])[])[], c: number): Block[] {
  return parts.flatMap((p) => p[c] ?? []);
}

describe('EXP-039 criterion 1: a tall row is split at block boundaries', () => {
  it('splits a row whose blocks do not fit on one page into continuation parts', () => {
    const cells = [
      [
        { id: 'a', weight: 4 },
        { id: 'b', weight: 4 },
        { id: 'c', weight: 4 },
      ],
    ];
    const r = splitRow(cells, weightFits(8));
    expect(r.parts.length).toBe(2);
    expect(r.parts.map((p) => p[0]!.map((b) => b.id))).toEqual([['a', 'b'], ['c']]);
    expect(r.unsplittable).toEqual([]);
  });

  it('keeps the cells of a row in step: every part has one list per cell', () => {
    const cells = [
      [
        { id: 'a1', weight: 3 },
        { id: 'a2', weight: 3 },
      ],
      [{ id: 'b1', weight: 2 }],
    ];
    const r = splitRow(cells, weightFits(6));
    for (const part of r.parts) expect(part.length).toBe(2);
    expect(joinCell(r.parts, 0).map((b) => b.id)).toEqual(['a1', 'a2']);
    expect(joinCell(r.parts, 1).map((b) => b.id)).toEqual(['b1']);
  });

  it('keeps a row that fits as one part, unchanged', () => {
    const cells = [[{ id: 'a', weight: 1 }], [{ id: 'b', weight: 1 }]];
    const r = splitRow(cells, weightFits(10));
    expect(r.parts.length).toBe(1);
    expect(r.parts[0]!.map((c) => c.map((b) => b.id))).toEqual([['a'], ['b']]);
  });

  it('property: the text of each cell is the concatenation of its parts, and every part fits', () => {
    fc.assert(
      fc.property(cellsArb, fc.integer({ min: 1, max: 30 }), (cells, limit) => {
        const fits = weightFits(limit);
        const r = splitRow(cells, fits);
        for (let c = 0; c < cells.length; c++) {
          expect(joinCell(r.parts, c)).toEqual(cells[c]);
        }
        // A part that does not fit can only be the single reported block on its own.
        for (const part of r.parts) {
          if (!fits(part)) expect(part.reduce((s, cell) => s + cell.length, 0)).toBe(1);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('property: no block is cut, and the parts never hold a block twice', () => {
    fc.assert(
      fc.property(cellsArb, fc.integer({ min: 1, max: 30 }), (cells, limit) => {
        const r = splitRow(cells, weightFits(limit));
        for (let c = 0; c < cells.length; c++) {
          const ids = joinCell(r.parts, c).map((b) => b.id);
          expect(ids.length).toBe(cells[c]!.length);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('EXP-039 criterion 3: a block taller than a page is reported with its position', () => {
  it('reports a single block that does not fit alone, with its cell and index, and keeps its text', () => {
    const cells = [
      [{ id: 'small', weight: 1 }],
      [
        { id: 'huge', weight: 50 },
        { id: 'after', weight: 1 },
      ],
    ];
    const r = splitRow(cells, weightFits(10));
    expect(r.unsplittable).toEqual([{ cell: 1, index: 0 }]);
    expect(joinCell(r.parts, 1).map((b) => b.id)).toEqual(['huge', 'after']);
    expect(joinCell(r.parts, 0).map((b) => b.id)).toEqual(['small']);
  });

  it('property: a block is reported exactly when its own weight is over the limit', () => {
    fc.assert(
      fc.property(cellsArb, fc.integer({ min: 1, max: 12 }), (cells, limit) => {
        const r = splitRow(cells, weightFits(limit));
        const key = (u: { cell: number; index: number }): string => `${u.cell}:${u.index}`;
        const expected: string[] = [];
        cells.forEach((cell, c) =>
          cell.forEach((b, i) => {
            if (b.weight > limit) expected.push(key({ cell: c, index: i }));
          }),
        );
        // Every block over the limit is reported once, and nothing else is.
        expect(r.unsplittable.map(key).sort()).toEqual(expected.sort());
      }),
      { numRuns: 500 },
    );
  });
});
