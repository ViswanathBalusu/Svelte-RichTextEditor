/**
 * Table-driven fixtures for effective capabilities (07 §2, §4; PRM-004), for the conformance kit.
 *
 * Every role is combined with the three region policies and with no grant, a grant of each region
 * role through each principal form, grants that do not match, several grants at once, expiry (at
 * the instant, just before and just after) and the limits of 07 §4 (document state, approval,
 * lease). The third policy, `confidential`, is ADR 0019's (proposed).
 *
 * The expected values are derived here from the wording of 07 §2 and §4 and of ADR 0019, with a
 * role table of their own, not from `computeAccess`: the test then checks the implementation
 * against them.
 */

type Cap = 'view' | 'comment' | 'suggest' | 'edit' | 'fill' | 'structure' | 'manage';
type Role = 'viewer' | 'commenter' | 'suggester' | 'filler' | 'editor' | 'owner';

const ORDER: readonly Cap[] = ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'];
const ROLES: readonly Role[] = ['viewer', 'commenter', 'suggester', 'filler', 'editor', 'owner'];
const REGION_ROLES: readonly Role[] = ['viewer', 'commenter', 'suggester', 'editor'];
/** 07 §2, written out again. */
const TABLE: Readonly<Record<Role, readonly Cap[]>> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  suggester: ['view', 'comment', 'suggest'],
  filler: ['view', 'fill'],
  editor: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure'],
  owner: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
};
/** 07 §4: region scopes carry at most these four. */
const FOUR: readonly Cap[] = ['view', 'comment', 'suggest', 'edit'];

export const NOW = 1_760_000_000_000;
export const USER = {
  sub: 'u1',
  session: 's1',
  groups: ['legal'],
  participantRoles: ['role_tenant'],
  participantActive: true,
};
export const REGION = 'rRegion000000001';
const MATCHING = ['user:u1', 'group:legal', 'everyone', 'role:role_tenant'];
const NOT_MATCHING = ['user:u2', 'group:finance', 'role:role_landlord'];

export interface GrantCase {
  principal: string;
  role: Role;
  expiresAt: number | null;
}

export interface CapabilityCase {
  id: string;
  name: string;
  role: Role;
  policy: 'inherit' | 'restricted' | 'confidential';
  grants: GrantCase[];
  documentState: 'active' | 'locked' | 'archived';
  workflowActive: boolean;
  regionState: 'draft' | 'in_review' | 'approved';
  /** The holder of a lease on the region, or null. */
  leaseHolder: string | null;
  expected: { body: Cap[]; doc: Cap[]; defs: Cap[]; story: Cap[]; region: Cap[]; fill: boolean };
}

const sorted = (caps: Iterable<Cap>): Cap[] => {
  const set = new Set(caps);
  return ORDER.filter((c) => set.has(c));
};
const only = (caps: Iterable<Cap>, allowed: readonly Cap[]): Cap[] =>
  sorted([...caps].filter((c) => allowed.includes(c)));

/** 07 §4, step by step. */
function expected(c: Omit<CapabilityCase, 'id' | 'name' | 'expected'>): CapabilityCase['expected'] {
  const r = TABLE[c.role];
  let body = sorted(r);
  let structure = sorted(r.includes('structure') ? ['view', 'edit'] : ['view']);

  // "A grant matches when its principal is user:<sub>, group:<g> for some g in grp, everyone, or a
  // role: the user's participant holds, and it has not expired. The best match is the one with the
  // most capabilities." Region grants use the four region roles only (07 §2).
  const matches = c.grants.filter(
    (g) =>
      REGION_ROLES.includes(g.role) &&
      (g.expiresAt === null || NOW < g.expiresAt) &&
      (g.principal === `user:${USER.sub}` ||
        (g.principal.startsWith('group:') && USER.groups.includes(g.principal.slice(6))) ||
        // PRM-061: `everyone` conveys nothing on a restricted region (owner decision 12, 2026-11-15).
        (g.principal === 'everyone' && c.policy !== 'restricted') ||
        (g.principal.startsWith('role:') &&
          c.workflowActive &&
          USER.participantRoles.includes(g.principal.slice(5)))),
  );
  let best: Cap[] | null = null;
  for (const g of matches) {
    const caps = only(TABLE[g.role], FOUR);
    if (!best || caps.length > best.length) best = caps;
  }
  let region: Cap[];
  if (c.role === 'owner')
    region = [...FOUR]; // "An owner always has all four"
  else if (c.policy === 'inherit') region = only([...r, ...(best ?? [])], FOUR);
  else if (c.policy === 'restricted') region = best ?? only(r, ['view', 'comment']);
  // ADR 0019: "a region whose content ... only principals with a read grant may see ... where
  // grants convey `view` explicitly. With no matching grant a reader gets nothing of the region
  // except a placeholder, unless they hold `manage`" (only owners hold `manage`).
  else region = best ?? [];
  // Version 1 restricts changing; reading is restricted only in confidential regions.
  if (c.policy !== 'confidential') region = sorted([...region, 'view']);

  // Limits, in order.
  if (c.documentState !== 'active') {
    const keep: Cap[] = c.documentState === 'locked' ? ['view', 'comment'] : ['view'];
    body = only(body, keep);
    structure = only(structure, keep);
    region = only(region, keep);
  }
  if (c.regionState === 'approved') region = only(region, ['view', 'comment']);
  if (c.leaseHolder !== null && c.leaseHolder !== USER.sub)
    region = only(region, ['view', 'comment']);
  const fill = r.includes('fill') && (c.documentState === 'active' || c.workflowActive);
  return { body, doc: structure, defs: structure, story: structure, region, fill };
}

export function buildCapabilityFixture(): unknown {
  const cases: CapabilityCase[] = [];
  const add = (name: string, c: Omit<CapabilityCase, 'id' | 'name' | 'expected'>) =>
    cases.push({
      id: `cap-${String(cases.length + 1).padStart(4, '0')}`,
      name,
      ...c,
      expected: expected(c),
    });
  const plain = {
    documentState: 'active',
    workflowActive: false,
    regionState: 'draft',
    leaseHolder: null,
  } as const;

  for (const role of ROLES)
    for (const policy of ['inherit', 'restricted', 'confidential'] as const) {
      const at = `${role}, ${policy}`;
      add(`${at}, no grant`, { role, policy, grants: [], ...plain });
      for (const grant of REGION_ROLES) {
        for (const principal of MATCHING)
          add(`${at}, ${grant} grant to ${principal}`, {
            role,
            policy,
            grants: [{ principal, role: grant, expiresAt: null }],
            ...plain,
          });
        for (const principal of NOT_MATCHING)
          add(`${at}, ${grant} grant to ${principal} (does not match)`, {
            role,
            policy,
            grants: [{ principal, role: grant, expiresAt: null }],
            ...plain,
          });
      }
      // A region grant naming any other role is never valid (07 §2) and conveys nothing.
      for (const grant of ['filler', 'owner'] as const)
        add(`${at}, invalid ${grant} grant`, {
          role,
          policy,
          grants: [{ principal: 'user:u1', role: grant, expiresAt: null }],
          ...plain,
        });
      // Several grants match: the one with the most capabilities wins.
      add(`${at}, viewer and editor grants match`, {
        role,
        policy,
        grants: [
          { principal: 'user:u1', role: 'viewer', expiresAt: null },
          { principal: 'group:legal', role: 'editor', expiresAt: null },
        ],
        ...plain,
      });
      add(`${at}, commenter and suggester grants match`, {
        role,
        policy,
        grants: [
          { principal: 'role:role_tenant', role: 'commenter', expiresAt: null },
          { principal: 'everyone', role: 'suggester', expiresAt: null },
        ],
        ...plain,
      });
      // Expiry, with the clock at the instant of expiry and either side of it.
      for (const [when, expiresAt] of [
        ['expired at this instant', NOW],
        ['expired a millisecond ago', NOW - 1],
        ['expiring in a millisecond', NOW + 1],
      ] as const)
        add(`${at}, editor grant ${when}`, {
          role,
          policy,
          grants: [{ principal: 'user:u1', role: 'editor', expiresAt }],
          ...plain,
        });
      // The limits of 07 §4.
      for (const documentState of ['locked', 'archived'] as const)
        for (const workflowActive of [false, true])
          add(`${at}, document ${documentState}${workflowActive ? ', workflow active' : ''}`, {
            role,
            policy,
            grants: [{ principal: 'user:u1', role: 'editor', expiresAt: null }],
            ...plain,
            documentState,
            workflowActive,
          });
      add(`${at}, region approved`, {
        role,
        policy,
        grants: [{ principal: 'user:u1', role: 'editor', expiresAt: null }],
        ...plain,
        regionState: 'approved',
      });
      add(`${at}, region in review`, {
        role,
        policy,
        grants: [{ principal: 'user:u1', role: 'editor', expiresAt: null }],
        ...plain,
        regionState: 'in_review',
      });
      for (const leaseHolder of ['u2', 'u1'])
        add(`${at}, lease held by ${leaseHolder === 'u1' ? 'the user' : 'another user'}`, {
          role,
          policy,
          grants: [{ principal: 'user:u1', role: 'editor', expiresAt: null }],
          ...plain,
          leaseHolder,
        });
    }

  return {
    spec: '07 §2, §4; ADR 0019 (proposed); PRM-004, PRM-066',
    description:
      'Effective capabilities per scope for one user and one region. Inputs: the document role, the region policy (`confidential` is ADR 0019, proposed), the region grants (principal, role, expiry in Unix milliseconds), the document state, whether a workflow is active, the region state and the holder of a lease. `now` is the server time of the computation. A region whose capabilities lack `view` is hidden from the user. `fill` says whether the connection may fill fields at all; which fields is 12 §4.',
    generator: 'packages/authority/scripts/generate.ts',
    now: NOW,
    user: USER,
    region: REGION,
    capabilityOrder: ORDER,
    cases,
  };
}
