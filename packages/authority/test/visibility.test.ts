// Who may read what (ADR 0019, proposed; PRM-066, PRM-067, FRW-088): the hidden set of a connection
// agrees with an oracle written from 07 §4 and 12 §3.2 with ADR 0019, owners read everything, the
// function is pure, connections with equal results share a class, and a value marked sensitive by
// a user with `manage` reaches only its readers.
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Connection, PermissionState, RegionGrant } from '../src/permissions/model.ts';
import { hiddenSet, visibility } from '../src/permissions/visibility.ts';
import {
  REDACTED,
  project,
  projectionSchema,
  visibilityKey,
} from '../src/projection/projection.ts';
import { stepsToJson } from '../src/steps.ts';
import { posOf } from './fixtures.ts';
import {
  FIELDS,
  MORE,
  USERS,
  commitId,
  fieldsDoc,
  morePermissions,
  roomWith,
  schema,
} from './permission-fixtures.ts';

type J = Record<string, unknown>;
const NOW = 1_760_000_000_000;

// -- the oracle, written from the text -------------------------------------------------------------

/** 07 §4: "A grant matches when its principal is user:<sub>, group:<g> for some g in grp, everyone,
 * or a role: the user's participant holds, and it has not expired." Grants use the four region roles. */
function matches(g: RegionGrant, conn: Connection, now: number, workflowActive: boolean): boolean {
  if (!['viewer', 'commenter', 'suggester', 'editor'].includes(g.role)) return false;
  if (g.expiresAt !== null && !(now < g.expiresAt)) return false;
  return (
    g.principal === 'everyone' ||
    g.principal === `user:${conn.sub}` ||
    (g.principal.startsWith('group:') &&
      conn.groups.includes(g.principal.slice('group:'.length))) ||
    // A role placeholder matches only in an active workflow (07 §1; PRM-023 criterion 2).
    (g.principal.startsWith('role:') &&
      workflowActive &&
      conn.participantRoles.includes(g.principal.slice('role:'.length)))
  );
}

/** ADR 0019: a confidential region is read by "principals with a read grant" and "unless they hold
 * manage"; in version 1 only owners hold manage (07 §2). Other regions are read by everyone. */
function oracleReadsRegion(
  conn: Connection,
  perms: PermissionState,
  region: Node,
  now: number,
): boolean {
  if (region.attrs['policy'] !== 'confidential') return true;
  if (conn.role === 'owner') return true;
  return perms.grants.some(
    (g) => g.region === region.attrs['id'] && matches(g, conn, now, perms.workflowActive),
  );
}

/** ADR 0019: "Proposed readers: the field's assignee role, users with manage, and principals named
 * by a grant" (grants exist on regions only: ADR 0033). */
function oracleReadsValue(
  conn: Connection,
  perms: PermissionState,
  field: Node,
  region: string | null,
  now: number,
): boolean {
  if (field.attrs['sensitive'] !== true) return true;
  if (conn.role === 'owner') return true;
  const assignee = field.attrs['assignee'];
  if (typeof assignee === 'string' && conn.participantRoles.includes(assignee)) return true;
  return (
    region !== null &&
    perms.grants.some((g) => g.region === region && matches(g, conn, now, perms.workflowActive))
  );
}

function oracle(conn: Connection, doc: Node, perms: PermissionState, now: number) {
  const regions: string[] = [];
  const values: string[] = [];
  const fields = (n: Node, region: string | null) =>
    n.descendants((x) => {
      if (x.type.name === 'form_field' && !oracleReadsValue(conn, perms, x, region, now))
        values.push(String(x.attrs['id']));
      return true;
    });
  doc.forEach((top) => {
    if (top.type.name === 'story') fields(top, null);
    if (top.type.name !== 'body') return;
    top.forEach((b) => {
      if (b.type.name !== 'region') return fields(b, null);
      if (oracleReadsRegion(conn, perms, b, now)) fields(b, String(b.attrs['id']));
      else regions.push(String(b.attrs['id'])); // its values go with it
    });
  });
  return { regions: regions.sort(), values: values.sort() };
}

// -- generated inputs ------------------------------------------------------------------------------

const REGIONS = ['rTerms000000000A', 'rLegal000000000B', 'rNotes000000000C'];
const POLICIES = ['inherit', 'restricted', 'confidential'] as const;
const PRINCIPALS = [
  'user:u1',
  'user:u2',
  'group:legal',
  'group:hr',
  'everyone',
  'role:role_tenant',
  'role:role_landlord',
];
const ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'filler', 'owner'] as const;

/** The fields fixture with each region's policy and each field's sensitivity chosen. */
function docWith(policies: readonly number[], sensitive: readonly boolean[]): Node {
  const doc = fieldsDoc();
  const json = doc.toJSON() as J;
  const body = (json['content'] as J[])[1]!['content'] as J[];
  let i = 0;
  for (const b of body)
    if (b['type'] === 'region') (b['attrs'] as J)['policy'] = POLICIES[(policies[i++] ?? 0) % 3];
  let k = 0;
  const walk = (n: J) => {
    if (n['type'] === 'form_field')
      (n['attrs'] as J)['sensitive'] = sensitive[k++ % sensitive.length] ?? false;
    for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
  };
  walk(json);
  return schema.nodeFromJSON(json);
}

const grant = fc.record({
  region: fc.constantFrom(...REGIONS),
  principal: fc.constantFrom(...PRINCIPALS),
  role: fc.constantFrom('viewer', 'commenter', 'suggester', 'editor', 'filler', 'owner'),
  expiresAt: fc.option(fc.integer({ min: NOW - 2, max: NOW + 2 }), { nil: null }),
});
const connection = fc.record({
  sub: fc.constantFrom('u1', 'u2', 'u3'),
  session: fc.constant('s'),
  role: fc.constantFrom(...ROLES),
  groups: fc.subarray(['legal', 'hr']),
  participantRoles: fc.subarray(['role_tenant', 'role_landlord']),
  participantActive: fc.boolean(),
});
const state = fc.record({
  grants: fc.array(grant, { maxLength: 6 }),
  documentState: fc.constantFrom('active', 'locked', 'archived'),
  approved: fc.subarray(REGIONS),
  lease: fc.option(fc.constantFrom(...REGIONS), { nil: null }),
});

type State = typeof state extends fc.Arbitrary<infer T> ? T : never;

function permsOf(s: State): PermissionState {
  return {
    revision: 1,
    grants: s.grants as RegionGrant[],
    regionStates: new Map(s.approved.map((r) => [r, 'approved' as const])),
    leases: s.lease ? [{ region: s.lease, holder: 'u9', expiresAt: NOW + 10 }] : [],
    documentState: s.documentState,
    workflowActive: false,
  };
}

describe('the hidden set of a connection (PRM-067)', () => {
  it('agrees with an independent oracle over random grants, roles, participants and expiries', () => {
    let hiddenRegions = 0;
    let hiddenValues = 0;
    let readers = 0;
    fc.assert(
      fc.property(
        connection,
        state,
        fc.array(fc.nat(2), { minLength: 3, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 13 }),
        (conn, s, policies, sensitive) => {
          const doc = docWith(policies, sensitive);
          const perms = permsOf(s);
          const got = hiddenSet(conn, doc, perms, NOW);
          const want = oracle(conn, doc, perms, NOW);
          expect({ regions: [...got.regions].sort(), values: [...got.values].sort() }).toEqual(
            want,
          );
          expect(got.titles).toBe(false);
          hiddenRegions += want.regions.length;
          hiddenValues += want.values.length;
          if (want.regions.length === 0 && want.values.length === 0) readers++;
        },
      ),
      { numRuns: 2000 },
    );
    // Not vacuous: regions and values were hidden, and some connections read everything.
    expect(hiddenRegions).toBeGreaterThan(300);
    expect(hiddenValues).toBeGreaterThan(300);
    expect(readers).toBeGreaterThan(100);
  });

  it('is pure: equal inputs give equal results and nothing is mutated', () => {
    fc.assert(
      fc.property(
        connection,
        state,
        fc.array(fc.nat(2), { minLength: 3, maxLength: 3 }),
        (conn, s, p) => {
          const doc = docWith(p, [true, false]);
          const perms = permsOf(s);
          const before = JSON.stringify({
            doc: doc.toJSON(),
            perms: { ...perms, regionStates: [...perms.regionStates] },
            conn,
          });
          const a = hiddenSet(conn, doc, perms, NOW);
          const b = hiddenSet(conn, doc, perms, NOW);
          expect(a).toEqual(b);
          expect(visibilityKey(a)).toBe(visibilityKey(b));
          const after = JSON.stringify({
            doc: doc.toJSON(),
            perms: { ...perms, regionStates: [...perms.regionStates] },
            conn,
          });
          expect(after).toBe(before);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('puts connections with equal results in one visibility class, with one projection', () => {
    const doc = docWith([2, 2, 0], [true]);
    const perms = morePermissions();
    // Two editors without grants, one of them in another group: the same hidden set.
    const a = hiddenSet(USERS.carol, doc, perms, NOW);
    const b = hiddenSet({ ...USERS.mallory, groups: ['hr'] }, doc, perms, NOW);
    expect(visibilityKey(a)).toBe(visibilityKey(b));
    expect(project(doc, a).doc.eq(project(doc, b).doc)).toBe(true);
    // Bob's group grant on Legal puts him in another class.
    expect(visibilityKey(hiddenSet(USERS.bob, doc, perms, NOW))).not.toBe(visibilityKey(a));
  });

  it('reads the time from the clock it is given, so that an expired grant stops conveying view', () => {
    const doc = docWith([2, 0, 0], [false]);
    const perms: PermissionState = {
      ...morePermissions(),
      grants: [
        { region: 'rTerms000000000A', principal: 'user:carol', role: 'viewer', expiresAt: NOW + 5 },
      ],
    };
    let now = NOW;
    const v = visibility(() => now);
    expect(v(USERS.carol, doc, perms).regions.has('rTerms000000000A')).toBe(false);
    now = NOW + 5;
    expect(v(USERS.carol, doc, perms).regions.has('rTerms000000000A')).toBe(true);
    expect(visibility(() => now, { titles: true })(USERS.carol, doc, perms).titles).toBe(true);
  });
});

describe('confidential regions and their readers (PRM-066)', () => {
  it('lets owners read every region and every value', () => {
    fc.assert(
      fc.property(
        state,
        fc.array(fc.nat(2), { minLength: 3, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 1 }),
        (s, p, sens) => {
          const h = hiddenSet(USERS.alice, docWith(p, sens), permsOf(s), NOW);
          expect(h.regions.size + h.values.size).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('shows a confidential region to grant holders of any role and a placeholder to everyone else', () => {
    const doc = docWith([2, 1, 0], [false]); // Terms confidential, Legal restricted, Notes inherit
    const perms: PermissionState = {
      ...morePermissions(),
      grants: [
        ...morePermissions().grants,
        { region: 'rTerms000000000A', principal: 'group:legal', role: 'viewer', expiresAt: null },
      ],
    };
    // Rita holds an editor grant on Terms, Bob reads it through his group's viewer grant.
    for (const reader of [USERS.alice, MORE.rita, USERS.bob])
      expect(hiddenSet(reader, doc, perms, NOW).regions.has('rTerms000000000A'), reader.sub).toBe(
        false,
      );
    for (const other of [USERS.carol, USERS.dave, USERS.erin, USERS.frank]) {
      const h = hiddenSet(other, doc, perms, NOW);
      expect([...h.regions], other.sub).toEqual(['rTerms000000000A']);
      const p = project(doc, h, projectionSchema()).doc;
      let placeholder = false;
      p.child(p.childCount - 1).forEach((c) => {
        if (c.type.name === 'hidden_region') placeholder = true;
        expect(c.attrs['id'] === 'rTerms000000000A' && c.type.name === 'region').toBe(false);
      });
      expect(placeholder).toBe(true);
      expect(JSON.stringify(p.toJSON())).not.toContain('Rent is due monthly');
    }
    // Restricted and inherit regions stay readable by everyone (07 §1).
    expect(hiddenSet(USERS.frank, doc, perms, NOW).regions.has('rLegal000000000B')).toBe(false);
  });
});

describe('making a region confidential through the room (PRM-066)', () => {
  it('lets a user with manage set it, and then only grant holders and manage read it', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions(), () => NOW);
    room.open('a1', USERS.alice);
    room.open('c1', USERS.carol);
    const confidential = [new AttrStep(posOf(doc, 'rTerms000000000A'), 'policy', 'confidential')];
    // An editor without manage is refused; the owner is not.
    const refusedFx = room.submit('c1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(confidential),
    });
    expect(refusedFx.send.find((o) => o.channel === 'c1')?.msg).toMatchObject({
      t: 'sync.reject',
      code: 'permission_denied',
      scopes: ['region:rTerms000000000A'],
    });
    const fx = room.submit('a1', { id: commitId(), base: 0, steps: stepsToJson(confidential) });
    expect(fx.write?.commits).toHaveLength(1);
    room.writeCompleted({ status: 'ok' });
    const after = room.document;
    expect(after.nodeAt(posOf(after, 'rTerms000000000A'))!.attrs['policy']).toBe('confidential');
    // Rita holds an editor grant on Terms; Alice is the owner. Everyone else sees a placeholder.
    for (const reader of [USERS.alice, MORE.rita])
      expect(hiddenSet(reader, after, room.permissions, NOW).regions.size, reader.sub).toBe(0);
    for (const other of [USERS.bob, USERS.carol, USERS.dave, USERS.erin, USERS.frank]) {
      const h = hiddenSet(other, after, room.permissions, NOW);
      expect([...h.regions], other.sub).toEqual(['rTerms000000000A']);
      const text = JSON.stringify(project(after, h).doc.toJSON());
      expect(text, other.sub).toContain('hidden_region');
      expect(text, other.sub).not.toContain('Rent is due monthly');
    }
  });
});

describe('a sensitive value reaches only its readers (FRW-088)', () => {
  it('after a user with manage marks it sensitive, redacts it for everyone but its readers', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions(), () => NOW);
    room.open('a1', USERS.alice);
    const mark = [new AttrStep(posOf(doc, FIELDS.tenantName), 'sensitive', true)];
    const filled = [new AttrStep(posOf(doc, FIELDS.tenantName), 'value', 'Ada Lovelace')];
    const fx = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([...filled, ...mark]),
    });
    expect(fx.write?.commits).toHaveLength(1);
    room.writeCompleted({ status: 'ok' });
    const after = room.document;
    // The tenant name sits in Legal: its readers are the owner, holders of role_tenant (Erin) and
    // principals with a grant on Legal (Bob through the legal group, Dave through his own grant).
    const readers = [USERS.alice, USERS.erin, USERS.bob, USERS.dave];
    const others = [USERS.carol, USERS.frank, USERS.mallory, MORE.rita, MORE.lena];
    for (const u of [...readers, ...others]) {
      const h = hiddenSet(u, after, room.permissions, NOW);
      const projected = project(after, h).doc;
      let value: unknown;
      projected.descendants((n) => {
        if (n.type.name === 'form_field' && n.attrs['id'] === FIELDS.tenantName)
          value = n.attrs['value'];
        return true;
      });
      if (readers.includes(u)) expect(value, u.sub).toBe('Ada Lovelace');
      else expect(value, u.sub).toEqual(REDACTED);
    }
    // The full document keeps the value: redaction is in the projection only.
    expect(JSON.stringify(after.toJSON())).toContain('Ada Lovelace');
  });

  it('refuses the change to sensitive in the room for a user without manage', () => {
    const doc = fieldsDoc();
    const room = roomWith(doc, morePermissions(), () => NOW);
    room.open('b1', USERS.bob);
    const fx = room.submit('b1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([new AttrStep(posOf(doc, FIELDS.tenantName), 'sensitive', true)]),
    });
    expect(fx.write).toBeNull();
    const reject = fx.send.find((o) => o.channel === 'b1' && o.msg.t === 'sync.reject')?.msg;
    expect(reject).toMatchObject({
      code: 'permission_denied',
      scopes: [`field:${FIELDS.tenantName}`],
    });
  });
});
