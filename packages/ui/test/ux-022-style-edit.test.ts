/**
 * UX-022 criteria 2 and 3, the shell's half: what stops a style being created, changed or deleted,
 * and which region blocks it. The core's answer is `CoreApi.styleEdit`; the approved state of a
 * region is read from the region list, as the core cannot see it.
 */
import { describe, expect, it } from 'vitest';
import type { RegionSummary, StyleEditCheck } from '../src/core-api.ts';
import { nameProblem, parentChoices, styleBlock, USER_REASONS } from '../src/shell/style-edit.ts';

const region = (id: string, state: RegionSummary['state']): RegionSummary => ({
  id,
  title: id,
  policy: 'restricted',
  order: 0,
  state,
});

describe('styleBlock (UX-022 criteria 2 and 3)', () => {
  it('passes what the core refuses on, with its reason and the regions it names', () => {
    const refused: StyleEditCheck = { ok: false, reason: 'region', regions: ['r1'] };
    expect(styleBlock(refused, 'change', [])).toEqual({ reason: 'region', regions: ['r1'] });
    const none: StyleEditCheck = { ok: false, reason: 'no-access', regions: [] };
    for (const op of ['create', 'change', 'delete'] as const)
      expect(styleBlock(none, op, [])).toEqual({ reason: 'no-access', regions: [] });
  });

  it('names the approved regions that use the style when the core allows the edit', () => {
    const ok: StyleEditCheck = { ok: true, regions: ['r1', 'r2', 'r3'] };
    const regions = [region('r1', 'approved'), region('r2', 'draft'), region('r3', 'approved')];
    expect(styleBlock(ok, 'change', regions)).toEqual({
      reason: 'approved',
      regions: ['r1', 'r3'],
    });
    expect(styleBlock(ok, 'delete', regions)).toEqual({
      reason: 'approved',
      regions: ['r1', 'r3'],
    });
  });

  it('lets an edit through when no region that uses the style is approved, and a new style always', () => {
    const ok: StyleEditCheck = { ok: true, regions: ['r2'] };
    expect(styleBlock(ok, 'change', [region('r2', 'in_review')])).toBeNull();
    expect(styleBlock({ ok: true, regions: [] }, 'create', [region('r1', 'approved')])).toBeNull();
    // A core that cannot answer blocks nothing from the shell's side.
    expect(styleBlock(undefined, 'change', [])).toBeNull();
  });

  it('knows which reasons hold for every style', () => {
    expect([...USER_REASONS].sort()).toEqual(['no-access', 'read-only', 'suggestion']);
  });

  it('offers the styles of the same kind as parents, never the style itself', () => {
    const styles = [
      { id: 'a', kind: 'paragraph' },
      { id: 'b', kind: 'paragraph' },
      { id: 'c', kind: 'character' },
    ];
    expect(parentChoices(styles, 'paragraph', 'a').map((s) => s.id)).toEqual(['b']);
    expect(parentChoices(styles, 'paragraph', null).map((s) => s.id)).toEqual(['a', 'b']);
    expect(parentChoices(styles, 'table', null)).toEqual([]);
  });
});

describe('nameProblem (UX-022)', () => {
  const styles = [
    { id: 'a', kind: 'paragraph', name: 'Quote' },
    { id: 'b', kind: 'character', name: 'Emphasis' },
  ];
  it('refuses an empty name and a name another style of the kind has', () => {
    expect(nameProblem(styles, 'paragraph', '   ', null)).toBe('bad-name');
    expect(nameProblem(styles, 'paragraph', ' quote ', null)).toBe('duplicate-name');
    expect(nameProblem(styles, 'character', 'Quote', null)).toBeNull();
    expect(nameProblem(styles, 'paragraph', 'Quote', 'a')).toBeNull();
  });
});
