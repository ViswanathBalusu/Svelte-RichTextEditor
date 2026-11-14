/**
 * Suggestion mode by rule (FE-041 criterion 2 and the rules behind criteria 1 and 3; the core's
 * caret, switcher and read-only view are not covered here). Pure function tests, Node.js.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Access } from '@docedit/protocol';
import { suggestionMode, type SuggestionModeInput } from '../src/suggestion-mode.ts';
import { editorAccess } from './fixtures.ts';

const CAPS = ['view', 'comment', 'suggest', 'edit', 'manage'] as const;

/** An access whose document-level and body capabilities are `caps`. */
function withCaps(caps: readonly string[]): Access {
  const list = caps as Access['caps'];
  return editorAccess({ caps: list, scopes: { doc: ['view'], body: list, defs: ['view'] } });
}

function input(
  over: Partial<SuggestionModeInput> & { access: Access | null },
): SuggestionModeInput {
  return {
    requested: 'edit',
    readOnly: false,
    trackChanges: 'off',
    scope: 'body',
    ...over,
  };
}

describe('suggestion mode by rule (FE-041 criterion 2)', () => {
  it('is on in review mode for a user with edit, in every scope where the user has edit', () => {
    const editor = withCaps(['view', 'comment', 'suggest', 'edit']);
    const s = suggestionMode(input({ requested: 'review', access: editor, scope: 'body' }));
    expect(s).toEqual({ on: true, locked: false, reason: 'review-mode' });
    // A region the user may edit (granted in the access) is also suggestion mode in review mode.
    const region = editorAccess({
      caps: ['view', 'comment'],
      scopes: { doc: ['view'], body: ['view'], defs: ['view'], 'region:r1': ['view', 'edit'] },
    });
    expect(
      suggestionMode(input({ requested: 'review', access: region, scope: 'region:r1' })),
    ).toEqual({ on: true, locked: false, reason: 'review-mode' });
  });

  it('is off in edit mode for a user with edit and no document setting', () => {
    const editor = withCaps(['view', 'comment', 'suggest', 'edit']);
    expect(suggestionMode(input({ requested: 'edit', access: editor }))).toEqual({
      on: false,
      locked: false,
      reason: null,
    });
  });
});

describe('suggestion mode by rule (criteria 1, 3, 4 in their rule part)', () => {
  it('is on and cannot be switched off for a user with suggest but not edit in the scope', () => {
    const suggester = withCaps(['view', 'comment', 'suggest']);
    expect(suggestionMode(input({ requested: 'edit', access: suggester }))).toEqual({
      on: true,
      locked: true,
      reason: 'rights',
    });
  });

  it('applies trackChanges everyone to an editor, locked unless the user has manage', () => {
    const editor = withCaps(['view', 'comment', 'suggest', 'edit']);
    expect(
      suggestionMode(input({ requested: 'edit', access: editor, trackChanges: 'everyone' })),
    ).toEqual({ on: true, locked: true, reason: 'document-setting' });
    const manager = withCaps(['view', 'comment', 'suggest', 'edit', 'manage']);
    expect(
      suggestionMode(input({ requested: 'edit', access: manager, trackChanges: 'everyone' })),
    ).toEqual({ on: true, locked: false, reason: 'document-setting' });
  });

  it('gives no suggestion mode in a scope the user cannot change, and none in a locking mode', () => {
    const viewer = withCaps(['view', 'comment']);
    expect(suggestionMode(input({ requested: 'edit', access: viewer })).on).toBe(false);
    const editor = withCaps(['view', 'comment', 'suggest', 'edit']);
    expect(
      suggestionMode(input({ requested: 'view', access: editor, trackChanges: 'everyone' })).on,
    ).toBe(false);
    expect(
      suggestionMode(input({ requested: 'fill', access: editor, trackChanges: 'everyone' })).on,
    ).toBe(false);
    expect(
      suggestionMode(input({ access: editor, readOnly: true, trackChanges: 'everyone' })).on,
    ).toBe(false);
    expect(suggestionMode(input({ access: null, trackChanges: 'everyone' })).on).toBe(false);
  });

  it('follows the scope at the caret: suggest-only in the body, edit in a region', () => {
    const access = editorAccess({
      caps: ['view', 'comment', 'suggest'],
      scopes: {
        doc: ['view'],
        body: ['view', 'comment', 'suggest'],
        defs: ['view'],
        'region:r1': ['view', 'comment', 'suggest', 'edit'],
      },
    });
    expect(suggestionMode(input({ requested: 'edit', access, scope: 'body' }))).toEqual({
      on: true,
      locked: true,
      reason: 'rights',
    });
    expect(suggestionMode(input({ requested: 'edit', access, scope: 'region:r1' }))).toEqual({
      on: false,
      locked: false,
      reason: null,
    });
  });
});

describe('suggestion mode property (FE-041)', () => {
  it('is on and locked for any scope the user may only suggest in, whatever else is set', () => {
    fc.assert(
      fc.property(
        fc.subarray(CAPS.filter((c) => c !== 'edit')),
        fc.constantFrom('off' as const, 'everyone' as const, undefined),
        fc.constantFrom('edit' as const, 'review' as const),
        (extra, trackChanges, requested) => {
          const caps = ['view', 'suggest', ...extra].filter((c, i, a) => a.indexOf(c) === i);
          const s = suggestionMode(input({ requested, access: withCaps(caps), trackChanges }));
          expect(caps.includes('edit')).toBe(false);
          expect(s.on).toBe(true);
          expect(s.locked).toBe(true);
          expect(s.reason).toBe('rights');
        },
      ),
    );
  });
});
