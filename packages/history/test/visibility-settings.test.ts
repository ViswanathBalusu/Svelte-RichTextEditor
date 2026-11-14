// The history visibility settings at the gate (08 §9; 07 §8; HIS-025; ADR 0034, proposed). The
// gate is `minVisibleSeq` in the authority: these tests check the default setting and what each
// setting shows to a person with or without `edit` somewhere in the document. The setting's
// change (audit, right) and its precedence per tenant and document are HIS-023 and the service's.
// `since_access` with its `access_since` claim is left open here: see the story's Notes.
import {
  DEFAULT_HISTORY_VISIBILITY,
  HISTORY_VISIBILITIES,
  minVisibleSeq,
  rangeVisible,
  stateVisible,
} from '@docedit/authority';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const HEAD = 4;
/** Server times of commits 1 to 4, non-decreasing. */
const TIMES = [1_000, 2_000, 3_000, 4_000];
const timeOf = (seq: number): number | undefined => TIMES[seq - 1];

describe('the history visibility setting (HIS-025)', () => {
  it('has three settings, and no explicit setting means editors (criterion 1)', () => {
    expect(HISTORY_VISIBILITIES).toEqual(['editors', 'all', 'since_access']);
    expect(DEFAULT_HISTORY_VISIBILITY).toBe('editors');
  });

  it('under editors, a person with edit somewhere sees full history (criterion 2, editor part)', () => {
    expect(minVisibleSeq({ setting: 'editors', editsSomewhere: true, head: HEAD, timeOf })).toBe(0);
  });

  it('under editors, a person without edit sees the head and named versions only (criterion 2, reader part)', () => {
    const min = minVisibleSeq({ setting: 'editors', editsSomewhere: false, head: HEAD, timeOf });
    expect(min).toBe(HEAD);
    const named = (seq: number): boolean => seq === 2;
    // The head is visible, a named version is visible, and an unnamed earlier state is not.
    expect(stateVisible(min, HEAD, HEAD, named)).toBe(true);
    expect(stateVisible(min, 2, HEAD, named)).toBe(true);
    expect(stateVisible(min, 1, HEAD, named)).toBe(false);
    expect(stateVisible(min, 3, HEAD, named)).toBe(false);
    // The commits after the head are not sent to them from below the gate.
    expect(rangeVisible(min, 1)).toBe(false);
    expect(rangeVisible(min, HEAD)).toBe(true);
  });

  it('under all, a person with view sees full history whatever their edit rights (criterion 3, property)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 0, max: 50 }), (editsSomewhere, extra) => {
        const head = HEAD + extra;
        const min = minVisibleSeq({
          setting: 'all',
          editsSomewhere,
          head,
          timeOf: (seq) => 1_000 * seq,
        });
        expect(min).toBe(0);
        expect(rangeVisible(min, 1)).toBe(true);
      }),
    );
  });

  it('under editors, the gate is the head for every reader and 0 for every editor (property)', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.integer({ min: 0, max: 200 }), (editsSomewhere, head) => {
        const min = minVisibleSeq({ setting: 'editors', editsSomewhere, head, timeOf: () => 0 });
        expect(min).toBe(editsSomewhere ? 0 : head);
      }),
    );
  });
});
