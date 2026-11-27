// A region grant may list two operations of `structure` (PRM-068; ADR 0424; owner decision 279).
import { describe, expect, it } from 'vitest';
import {
  OPERATIONS,
  REGION_STRUCTURE_OPERATIONS,
  ROLE_CAPABILITIES,
  validateGrantStructure,
  validateRegionGrant,
} from '../src/permissions/model.ts';

const grant = (extra: Record<string, unknown>) => ({
  region: 'rTerms000000000A',
  principal: 'user:bob',
  role: 'editor',
  expiresAt: null,
  ...extra,
});

describe('OPERATIONS carries `perRegion` on exactly two operations (PRM-068, criterion 1)', () => {
  it('flags region.retitle and defs.add and no other', () => {
    const flagged = OPERATIONS.filter((o) => 'perRegion' in o).map((o) => o.id);
    expect(flagged.sort()).toEqual(['defs.add', 'region.retitle']);
    expect([...REGION_STRUCTURE_OPERATIONS].sort()).toEqual(['defs.add', 'region.retitle']);
  });

  it('leaves manage, fill, page setup, existing definitions, stories and region shape unflagged', () => {
    const unflagged = [
      'region.create',
      'region.delete',
      'region.split',
      'region.merge',
      'region.move',
      'section_break.change',
      'doc.change',
      'defs.change',
      'story.change',
      'grants.change',
      'region_state.change',
      'region.policy',
      'lease.break',
      'workflow.action',
      'workflow.evidence',
      'document.restore',
      'document.delete',
      'settings.track_changes_on',
      'settings.track_changes_off',
      'field.sensitive',
    ];
    for (const id of unflagged)
      expect(
        OPERATIONS.find((o) => o.id === id),
        id,
      ).not.toHaveProperty('perRegion');
    // Only `structure` operations carry the flag: `manage` never becomes grantable per region.
    for (const o of OPERATIONS) if ('perRegion' in o) expect(o.needs).toBe('structure');
    // Every operation is accounted for in one list or the other.
    expect(new Set([...unflagged, ...REGION_STRUCTURE_OPERATIONS]).size).toBe(OPERATIONS.length);
    // `fill` is a capability, not an operation, so it has no entry to flag.
    expect(OPERATIONS.some((o) => o.id === 'fill')).toBe(false);
  });
});

describe('a region grant with a structure list (PRM-068, criterion 2)', () => {
  it('accepts the role editor with either operation or both', () => {
    for (const structure of [
      ['region.retitle'],
      ['defs.add'],
      ['region.retitle', 'defs.add'],
      ['defs.add', 'region.retitle'],
      [],
    ])
      expect(validateRegionGrant(grant({ structure })), JSON.stringify(structure)).toEqual([]);
    expect(validateRegionGrant(grant({}))).toEqual([]);
  });

  it('refuses any other role, naming the reason', () => {
    for (const role of ['viewer', 'commenter', 'suggester', 'filler', 'owner']) {
      const problems = validateRegionGrant(grant({ role, structure: ['region.retitle'] }));
      expect(
        problems.some((p) => p.includes('only with the role editor')),
        role,
      ).toBe(true);
    }
  });

  it('refuses an unknown identifier, an operation without the flag and a duplicate', () => {
    expect(validateGrantStructure(['region.rename'], 'editor')).toEqual([
      'structure[0] is not an operation identifier',
    ]);
    expect(validateGrantStructure([7], 'editor')).toEqual([
      'structure[0] is not an operation identifier',
    ]);
    for (const op of OPERATIONS.filter((o) => !('perRegion' in o)).map((o) => o.id)) {
      const problems = validateGrantStructure([op], 'editor');
      expect(problems, op).toHaveLength(1);
      expect(problems[0], op).toContain(`\`${op}\` cannot be granted per region`);
    }
    expect(validateGrantStructure(['defs.add', 'defs.add'], 'editor')).toEqual([
      'structure[1] `defs.add` is listed twice',
    ]);
    expect(validateGrantStructure('defs.add', 'editor')).toEqual([
      'structure must be a list of operation identifiers',
    ]);
    expect(validateGrantStructure(null, 'editor')).toHaveLength(1);
  });

  it('still refuses unknown members, and a null expiry stays valid', () => {
    expect(validateRegionGrant(grant({ extra: 1 }))).toEqual(['unknown member extra']);
  });
});

describe('ROLE_CAPABILITIES is unchanged (PRM-068, criterion 3)', () => {
  it('keeps document-level structure for editor and owner only', () => {
    expect(ROLE_CAPABILITIES).toEqual({
      viewer: ['view'],
      commenter: ['view', 'comment'],
      suggester: ['view', 'comment', 'suggest'],
      filler: ['view', 'fill'],
      editor: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure'],
      owner: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
    });
  });
});
