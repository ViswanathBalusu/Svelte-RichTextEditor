/**
 * Page-break reconciliation (FE-100 criteria 1, 2, 3, 4): which typeset starts may be adopted, the
 * granularity rule, and the overflow rule with its tolerance. The tolerance has no value in the spec,
 * so these tests pass their own; they do not show what the tenant's value should be.
 */
import { describe, expect, it } from 'vitest';
import { validateLayoutJson, type LayoutJson } from './layout-json.ts';
import {
  adoptablePins,
  effectiveGranularity,
  estimatedPages,
  judgePins,
  keptPins,
  type PagePin,
} from './reconcile.ts';

function layoutOf(granularity: 'block' | 'line'): LayoutJson {
  const check = validateLayoutJson({
    seq: 416,
    classVersion: '1.3.0',
    granularity,
    pages: [
      { n: 1, setup: 'ps1', starts: { blockId: 'A', offset: 0 }, opensWith: 'text' },
      { n: 2, setup: 'ps1', starts: { blockId: 'B', offset: 40 }, opensWith: 'text' },
      { n: 3, setup: 'ps1', starts: { blockId: 'C', offset: 0 }, opensWith: 'float' },
    ],
    blocks: {
      A: { lineStarts: [0, 30, 60] },
      B: { lineStarts: [40, 70] },
      C: { lineStarts: [0] },
    },
  });
  if (!check.ok) throw new Error(check.problems.join('; '));
  return check.layout;
}

describe('effectiveGranularity (FE-100 criterion 4)', () => {
  it('uses line granularity only when the request and the file both say line', () => {
    expect(effectiveGranularity('line', 'line')).toBe('line');
    expect(effectiveGranularity('line', 'block')).toBe('block');
    expect(effectiveGranularity('block', 'line')).toBe('block');
    expect(effectiveGranularity('block', 'block')).toBe('block');
  });
});

describe('adoptablePins (FE-100 criteria 1, 4)', () => {
  it('adopts the page starts of blocks not edited since seq, and keeps the editor break for the rest', () => {
    const pins = adoptablePins(layoutOf('block'), new Set(['B']), 'block');
    expect(pins.pages).toEqual([
      { page: 1, blockId: 'A', offset: 0 },
      { page: 3, blockId: 'C', offset: 0 },
    ]);
    expect(pins.keptOwnPages).toEqual([2]);
  });

  it('gives no line starts at block granularity, even when the file reports them', () => {
    const pins = adoptablePins(layoutOf('line'), new Set(), 'block');
    expect(pins.granularity).toBe('block');
    expect(pins.lines).toEqual([]);
    expect(pins.pages).toEqual([
      { page: 1, blockId: 'A', offset: 0 },
      { page: 3, blockId: 'C', offset: 0 },
    ]);
  });

  it('at block granularity adopts only block-level starts, and keeps the break of a start inside a block', () => {
    // Page 2 starts at offset 40 of B, which is not a block-level start (FE-100 criterion 4).
    const pins = adoptablePins(layoutOf('block'), new Set(), 'block');
    expect(pins.pages.map((p) => p.page)).toEqual([1, 3]);
    expect(pins.keptOwnPages).toEqual([2]);
  });

  it('adds the line starts of unedited blocks at line granularity, and not those of edited blocks', () => {
    const pins = adoptablePins(layoutOf('line'), new Set(['A']), 'line');
    expect(pins.granularity).toBe('line');
    expect(pins.lines).toEqual([
      { blockId: 'B', offset: 40 },
      { blockId: 'B', offset: 70 },
      { blockId: 'C', offset: 0 },
    ]);
    expect(pins.keptOwnPages).toEqual([1]);
  });

  it('uses block starts only when the file reports block granularity, whatever the request', () => {
    const pins = adoptablePins(layoutOf('block'), new Set(), 'line');
    expect(pins.granularity).toBe('block');
    expect(pins.lines).toEqual([]);
  });

  it('adopts nothing when every start block is edited', () => {
    const pins = adoptablePins(layoutOf('line'), new Set(['A', 'B', 'C']), 'line');
    expect(pins.pages).toEqual([]);
    expect(pins.lines).toEqual([]);
    expect(pins.keptOwnPages).toEqual([1, 2, 3]);
  });
});

describe('judgePins (FE-100 criteria 2, 3)', () => {
  const pins: PagePin[] = [
    { page: 1, blockId: 'A', offset: 0 },
    { page: 2, blockId: 'B', offset: 40 },
    { page: 3, blockId: 'C', offset: 0 },
    { page: 4, blockId: 'D', offset: 0 },
  ];

  it('keeps a pin whose content fits, and a pin whose page overflows within the tolerance', () => {
    const judged = judgePins(pins, [0, 4, 0, 0], 6);
    expect(judged.map((j) => j.decision)).toEqual(['fits', 'overflows', 'fits', 'fits']);
    expect(keptPins(judged)).toEqual(pins);
    expect(estimatedPages(judged)).toEqual([]);
  });

  it('allows an overflow equal to the tolerance and drops one just above it', () => {
    const equal = judgePins(pins.slice(0, 1), [6], 6);
    expect(equal[0]?.decision).toBe('overflows');
    const above = judgePins(pins.slice(0, 1), [6.5], 6);
    expect(above[0]?.decision).toBe('dropped');
  });

  it('drops a pin beyond the tolerance and marks its page as estimated', () => {
    const judged = judgePins(pins, [0, 20, 0, 9], 6);
    expect(judged.map((j) => j.decision)).toEqual(['fits', 'dropped', 'fits', 'dropped']);
    expect(keptPins(judged)).toEqual([pins[0], pins[2]]);
    expect(estimatedPages(judged)).toEqual([2, 4]);
    expect(judged[1]?.estimated).toBe(true);
    expect(judged[0]?.estimated).toBe(false);
  });

  it('refuses an overflow list that does not match the pins', () => {
    expect(() => judgePins(pins, [0, 0], 6)).toThrow(RangeError);
  });

  it('refuses a tolerance that is negative, NaN or infinite, since the spec gives none', () => {
    expect(() => judgePins(pins, [0, 0, 0, 0], -1)).toThrow(RangeError);
    expect(() => judgePins(pins, [0, 0, 0, 0], Number.NaN)).toThrow(RangeError);
    expect(() => judgePins(pins, [0, 0, 0, 0], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('refuses an overflow that is negative or not finite', () => {
    expect(() => judgePins(pins.slice(0, 1), [-1], 6)).toThrow(RangeError);
    expect(() => judgePins(pins.slice(0, 1), [Number.NaN], 6)).toThrow(RangeError);
  });

  it('returns frozen judgements', () => {
    const judged = judgePins(pins, [0, 0, 0, 0], 6);
    expect(Object.isFrozen(judged)).toBe(true);
    expect(Object.isFrozen(judged[0])).toBe(true);
  });
});
