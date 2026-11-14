// Region states, PRM-046 criteria 1, 2 and 6: who may set a state, and that `draft` and `in_review`
// change nothing in access. Generated over every document role and both ordinary policies.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import {
  type Connection,
  DOC_ROLES,
  type DocRole,
  type PermissionState,
  type RegionGrant,
  REGION_ROLES,
} from '../src/permissions/model.ts';
import { setRegionState } from '../src/permissions/states.ts';

const NOW = 1_770_900_000_000;
const R = 'rRegion000000001';
const LABELS = ['draft', 'in_review'] as const;

const conn = (role: DocRole): Connection => ({
  sub: 'u1',
  session: 's1',
  role,
  groups: ['legal'],
  participantRoles: [],
  participantActive: false,
});

const perms = (extra: Partial<PermissionState> = {}): PermissionState => ({
  revision: 1,
  grants: [],
  regionStates: new Map(),
  leases: [],
  documentState: 'active',
  workflowActive: false,
  ...extra,
});

/** The access a region gets, sorted so that two accesses compare as values. */
function summary(a: ReturnType<typeof computeAccess>) {
  return {
    docRole: [...a.docRole].sort(),
    body: [...a.body].sort(),
    structureScopes: [...a.structureScopes].sort(),
    regions: [...a.regions.entries()]
      .map(([id, caps]) => [id, [...caps].sort()] as const)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  };
}

describe('draft and in_review are labels, not limits (PRM-046 criterion 2)', () => {
  it('gives the same access in the region as without a state, for every role, policy and grant (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DOC_ROLES),
        fc.constantFrom('inherit', 'restricted') as fc.Arbitrary<'inherit' | 'restricted'>,
        fc.constantFrom(...LABELS),
        fc.option(fc.constantFrom(...REGION_ROLES), { nil: null }),
        fc.constantFrom('user:u1', 'group:legal', 'everyone', 'user:u2'),
        (role, policy, label, grantRole, principal) => {
          const grants: RegionGrant[] =
            grantRole === null ? [] : [{ region: R, principal, role: grantRole, expiresAt: null }];
          const c = conn(role);
          const regions = [{ id: R, policy }];
          const bare = perms({ grants });
          const labelled = perms({ grants, regionStates: new Map([[R, label]]) });
          expect(summary(computeAccess(c, regions, labelled, NOW))).toEqual(
            summary(computeAccess(c, regions, bare, NOW)),
          );
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('who may set a region state (PRM-046 criterion 1, and criterion 6)', () => {
  it('refuses every role but owner, for every label, and accepts the owner (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...DOC_ROLES),
        fc.constantFrom(...LABELS, 'approved' as const),
        (role, state) => {
          const p = perms();
          const access = computeAccess(conn(role), [{ id: R, policy: 'inherit' }], p, NOW);
          const approval = { seq: 0, hash: 'a'.repeat(64) };
          const v = setRegionState({
            access,
            perms: p,
            region: R,
            exists: true,
            state,
            ...(state === 'approved' ? { approval } : {}),
          });
          if (role === 'owner') expect(v.ok, `${role} ${state}`).toBe(true);
          else
            expect(v, `${role} ${state}`).toMatchObject({ ok: false, code: 'permission_denied' });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('answers not_found for a retired or unknown region, whatever the state (criterion 6)', () => {
    const p = perms();
    const owner = computeAccess(conn('owner'), [{ id: R, policy: 'inherit' }], p, NOW);
    for (const state of [...LABELS, 'approved'] as const)
      expect(
        setRegionState({
          access: owner,
          perms: p,
          region: 'rGone0000000000X',
          exists: false,
          state,
          ...(state === 'approved' ? { approval: { seq: 0, hash: 'b'.repeat(64) } } : {}),
        }),
      ).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('keeps the labels in the state map, and clears them when draft is set', () => {
    const p = perms();
    const owner = computeAccess(conn('owner'), [{ id: R, policy: 'inherit' }], p, NOW);
    const set = (state: 'draft' | 'in_review') =>
      setRegionState({ access: owner, perms: p, region: R, exists: true, state });
    const review = set('in_review');
    expect(review).toMatchObject({ ok: true });
    if (!review.ok) throw new Error('refused');
    expect(review.regionStates.get(R)).toBe('in_review');
    const back = setRegionState({
      access: owner,
      perms: { ...p, regionStates: review.regionStates },
      region: R,
      exists: true,
      state: 'draft',
    });
    if (!back.ok) throw new Error('refused');
    expect(back.regionStates.has(R)).toBe(false);
  });
});
