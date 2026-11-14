/**
 * Actions on a proofing finding (UX-042, rule level). These tests cover criteria 1 (the offered
 * set), 2 (the mode of an apply, and no apply where the author may not change text) and 3 (no
 * dictionary action without a port that supports it). The menu, the keyboard command and the edit
 * through the core's guards are not built, so no criterion of UX-042 is ticked on this alone.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Capability, EditorMode } from '../src/core-api.ts';
import {
  applyMode,
  offeredFindingActions,
  type FindingActionContext,
} from '../src/proofing/finding-actions.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];

const contextArb: fc.Arbitrary<FindingActionContext> = fc.record({
  caps: fc.uniqueArray(fc.constantFrom(...CAPS), { maxLength: 7 }),
  mode: fc.constantFrom<EditorMode>('edit', 'review', 'view', 'fill'),
  hasSuggestion: fc.boolean(),
  dictionaries: fc.boolean(),
});

const writingMode = (mode: EditorMode): boolean => mode === 'edit' || mode === 'review';

describe('finding actions (UX-042, rule level)', () => {
  it('offers the four actions to an editor with a suggestion and a port with dictionaries (criterion 1)', () => {
    const offered = offeredFindingActions({
      caps: ['view', 'edit'],
      mode: 'edit',
      hasSuggestion: true,
      dictionaries: true,
    });
    expect(offered.map((a) => a.action)).toEqual([
      'apply',
      'ignore-once',
      'ignore-everywhere',
      'add-to-dictionary',
    ]);
    expect(offered[0]).toEqual({ action: 'apply', mode: 'edit' });
  });

  it('turns an apply into a suggestion in suggestion mode (review), even for an editor (criterion 2)', () => {
    expect(
      applyMode({
        caps: ['view', 'edit'],
        mode: 'review',
        hasSuggestion: true,
        dictionaries: false,
      }),
    ).toBe('suggest');
  });

  it('turns an apply into a suggestion for a user who may only suggest (criterion 2, P4)', () => {
    expect(
      applyMode({
        caps: ['view', 'suggest'],
        mode: 'edit',
        hasSuggestion: true,
        dictionaries: false,
      }),
    ).toBe('suggest');
  });

  it('offers no apply in view or fill mode, even to an editor (criterion 2)', () => {
    for (const mode of ['view', 'fill'] as const) {
      expect(
        applyMode({ caps: ['view', 'edit'], mode, hasSuggestion: true, dictionaries: false }),
      ).toBeNull();
    }
  });

  it('offers no apply without a suggestion', () => {
    expect(
      offeredFindingActions({
        caps: ['view', 'edit'],
        mode: 'edit',
        hasSuggestion: false,
        dictionaries: false,
      }).map((a) => a.action),
    ).toEqual(['ignore-once', 'ignore-everywhere']);
  });

  it('offers apply exactly where a viewer may change text in a writing mode, and always the ignore actions (property, criterion 2)', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const viewer = context.caps.includes('view');
        const changeable = context.caps.includes('edit') || context.caps.includes('suggest');
        const actions = offeredFindingActions(context).map((a) => a.action);
        expect(actions.includes('apply')).toBe(
          viewer && changeable && writingMode(context.mode) && context.hasSuggestion,
        );
        expect(actions.includes('ignore-once')).toBe(viewer);
        expect(actions.includes('ignore-everywhere')).toBe(viewer);
      }),
    );
  });

  it('writes an apply as an edit only for an editor in edit mode (property, criterion 2)', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const mode = applyMode(context);
        if (mode === 'edit') {
          expect(context.mode).toBe('edit');
          expect(context.caps).toContain('edit');
        }
        if (context.mode === 'review') expect(mode).not.toBe('edit');
      }),
    );
  });

  it('offers the dictionary action exactly when the port supports dictionaries and the author may view (property, criterion 3)', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const actions = offeredFindingActions(context).map((a) => a.action);
        expect(actions.includes('add-to-dictionary')).toBe(
          context.dictionaries && context.caps.includes('view'),
        );
      }),
    );
  });

  it('offers nothing to an author who cannot view the finding (property)', () => {
    fc.assert(
      fc.property(contextArb, (context) => {
        const noView = { ...context, caps: context.caps.filter((c) => c !== 'view') };
        expect(offeredFindingActions(noView)).toEqual([]);
      }),
    );
  });
});
