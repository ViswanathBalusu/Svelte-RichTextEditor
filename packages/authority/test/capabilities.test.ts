// Effective capabilities against the table-driven fixtures of PRM-004 (07 §2, §4), and the
// definition of roles, scopes, principals and grants of PRM-001.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import {
  CAPABILITIES,
  DOC_ROLES,
  type Capability,
  type Connection,
  type PermissionState,
  REGION_ROLES,
  ROLE_CAPABILITIES,
  formatPrincipal,
  formatScope,
  parsePrincipal,
  parseScope,
  validateRegionGrant,
} from '../src/permissions/model.ts';
import { buildCapabilityFixture, type CapabilityCase } from '../scripts/capability-fixtures.ts';
import { ROOT, pretty } from '../scripts/engine-fixtures.ts';
import { regionCaps as oracleRegionCaps } from './harness/oracle.ts';

const FILE = 'packages/authority/fixtures/capabilities.json';
const fixture = JSON.parse(readFileSync(resolve(ROOT, FILE), 'utf8')) as {
  now: number;
  user: { sub: string; session: string; groups: string[]; participantRoles: string[] };
  region: string;
  cases: CapabilityCase[];
};

const order = (caps: ReadonlySet<Capability>): Capability[] =>
  CAPABILITIES.filter((c) => caps.has(c));

function inputs(c: CapabilityCase): { conn: Connection; perms: PermissionState } {
  const conn: Connection = {
    sub: fixture.user.sub,
    session: fixture.user.session,
    role: c.role,
    groups: fixture.user.groups,
    participantRoles: fixture.user.participantRoles,
    participantActive: true,
  };
  const perms: PermissionState = {
    revision: 1,
    grants: c.grants.map((g) => ({ region: fixture.region, ...g }) as never),
    regionStates: new Map([[fixture.region, c.regionState]]),
    leases: c.leaseHolder
      ? [{ region: fixture.region, holder: c.leaseHolder, expiresAt: fixture.now + 60_000 }]
      : [],
    documentState: c.documentState,
    workflowActive: c.workflowActive,
  };
  return { conn, perms };
}

describe('effective capabilities (PRM-004, 07 §4)', () => {
  it('covers every role, the three policies and every grant situation', () => {
    const roles = new Set(fixture.cases.map((c) => c.role));
    expect([...roles].sort()).toEqual([...DOC_ROLES].sort());
    for (const role of DOC_ROLES)
      for (const policy of ['inherit', 'restricted', 'confidential'])
        for (const grant of REGION_ROLES)
          expect(
            fixture.cases.some(
              (c) =>
                c.role === role && c.policy === policy && c.grants.some((g) => g.role === grant),
            ),
            `${role} ${policy} ${grant}`,
          ).toBe(true);
    expect(fixture.cases.some((c) => c.grants.some((g) => g.expiresAt === fixture.now))).toBe(true);
  });

  it('computeAccess gives exactly the expected capabilities in every case', () => {
    for (const c of fixture.cases) {
      const { conn, perms } = inputs(c);
      const a = computeAccess(conn, [{ id: fixture.region, policy: c.policy }], perms, fixture.now);
      const got = {
        body: order(a.body),
        doc: order(a.structureScopes),
        defs: order(a.structureScopes),
        story: order(a.structureScopes),
        region: order(a.regions.get(fixture.region)!),
        fill: a.fill.allowed,
      };
      expect(got, `${c.id}: ${c.name}`).toEqual(c.expected);
    }
  });

  it('the oracle of the property suite agrees on every region scope', () => {
    for (const c of fixture.cases) {
      const { conn, perms } = inputs(c);
      const caps = oracleRegionCaps(conn, perms, fixture.region, c.policy, fixture.now);
      expect(order(caps as Set<Capability>), `${c.id}: ${c.name}`).toEqual(c.expected.region);
    }
  });

  it('includes view in every region that is not confidential, and never fill, structure or manage', () => {
    for (const c of fixture.cases) {
      if (c.policy !== 'confidential') expect(c.expected.region, c.id).toContain('view');
      for (const cap of ['fill', 'structure', 'manage'] as const)
        expect(c.expected.region, c.id).not.toContain(cap);
    }
  });

  it('in a confidential region, gives view exactly to owners and to holders of a matching grant (ADR 0019)', () => {
    const confidential = fixture.cases.filter((c) => c.policy === 'confidential');
    expect(confidential.length).toBeGreaterThan(100);
    let hidden = 0;
    for (const c of confidential) {
      const { conn, perms } = inputs(c);
      const a = computeAccess(conn, [{ id: fixture.region, policy: c.policy }], perms, fixture.now);
      const grantMatches = a.granted.has(fixture.region);
      expect(c.expected.region.includes('view'), `${c.id}: ${c.name}`).toBe(
        c.role === 'owner' || grantMatches,
      );
      if (!c.expected.region.includes('view')) {
        hidden++;
        // Nothing at all: no comment, suggestion or edit without the right to read.
        expect(c.expected.region, c.id).toEqual([]);
      }
    }
    expect(hidden).toBeGreaterThan(20);
  });

  it('is current: a fresh generation writes the same bytes', async () => {
    expect(readFileSync(resolve(ROOT, FILE), 'utf8'), `${FILE} is stale; run pnpm generate`).toBe(
      await pretty(buildCapabilityFixture()),
    );
  });
});

describe('roles, scopes, principals and grants (PRM-001, 07 §1, §2)', () => {
  it('the role table equals 07 §2, with structure for editors at document level only', () => {
    const spec = readFileSync(resolve(ROOT, 'docs/spec/07-permissions.md'), 'utf8');
    const section = spec.slice(spec.indexOf('## 2. Roles'), spec.indexOf('## 3.'));
    const lines = section.split('\n').filter((l) => l.startsWith('| `'));
    const header = section
      .split('\n')
      .find((l) => l.startsWith('| Role'))!
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .slice(1);
    expect(header).toEqual([...CAPABILITIES]);
    const fromSpec = Object.fromEntries(
      lines.map((l) => {
        const cells = l.split('|').map((c) => c.trim());
        const role = /`(\w+)`/.exec(cells[1]!)![1]!;
        const caps = header.filter((_, i) => cells[i + 2]!.startsWith('yes'));
        return [role, caps];
      }),
    );
    expect(fromSpec).toEqual(
      Object.fromEntries(Object.entries(ROLE_CAPABILITIES).map(([r, c]) => [r, [...c]])),
    );
    expect(lines.find((l) => l.includes('`editor`'))).toMatch(/yes \(document level only\)/);
  });

  it('refuses a region grant of any role but the four region roles, for every principal form', () => {
    const principals = ['user:u1', 'group:legal', 'everyone', 'role:role_tenant'];
    for (const role of DOC_ROLES)
      for (const principal of principals) {
        const problems = validateRegionGrant({
          region: 'rRegion000000001',
          principal,
          role,
          expiresAt: null,
        });
        if ((REGION_ROLES as readonly string[]).includes(role))
          expect(problems, `${role} ${principal}`).toEqual([]);
        else expect(problems.join(' '), `${role} ${principal}`).toMatch(/role must be one of/);
      }
    expect(
      validateRegionGrant({ region: 'x', principal: 'nobody', role: 'editor', expiresAt: 1.5 }),
    ).toHaveLength(3);
  });

  it('round-trips every scope form and refuses anything else', () => {
    for (const text of [
      'doc',
      'body',
      'defs',
      'defs:settings',
      'defs:style_def/Normal',
      'defs:page_setup/ps1',
      'region:rG7mK2pQ9xYt4HcD',
      'story:sHeader000000001',
      'field:fTenantName00001',
    ]) {
      const s = parseScope(text);
      expect(s, text).not.toBeNull();
      expect(formatScope(s!), text).toBe(text);
    }
    for (const bad of [
      '',
      'Doc',
      'body:x',
      'region:',
      'region:short',
      'region:rG7mK2pQ9xYt4HcD/x',
      'story:has space here!',
      'field:fTenantName0000100',
      'defs:',
      'defs:Style/Normal',
      'scope:x',
      'regions:rG7mK2pQ9xYt4HcD',
    ])
      expect(parseScope(bad), bad).toBeNull();
  });

  it('parses the four principal forms and refuses anything else', () => {
    for (const text of ['user:auth0|5f7c', 'group:legal-team', 'everyone', 'role:role_tenant']) {
      const p = parsePrincipal(text);
      expect(p, text).not.toBeNull();
      expect(formatPrincipal(p!), text).toBe(text);
    }
    for (const bad of [
      '',
      'Everyone',
      'everyone:x',
      'user:',
      'user:has space',
      'user:tab\there',
      'group:',
      'role:',
      'role:has/slash',
      'team:x',
      `user:${'x'.repeat(256)}`,
    ])
      expect(parsePrincipal(bad), bad).toBeNull();
  });
});
