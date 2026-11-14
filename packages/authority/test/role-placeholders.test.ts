/**
 * Region grants to a role placeholder, `role:<id>` (PRM-023; 07 §1, §4). A participant bound to the
 * role holds the granted capabilities in the region, and a participant with two roles gets the best
 * matching grant. The rule that the placeholder matches nobody without an active workflow is not
 * tested here: the code and the PRM-004 fixtures disagree on it (see PRM-023 Notes).
 */
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';

const NOW = 1_000_000;
const REGION = 'rPlaceholder000001';

function conn(participantRoles: string[]): Connection {
  return {
    sub: 'carol',
    session: 's1',
    role: 'viewer',
    groups: [],
    participantRoles,
    participantActive: true,
  };
}

function perms(grants: RegionGrant[]): PermissionState {
  return {
    revision: 1,
    grants,
    regionStates: new Map([[REGION, 'open']]),
    leases: [],
    documentState: 'active',
    workflowActive: true,
  } as unknown as PermissionState;
}

const grant = (role: RegionGrant['role'], principal = 'role:reviewer'): RegionGrant =>
  ({ region: REGION, principal, role, expiresAt: null }) as unknown as RegionGrant;

const regions = [{ id: REGION, policy: 'restricted' as const }];

describe('region grants to a role placeholder (PRM-023)', () => {
  it('gives a bound participant the granted capabilities, limited as in PRM-004 (criterion 1)', () => {
    const a = computeAccess(conn(['reviewer']), regions, perms([grant('suggester')]), NOW);
    const caps = [...(a.regions.get(REGION) ?? [])];
    expect(caps).toContain('suggest');
    expect(caps).not.toContain('edit');
    expect(a.granted.has(REGION)).toBe(true);
  });

  it('matches nobody for a participant who is not bound to the role', () => {
    const a = computeAccess(conn(['someone-else']), regions, perms([grant('editor')]), NOW);
    expect(a.granted.has(REGION)).toBe(false);
    expect(a.regions.get(REGION)?.has('edit')).toBe(false);
  });

  it('applies the best matching grant when a participant holds two roles (criterion 4)', () => {
    const grants = [grant('viewer'), grant('editor', 'role:author')];
    const a = computeAccess(conn(['reviewer', 'author']), regions, perms(grants), NOW);
    expect(a.regions.get(REGION)?.has('edit')).toBe(true);
  });

  it('gives the weaker grant alone when only the weaker role is held', () => {
    const grants = [grant('viewer'), grant('editor', 'role:author')];
    const a = computeAccess(conn(['reviewer']), regions, perms(grants), NOW);
    expect(a.regions.get(REGION)?.has('edit')).toBe(false);
    expect(a.granted.has(REGION)).toBe(true);
  });
});
