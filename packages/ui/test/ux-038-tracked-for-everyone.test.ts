/**
 * "Tracked changes for everyone" rules (UX-038 criteria 2 and 3; 13 §5; 07 §5.2). Rule level only.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability, EditorMode } from '../src/core-api.ts';
import {
  TRACKED_REASON,
  trackedControlOffered,
  trackedModeFor,
} from '../src/shell/tracked-for-everyone.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];
const MODES: readonly EditorMode[] = ['edit', 'review', 'view', 'fill'];

describe('the setting is offered only with manage (UX-038 criterion 2)', () => {
  it('is not offered to an editor, a suggester or a viewer', () => {
    expect(trackedControlOffered(['view', 'suggest', 'edit'])).toBe(false);
    expect(trackedControlOffered(['view', 'comment'])).toBe(false);
  });

  it('is offered to a user who holds manage (property over capability sets)', () => {
    fc.assert(
      fc.property(fc.subarray([...CAPS]), (caps) => {
        expect(trackedControlOffered(caps)).toBe(caps.includes('manage'));
      }),
    );
  });
});

describe('with the setting on, editors edit as suggestions (UX-038 criterion 1, the rule)', () => {
  it('turns a chosen edit into review and names the reason', () => {
    expect(trackedModeFor('edit', true)).toEqual({ mode: 'review', reason: TRACKED_REASON });
  });

  it('leaves the other modes as chosen (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...MODES.filter((m) => m !== 'edit')), (chosen) => {
        expect(trackedModeFor(chosen, true)).toEqual({ mode: chosen, reason: null });
      }),
    );
  });
});

describe('when the owner turns the setting off, editors edit directly again (UX-038 criterion 3)', () => {
  it('returns a chosen edit to edit as soon as the setting is off, with no reason', () => {
    expect(trackedModeFor('edit', true).mode).toBe('review');
    expect(trackedModeFor('edit', false)).toEqual({ mode: 'edit', reason: null });
  });

  it('gives edit exactly when the setting is off, whatever the earlier toggles were (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...MODES),
        fc.array(fc.boolean(), { maxLength: 12 }),
        (chosen, toggles) => {
          // The mode depends on the current setting only: the toggles before it leave no trace.
          const last = toggles.length === 0 ? false : toggles[toggles.length - 1]!;
          const got = trackedModeFor(chosen, last);
          if (last) {
            expect(got.mode).toBe(chosen === 'edit' ? 'review' : chosen);
          } else {
            expect(got).toEqual({ mode: chosen, reason: null });
          }
        },
      ),
    );
  });
});
