// A region grant to a role placeholder (12 §3.4, §4.3; FRW-012 criteria 1 and 5), with a workflow
// active: a participant bound to the role, matched by `sub`, holds the granted role in the region,
// and a person not bound to it does not; the grant never conveys `structure` or `manage`. The
// binding changes (criterion 3), the grants dialog (criterion 4) and the rule that the placeholder
// matches nobody without a workflow (criterion 2, undecided: see the story's Notes) are not tested
// here.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';

const NOW = 1_000_000;
const REGION = 'rPlaceholder000002';
const regions = [{ id: REGION, policy: 'restricted' as const }];

const person = (sub: string, participantRoles: string[], role: Connection['role'] = 'viewer') =>
  ({
    sub,
    session: `s-${sub}`,
    role,
    groups: [],
    participantRoles,
    participantActive: true,
  }) as Connection;

const grant = (role: RegionGrant['role']): RegionGrant =>
  ({
    region: REGION,
    principal: 'role:landlord',
    role,
    expiresAt: null,
  }) as unknown as RegionGrant;

const perms = (grants: RegionGrant[]): PermissionState =>
  ({
    revision: 1,
    grants,
    regionStates: new Map([[REGION, 'open']]),
    leases: [],
    documentState: 'active',
    workflowActive: true,
  }) as unknown as PermissionState;

describe('FRW-012 a region grant to a role placeholder (criterion 1)', () => {
  it('gives the granted role to the bound participant, matched by sub', () => {
    const a = computeAccess(person('lena', ['landlord']), regions, perms([grant('editor')]), NOW);
    expect(a.regions.get(REGION)?.has('edit')).toBe(true);
    expect(a.granted.has(REGION)).toBe(true);
  });

  it('gives nothing to a person not bound to the role', () => {
    const a = computeAccess(person('mika', ['tenant']), regions, perms([grant('editor')]), NOW);
    expect(a.granted.has(REGION)).toBe(false);
    expect(a.regions.get(REGION)?.has('edit') ?? false).toBe(false);
  });
});

describe('FRW-012 a grant to a role never conveys structure or manage (criterion 5)', () => {
  it('leaves the document role, the structure scopes and manage untouched for an editor grant', () => {
    const lena = person('lena', ['landlord'], 'viewer');
    const a = computeAccess(lena, regions, perms([grant('editor')]), NOW);
    expect(a.docRole.has('structure')).toBe(false);
    expect(a.docRole.has('manage')).toBe(false);
    expect(a.structureScopes.has('edit')).toBe(false);
    expect(a.regions.get(REGION)?.has('structure') ?? false).toBe(false);
    expect(a.regions.get(REGION)?.has('manage') ?? false).toBe(false);
  });
});
