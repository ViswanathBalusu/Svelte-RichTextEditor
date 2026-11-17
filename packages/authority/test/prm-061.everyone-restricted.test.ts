// PRM-061: `everyone` is forbidden on a `restricted` region (07 §17; owner decision 12 of
// 2026-11-15, docs/owner-decisions-2026-11-15.md; ADR 0146). Grant validation refuses it, and a
// stored `everyone` grant on a restricted region conveys nothing (fail closed). On an `inherit`
// region `everyone` stays valid and matches every connection.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import {
  REGION_POLICIES,
  REGION_ROLES,
  type Connection,
  type PermissionState,
  type RegionPolicy,
  validateRegionGrant,
} from '../src/permissions/model.ts';

const REGION = 'rRegion000000001';

const grant = (principal: string, role: string) => ({
  region: REGION,
  principal,
  role,
  expiresAt: null,
});

const conn = (role: Connection['role']): Connection => ({
  sub: 'u1',
  session: 's1',
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
});

const perms = (principal: string, role: 'viewer' | 'commenter' | 'suggester' | 'editor') =>
  ({
    revision: 1,
    grants: [{ region: REGION, principal, role, expiresAt: null }],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
  }) satisfies PermissionState;

describe('everyone on a restricted region (PRM-061)', () => {
  it('refuses the principal everyone on a restricted region, for every region role', () => {
    for (const role of REGION_ROLES) {
      const problems = validateRegionGrant(grant('everyone', role), 'restricted');
      expect(problems, role).toHaveLength(1);
      expect(problems[0], role).toMatch(/everyone cannot be granted a role on a restricted region/);
    }
  });

  it('accepts everyone on the other policies, and users, groups and roles on a restricted one', () => {
    for (const policy of REGION_POLICIES.filter((p) => p !== 'restricted'))
      expect(validateRegionGrant(grant('everyone', 'editor'), policy), policy).toEqual([]);
    expect(validateRegionGrant(grant('everyone', 'editor'))).toEqual([]);
    for (const principal of ['user:u1', 'group:legal', 'role:role_tenant'])
      expect(validateRegionGrant(grant(principal, 'editor'), 'restricted'), principal).toEqual([]);
  });

  it('gives a stored everyone grant on a restricted region no capability', () => {
    const regions = (policy: RegionPolicy) => [{ id: REGION, policy }];
    const stored = perms('everyone', 'editor');
    // Restricted: a document editor keeps `view` and `comment` only; the grant adds nothing.
    const restricted = computeAccess(conn('editor'), regions('restricted'), stored, 1).regions.get(
      REGION,
    )!;
    expect(restricted.has('edit')).toBe(false);
    expect(restricted.has('view')).toBe(true);
    expect(restricted.has('comment')).toBe(true);
    // A document viewer gets nothing more either.
    const viewer = computeAccess(conn('viewer'), regions('restricted'), stored, 1).regions.get(
      REGION,
    )!;
    expect(viewer.has('comment')).toBe(false);
    expect(
      computeAccess(conn('viewer'), regions('restricted'), stored, 1).granted.has(REGION),
    ).toBe(false);
    // The same stored grant still matches on an `inherit` region (07 §1).
    const inherit = computeAccess(conn('viewer'), regions('inherit'), stored, 1).regions.get(
      REGION,
    )!;
    expect(inherit.has('edit')).toBe(true);
  });

  it('still lets a named user or group hold a role on a restricted region', () => {
    const named = perms('user:u1', 'editor');
    const access = computeAccess(
      conn('viewer'),
      [{ id: REGION, policy: 'restricted' }],
      named,
      1,
    ).regions.get(REGION)!;
    expect(access.has('edit')).toBe(true);
  });
});
