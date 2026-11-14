/**
 * The mode switcher's offer (UX-015 criteria 1, 3 and 5; 07 §4, §7). The switcher lists only the
 * modes the build supports, disables the others with a reason, and never offers `edit` while the
 * document is locked, archived or in a workflow, or where the user may only suggest.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AccessObject, AccessSummary, Capability, EditorMode } from '../src/core-api.ts';
import { ALL_MODES, modeOptions, type ModeOption } from '../src/shell/modes.ts';

const CAPS: readonly Capability[] = [
  'view',
  'comment',
  'suggest',
  'edit',
  'fill',
  'structure',
  'manage',
];
const LIMITS = ['locked', 'archived', 'workflow'] as const;

function access(
  caps: readonly string[],
  scopes: Record<string, readonly string[]> = {},
): AccessObject {
  return { rev: 1, docRole: 'viewer', caps, scopes };
}

function here(caps: readonly Capability[], limit: AccessSummary['limit'] = null): AccessSummary {
  return { scope: 'body', caps, limit };
}

/** The offer when the build supports every mode, as a full core reports them. */
function offer(a: AccessObject | null | undefined, h: AccessSummary | undefined): ModeOption[] {
  return modeOptions(ALL_MODES, a, h);
}

function byMode(options: readonly ModeOption[]): Partial<Record<EditorMode, ModeOption>> {
  return Object.fromEntries(options.map((o) => [o.mode, o]));
}

describe('the mode switcher offer (UX-015, criterion 1)', () => {
  it('offers only available modes and gives a reason for each unavailable one', () => {
    const options = byMode(offer(access(['view']), here(['view'])));
    expect(options.view).toEqual({ mode: 'view', available: true, reason: null });
    expect(options.edit).toEqual({ mode: 'edit', available: false, reason: 'noEdit' });
    expect(options.review).toEqual({ mode: 'review', available: false, reason: 'noSuggest' });
    expect(options.fill).toEqual({ mode: 'fill', available: false, reason: 'noFill' });
  });

  it('lists nothing the build does not support', () => {
    const options = modeOptions(
      ['view'],
      access(['view', 'edit', 'fill']),
      here(['view', 'edit', 'fill']),
    );
    expect(options.map((o) => o.mode)).toEqual(['view']);
    // Without a list from the build, edit and view, which every core has.
    expect(modeOptions(undefined, null, undefined).map((o) => o.mode)).toEqual(['edit', 'view']);
  });

  it('offers review with suggest or edit, and fill with fill, anywhere in the document', () => {
    const suggester = byMode(offer(access(['view', 'suggest']), here(['view', 'suggest'])));
    expect(suggester.review?.available).toBe(true);
    // A region grant alone is enough: "somewhere" is the union of the document and every scope.
    const regional = byMode(
      offer(access(['view'], { 'region:r1': ['view', 'fill'] }), here(['view'])),
    );
    expect(regional.fill?.available).toBe(true);
    expect(regional.edit?.reason).toBe('noEdit');
  });

  it('keeps view available whatever the rights (property)', () => {
    fc.assert(
      fc.property(
        fc.subarray([...CAPS]),
        fc.option(fc.constantFrom('locked', 'archived', 'workflow', 'role', 'hidden'), {
          nil: null,
        }),
        (caps, limit) => {
          const options = byMode(offer(access(caps), here(caps, limit as AccessSummary['limit'])));
          expect(options.view?.available).toBe(true);
        },
      ),
    );
  });

  it('checks nothing when no access is known yet', () => {
    const unknown = byMode(offer(null, undefined));
    expect(unknown.edit?.available).toBe(true);
    expect(unknown.review?.available).toBe(true);
    expect(unknown.fill?.available).toBe(true);
  });

  it('gives every unavailable mode a reason and no reason to an available one (property)', () => {
    fc.assert(
      fc.property(
        fc.subarray([...CAPS]),
        fc.subarray([...CAPS]),
        fc.option(fc.constantFrom(...LIMITS), { nil: null }),
        (docCaps, hereCaps, limit) => {
          for (const option of offer(access(docCaps), here(hereCaps, limit))) {
            if (option.available) expect(option.reason).toBeNull();
            else expect(option.reason).not.toBeNull();
          }
        },
      ),
    );
  });
});

describe('edit and review are not offered while the document is locked, archived or in a workflow (UX-015, criterion 5)', () => {
  it('refuses edit and review with the limit as the reason, even with edit rights (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...LIMITS), fc.subarray([...CAPS]), (limit, caps) => {
        const options = byMode(offer(access([...caps, 'edit']), here([...caps, 'edit'], limit)));
        expect(options.edit).toEqual({ mode: 'edit', available: false, reason: limit });
        expect(options.review).toEqual({ mode: 'review', available: false, reason: limit });
        expect(options.view?.available).toBe(true);
      }),
    );
  });

  it('keeps edit available when the document has no limit', () => {
    const options = byMode(offer(access(['view', 'edit']), here(['view', 'edit'], null)));
    expect(options.edit).toEqual({ mode: 'edit', available: true, reason: null });
  });
});

describe('a user who may only suggest at the selection (UX-015, criterion 3, the offer part)', () => {
  it('does not offer edit where the user has suggest but not edit, and offers review', () => {
    const options = byMode(offer(access(['view', 'suggest', 'edit']), here(['view', 'suggest'])));
    expect(options.edit).toEqual({ mode: 'edit', available: false, reason: 'suggestOnly' });
    expect(options.review?.available).toBe(true);
  });
});

describe('the modes the switcher knows', () => {
  it('names the four modes of the specification', () => {
    expect([...ALL_MODES].sort()).toEqual([
      'edit',
      'fill',
      'review',
      'view',
    ] satisfies EditorMode[]);
  });
});
