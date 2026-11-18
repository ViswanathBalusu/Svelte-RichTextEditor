// A region grant to a role placeholder (12 §3.4, §4.3; FRW-012 criteria 1 and 5), with a workflow
// active: a participant bound to the role, matched by `sub`, holds the granted role in the region,
// and a person not bound to it does not; the grant never conveys `structure` or `manage`. The
// binding changes (criterion 3), the grants dialog (criterion 4) and the rule that the placeholder
// matches nobody without a workflow (criterion 2, undecided: see the story's Notes) are not tested
// here.
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';
import type { WorkflowStateName } from '../src/workflow/lifecycle.ts';
import { lockFor } from '../src/workflow/lock.ts';

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

describe('FRW-012 a locked document keeps edit in a region granted to a role (07 §4 limit 1; FRW-086 option a)', () => {
  const locked = (grants: RegionGrant[], extra: Partial<PermissionState> = {}): PermissionState =>
    ({ ...perms(grants), documentState: 'locked', ...extra }) as PermissionState;
  const userGrant = (role: RegionGrant['role']): RegionGrant =>
    ({ ...grant(role), principal: 'user:lena' }) as RegionGrant;
  const edits = (conn: Connection, p: PermissionState) =>
    computeAccess(conn, regions, p, NOW).regions.get(REGION)?.has('edit') ?? false;

  it('keeps edit for the active participant bound to the role, and only in that region', () => {
    const lena = person('lena', ['landlord']);
    const a = computeAccess(lena, regions, locked([grant('editor')]), NOW);
    expect(a.regions.get(REGION)?.has('edit')).toBe(true);
    // Nothing else of the locked document opens: view and comment elsewhere, no suggest, no structure.
    expect(a.body.has('edit')).toBe(false);
    expect(a.structureScopes.has('edit')).toBe(false);
    expect(a.newRegion.has('edit')).toBe(false);
    expect(a.regions.get(REGION)?.has('suggest')).toBe(false);
    expect(a.docRole.has('structure')).toBe(false);
    expect(a.docRole.has('manage')).toBe(false);
  });

  it('keeps nothing for a grant to a person, a viewer grant, an inactive or an unbound participant', () => {
    const lena = person('lena', ['landlord']);
    expect(edits(lena, locked([userGrant('editor')]))).toBe(false);
    expect(edits(lena, locked([grant('viewer')]))).toBe(false);
    expect(edits({ ...lena, participantActive: false }, locked([grant('editor')]))).toBe(false);
    expect(edits(person('mika', ['tenant']), locked([grant('editor')]))).toBe(false);
  });

  it('keeps nothing once the workflow is not active, the region is approved or the document is archived', () => {
    const lena = person('lena', ['landlord']);
    expect(edits(lena, locked([grant('editor')], { workflowActive: false }))).toBe(false);
    expect(
      edits(lena, locked([grant('editor')], { regionStates: new Map([[REGION, 'approved']]) })),
    ).toBe(false);
    expect(edits(lena, locked([grant('editor')], { documentState: 'archived' }))).toBe(false);
    // Control: the same participant on an active document edits.
    expect(edits(lena, locked([grant('editor')], { documentState: 'active' }))).toBe(true);
  });
});

describe('FRW-012 a grant to a role resolves to nobody without an active workflow (criterion 2)', () => {
  const withWorkflow = (grants: RegionGrant[], workflowActive: boolean): PermissionState =>
    ({ ...perms(grants), workflowActive }) as PermissionState;

  it('gives nothing to a participant bound to the role while no workflow is active', () => {
    const lena = person('lena', ['landlord']);
    const a = computeAccess(lena, regions, withWorkflow([grant('editor')], false), NOW);
    expect(a.granted.has(REGION)).toBe(false);
    expect(a.regions.get(REGION)?.has('edit') ?? false).toBe(false);
    // The same participant, the same grant, once a workflow is active (control).
    const on = computeAccess(lena, regions, withWorkflow([grant('editor')], true), NOW);
    expect(on.regions.get(REGION)?.has('edit')).toBe(true);
  });

  it('follows the workflow states: draft, declined and voided give nobody the grant; sent and in progress do', () => {
    const lena = person('lena', ['landlord']);
    const edits = (state: WorkflowStateName): boolean => {
      const lock = lockFor(state);
      if (lock === null) throw new Error(`the state ${state} implies no lock`);
      const a = computeAccess(
        lena,
        regions,
        { ...withWorkflow([grant('editor')], lock.workflowActive), documentState: 'active' },
        NOW,
      );
      return a.regions.get(REGION)?.has('edit') ?? false;
    };
    expect(edits('draft')).toBe(false);
    expect(edits('declined')).toBe(false);
    expect(edits('voided')).toBe(false);
    expect(edits('sent')).toBe(true);
    expect(edits('in_progress')).toBe(true);
  });

  it('gives no one a right from the grant when nobody is bound to the role', () => {
    for (const workflowActive of [false, true]) {
      const a = computeAccess(
        person('mika', []),
        regions,
        withWorkflow([grant('editor')], workflowActive),
        NOW,
      );
      expect(a.granted.has(REGION)).toBe(false);
    }
  });
});
