// Read markers only move forward (08 §10; HIS-027 criterion 2): a lower or equal seq sent later
// leaves the marker where it is, and a seq above the head is refused.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { advanceMarker } from '../src/markers.ts';

describe('read markers move forward only (HIS-027 criterion 2)', () => {
  it('records a first marker and moves it up', () => {
    expect(advanceMarker(undefined, 4, 9)).toEqual({ ok: true, marker: 4, moved: true });
    expect(advanceMarker(4, 9, 9)).toEqual({ ok: true, marker: 9, moved: true });
  });

  it('does not move the marker for a lower or equal seq', () => {
    expect(advanceMarker(6, 6, 9)).toEqual({ ok: true, marker: 6, moved: false });
    expect(advanceMarker(6, 2, 9)).toEqual({ ok: true, marker: 6, moved: false });
  });

  it('refuses a seq that is not a sequence number or is above the head', () => {
    expect(advanceMarker(3, 10, 9)).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(advanceMarker(3, -1, 9)).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(advanceMarker(3, 1.5, 9)).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('never moves backwards over any sequence of requests (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 60 }), (requests) => {
        let stored: number | undefined;
        for (const r of requests) {
          const before = stored;
          const out = advanceMarker(stored, r, 50);
          if (!out.ok) throw new Error('a request within the head is refused');
          stored = out.marker;
          if (before !== undefined) expect(out.marker).toBeGreaterThanOrEqual(before);
          expect(out.moved).toBe(before === undefined || r > before);
        }
      }),
    );
  });
});
