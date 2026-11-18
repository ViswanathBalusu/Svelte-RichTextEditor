/**
 * UX-020 criterion 2, the pane's half: where the author's place goes when the outline changes.
 * The place is kept by identifier; a removed heading hands it to the nearest one before it that is
 * still listed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { placeAfter } from '../src/shell/outline.ts';

describe('placeAfter (UX-020 criterion 2)', () => {
  it('keeps the heading while it is listed, whatever is added or removed around it', () => {
    expect(placeAfter(['a', 'b', 'c'], 'b', ['x', 'a', 'b', 'y', 'c'])).toBe('b');
    expect(placeAfter(['a', 'b', 'c'], 'b', ['b'])).toBe('b');
  });

  it('moves to the nearest earlier heading that is still listed when the place is removed', () => {
    expect(placeAfter(['a', 'b', 'c', 'd'], 'c', ['a', 'd'])).toBe('a');
    expect(placeAfter(['a', 'b', 'c', 'd'], 'c', ['a', 'b', 'd'])).toBe('b');
  });

  it('goes to the first heading when nothing before the place is left, and to none for no headings', () => {
    expect(placeAfter(['a', 'b', 'c'], 'a', ['b', 'c'])).toBe('b');
    expect(placeAfter(['a', 'b'], 'b', ['x', 'y'])).toBe('x');
    expect(placeAfter(['a', 'b'], 'b', [])).toBeNull();
  });

  it('has no place before the author chose one', () => {
    expect(placeAfter([], null, ['a'])).toBeNull();
  });

  it('always names a heading that is listed, or none, and never moves a place that is listed', () => {
    const ids = fc.uniqueArray(
      fc.integer({ min: 0, max: 30 }).map((n) => `h${n}`),
      {
        maxLength: 20,
      },
    );
    fc.assert(
      fc.property(ids, ids, fc.nat(30), (before, after, pick) => {
        const place = before.length ? before[pick % before.length]! : null;
        const next = placeAfter(before, place, after);
        if (after.length === 0) expect(next).toBeNull();
        else if (place === null) expect(next).toBeNull();
        else expect(after).toContain(next);
        if (place !== null && after.includes(place)) expect(next).toBe(place);
      }),
    );
  });
});
