// PRM-023 criterion 2 (lane V-PRM-018-034): with no active workflow a region grant to `role:<id>`
// matches nobody, even for a participant bound to that role (07 §1: the placeholder resolves to the
// participants bound in the active workflow). The same grant applies once a workflow is active.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';

const NOW = 1_000_000;
const REGION = 'rPlaceholder000002';

const bound: Connection = {
  sub: 'carol',
  session: 's1',
  role: 'viewer',
  groups: [],
  participantRoles: ['reviewer'],
  participantActive: true,
};

const grant: RegionGrant = {
  region: REGION,
  principal: 'role:reviewer',
  role: 'editor',
  expiresAt: null,
} as unknown as RegionGrant;

function perms(workflowActive: boolean): PermissionState {
  return {
    revision: 1,
    grants: [grant],
    regionStates: new Map([[REGION, 'open']]),
    leases: [],
    documentState: 'active',
    workflowActive,
  } as unknown as PermissionState;
}

const regions = [{ id: REGION, policy: 'restricted' as const }];

describe('a role placeholder without an active workflow (PRM-023 criterion 2)', () => {
  it('matches nobody when no workflow is active, even for a bound participant', () => {
    const a = computeAccess(bound, regions, perms(false), NOW);
    expect(a.granted.has(REGION)).toBe(false);
    expect(a.regions.get(REGION)?.has('edit')).toBe(false);
  });

  it('matches the bound participant once a workflow is active', () => {
    const a = computeAccess(bound, regions, perms(true), NOW);
    expect(a.granted.has(REGION)).toBe(true);
    expect(a.regions.get(REGION)?.has('edit')).toBe(true);
  });
});
