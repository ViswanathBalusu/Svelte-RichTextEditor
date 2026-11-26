// The machine-readable permission definition and the authorisation matrix (PRM-001 criterion 6;
// PRM-056): the artifact in spec/ is a fresh generation, the matrix has the 13 rows of 07 §12, every
// DEP route has a row or a documented classification, "somewhere" means some scope, and every row
// gives the expected answer to every role and principal (generated positive and negative cases).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAccess, holdsSomewhere } from '../src/permissions/access.ts';
import { MATRIX, UNMATRIXED_ROUTES, authorise } from '../src/permissions/matrix.ts';
import {
  type Connection,
  DOC_ROLES,
  type DocRole,
  MANAGE_OPERATIONS,
  OPERATIONS,
  type PermissionState,
  REGION_ROLES,
  type RegionGrant,
} from '../src/permissions/model.ts';
import { ROOT, pretty } from '../scripts/engine-fixtures.ts';
import { PERMISSIONS_ARTIFACT, buildPermissionsArtifact } from '../scripts/permissions-artifact.ts';
import { regionCaps as oracleRegionCaps } from './harness/oracle.ts';

const spec07 = readFileSync(resolve(ROOT, 'docs/spec/07-permissions.md'), 'utf8');

describe('the machine-readable definition in spec/ (PRM-001 criterion 6; PRM-056 criterion 1)', () => {
  it('is current: a fresh generation from the definitions writes the same bytes', async () => {
    expect(
      readFileSync(resolve(ROOT, PERMISSIONS_ARTIFACT), 'utf8'),
      `${PERMISSIONS_ARTIFACT} is stale; run pnpm --filter @docedit/authority generate`,
    ).toBe(await pretty(buildPermissionsArtifact()));
  });

  it('holds the 14 rows of 07 §12, in order, with their operation, routes, messages and requirement', () => {
    const section = spec07.slice(
      spec07.indexOf('## 12. Authorisation matrix'),
      spec07.indexOf('## 13.'),
    );
    const rows = section
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Operation') && !l.startsWith('|---'))
      .map((l) => l.split('|')[1]!.trim());
    expect(rows).toHaveLength(14);
    expect(MATRIX.map((r) => r.operation)).toEqual(rows);
    expect(MATRIX.map((r) => r.row)).toEqual(rows.map((_, i) => i + 1));
    for (const r of MATRIX)
      expect(r.routes.length + r.messages.length, r.id).toBeGreaterThan(
        r.id === 'asset.read' ? -1 : 0,
      );
    // Row 10 covers exactly the `manage` operations the control plane enforces.
    const row10 = MATRIX.find((r) => r.row === 10)!;
    if (row10.requirement.kind !== 'manage') throw new Error('row 10 is not manage');
    const control = OPERATIONS.filter((o) => o.where === 'control').map((o) => o.id);
    for (const op of control) expect(row10.requirement.operations, op).toContain(op);
    for (const op of row10.requirement.operations) expect(MANAGE_OPERATIONS, op).toContain(op);
    // The artifact carries the same matrix.
    const artifact = JSON.parse(readFileSync(resolve(ROOT, PERMISSIONS_ARTIFACT), 'utf8')) as {
      matrix: unknown[];
      operations: unknown[];
    };
    expect(artifact.matrix).toHaveLength(14);
    expect(artifact.operations).toHaveLength(OPERATIONS.length);
  });
});

describe('every route has a row or a documented classification (PRM-056 criterion 2)', () => {
  it('classifies every route of the DEP OpenAPI artifact, and names no route that does not exist', () => {
    const openapi = JSON.parse(
      readFileSync(resolve(ROOT, 'spec/dep/dep-1.openapi.json'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const routes: string[] = [];
    for (const [path, item] of Object.entries(openapi.paths))
      for (const method of Object.keys(item))
        if (['get', 'post', 'put', 'patch', 'delete'].includes(method))
          routes.push(`${method.toUpperCase()} ${path}`);
    const inRows = new Set(MATRIX.flatMap((r) => r.routes));
    const classified = new Set(UNMATRIXED_ROUTES.map((c) => c.route));
    const missing = routes.filter((r) => !inRows.has(r) && !classified.has(r));
    expect(missing, 'routes without a matrix row or a classification').toEqual([]);
    const known = new Set(routes);
    expect(
      [...inRows, ...classified].filter((r) => !known.has(r)),
      'stale entries',
    ).toEqual([]);
    // A route is either in a row or classified, not both.
    expect([...classified].filter((r) => inRows.has(r))).toEqual([]);
    for (const c of UNMATRIXED_ROUTES) expect(c.note.length, c.route).toBeGreaterThan(3);
  });
});

// -- generated cases -------------------------------------------------------------------------------

const NOW = 1_760_000_000_000;
const R = 'rRegion000000001';
const conn = (role: DocRole): Connection => ({
  sub: 'u1',
  session: 's1',
  role,
  groups: ['legal'],
  participantRoles: ['role_tenant'],
  participantActive: true,
});
const PRINCIPALS = [
  'user:u1',
  'group:legal',
  'everyone',
  'role:role_tenant',
  'user:u2',
  'group:hr',
];

/** Every role, both ordinary policies, no grant or one grant of each region role to each principal. */
function* situations(): Generator<{
  role: DocRole;
  policy: 'inherit' | 'restricted';
  perms: PermissionState;
  name: string;
}> {
  for (const role of DOC_ROLES)
    for (const policy of ['inherit', 'restricted'] as const) {
      const grantsList: RegionGrant[][] = [[]];
      for (const g of REGION_ROLES)
        for (const principal of PRINCIPALS)
          grantsList.push([{ region: R, principal, role: g, expiresAt: null }]);
      for (const grants of grantsList)
        yield {
          role,
          policy,
          perms: {
            revision: 1,
            grants,
            regionStates: new Map(),
            leases: [],
            documentState: 'active',
            workflowActive: false,
          },
          name: `${role}, ${policy}, ${grants[0] ? `${grants[0].role} to ${grants[0].principal}` : 'no grant'}`,
        };
    }
}

/** 07 §2, written out again for the expectations. */
const TABLE: Record<DocRole, string[]> = {
  viewer: ['view'],
  commenter: ['view', 'comment'],
  suggester: ['view', 'comment', 'suggest'],
  filler: ['view', 'fill'],
  editor: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure'],
  owner: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
};

describe('generated cases for every row, role and principal (PRM-056 criteria 4 and 5)', () => {
  it('answers each row as its wording says, with positive and negative cases', () => {
    const counts = new Map<string, { yes: number; no: number }>();
    for (const s of situations()) {
      const c = conn(s.role);
      const access = computeAccess(c, [{ id: R, policy: s.policy }], s.perms, NOW);
      const region = oracleRegionCaps(c, s.perms, R, s.policy, NOW);
      const role = TABLE[s.role];
      // The expectation of each row, derived from the role table and the oracle's region scope.
      const expected: Record<string, boolean> = {
        'read.head': true,
        'read.history': true,
        'thread.create': region.has('comment'),
        'thread.update': role.includes('comment'), // target: the body
        'asset.upload':
          role.some((x) => ['edit', 'suggest', 'fill'].includes(x)) ||
          region.has('edit') ||
          region.has('suggest'),
        'asset.read': true,
        'version.create': role.includes('edit') || region.has('edit'),
        'restore.region': region.has('edit'),
        manage: role.includes('manage'),
        'lease.acquire': region.has('edit'),
        export: true,
        service: false,
      };
      const ctx = (id: string) => ({
        credential: 'user' as const,
        access,
        targets: id === 'thread.update' ? ['body'] : [`region:${R}`],
        region: R,
      });
      for (const [id, want] of Object.entries(expected)) {
        expect(authorise(id, ctx(id)).ok, `${id}: ${s.name}`).toBe(want);
        const k = counts.get(id) ?? { yes: 0, no: 0 };
        if (want) k.yes++;
        else k.no++;
        counts.set(id, k);
      }
    }
    // Every row that can refuse a user had negative cases, and every row but `service` positive ones.
    for (const id of [
      'thread.create',
      'thread.update',
      'asset.upload',
      'version.create',
      'restore.region',
      'manage',
      'lease.acquire',
      'service',
    ])
      expect(counts.get(id)!.no, id).toBeGreaterThan(0);
    for (const [id, k] of counts) if (id !== 'service') expect(k.yes, id).toBeGreaterThan(0);
  });

  it('reads "somewhere in the document" as at least one scope', () => {
    const perms = (grants: RegionGrant[]): PermissionState => ({
      revision: 1,
      grants,
      regionStates: new Map(),
      leases: [],
      documentState: 'active',
      workflowActive: false,
    });
    const grant: RegionGrant = { region: R, principal: 'user:u1', role: 'editor', expiresAt: null };
    const viewerWithGrant = computeAccess(
      conn('viewer'),
      [{ id: R, policy: 'restricted' }],
      perms([grant]),
      NOW,
    );
    expect(holdsSomewhere(viewerWithGrant, 'edit')).toBe(true);
    expect(authorise('asset.upload', { credential: 'user', access: viewerWithGrant }).ok).toBe(
      true,
    );
    expect(authorise('version.create', { credential: 'user', access: viewerWithGrant }).ok).toBe(
      true,
    );
    const filler = computeAccess(conn('filler'), [{ id: R, policy: 'inherit' }], perms([]), NOW);
    expect(authorise('asset.upload', { credential: 'user', access: filler }).ok).toBe(true);
    expect(authorise('version.create', { credential: 'user', access: filler }).ok).toBe(false);
    const commenter = computeAccess(
      conn('commenter'),
      [{ id: R, policy: 'inherit' }],
      perms([]),
      NOW,
    );
    expect(authorise('asset.upload', { credential: 'user', access: commenter }).ok).toBe(false);
  });

  it('refuses user tokens for service rows, `no-export` for exports, and restores of approved or leased regions', () => {
    const owner = computeAccess(
      conn('owner'),
      [{ id: R, policy: 'inherit' }],
      {
        revision: 1,
        grants: [],
        regionStates: new Map(),
        leases: [],
        documentState: 'active',
        workflowActive: false,
      },
      NOW,
    );
    expect(authorise('service', { credential: 'user', access: owner }).ok).toBe(false);
    expect(authorise('service', { credential: 'service' }).ok).toBe(true);
    expect(
      authorise('export', { credential: 'user', access: owner, restrictions: ['no-export'] }).ok,
    ).toBe(false);
    expect(
      authorise('restore.region', {
        credential: 'user',
        access: owner,
        region: R,
        regionState: 'approved',
      }).ok,
    ).toBe(false);
    expect(
      authorise('restore.region', {
        credential: 'user',
        access: owner,
        region: R,
        leasedToSomeoneElse: true,
      }).ok,
    ).toBe(false);
    expect(authorise('restore.region', { credential: 'user', access: owner, region: R }).ok).toBe(
      true,
    );
    expect(authorise('nothing', { credential: 'service' }).ok).toBe(false);
  });
});
