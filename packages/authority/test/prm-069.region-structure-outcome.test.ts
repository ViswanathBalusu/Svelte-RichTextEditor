// Renaming a region and adding a style through a region grant, in the outcome check (PRM-069;
// 07 §5.2 P2, §5.3; ADR 0424; owner decision 279): both are allowed by the grant's `structure`
// list and by nothing else, and a commit that mixes either with anything else is refused whole.
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { Fragment, Slice } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import {
  type Connection,
  DOC_ROLES,
  type DocRole,
  type OperationId,
  type PermissionState,
  type RegionGrant,
  REGION_ROLES,
} from '../src/permissions/model.ts';
import { outcomeCheck } from '../src/permissions/outcome.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, baseDoc, basePermissions, posOf } from './fixtures.ts';
import {
  commitId,
  messages,
  rejection,
  roomWith,
  schema,
  verdictOf,
} from './permission-fixtures.ts';
import { applySteps } from '../src/rebase.ts';

const TERMS = 'rTerms000000000A';
const LEGAL = 'rLegal000000000B';
const NOTES = 'rNotes000000000C';
const NOW = 1_760_000_000_000;

type J = Record<string, unknown>;

const user = (sub: string, role: DocRole, extra: Partial<Connection> = {}): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
  ...extra,
});
/** A viewer in the document: all they may change comes from a grant. */
const RITA = user('rita', 'viewer');

/** The base document with a spare style that nothing uses, and optionally a style `Mine`. */
function docWith(extraStyles: string[] = []): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: J[] };
  const defs = json.content[0]!['content'] as J[];
  const at = defs.findIndex((d) => d['type'] === 'page_setup');
  for (const id of ['Spare', ...extraStyles])
    defs.splice(at, 0, {
      type: 'style_def',
      attrs: { id, kind: 'paragraph', name: id, basedOn: 'Normal' },
    });
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

const grant = (
  region: string,
  principal: string,
  structure: readonly OperationId[] | undefined,
  extra: Partial<RegionGrant> = {},
): RegionGrant => ({
  region,
  principal,
  role: 'editor',
  expiresAt: null,
  ...(structure ? { structure } : {}),
  ...extra,
});

const permsWith = (
  grants: RegionGrant[],
  extra: Partial<PermissionState> = {},
): PermissionState => ({
  ...basePermissions(),
  grants: [...basePermissions().grants, ...grants],
  ...extra,
});

const retitle =
  (id: string, title = 'Renamed') =>
  (doc: Node) => [new AttrStep(posOf(doc, id), 'title', title)];
const setAttr = (id: string, attr: string, value: unknown) => (doc: Node) => [
  new AttrStep(posOf(doc, id), attr, value),
];
const styleNode = (id: string) =>
  schema.nodes['style_def']!.create({ id, kind: 'paragraph', name: id, basedOn: 'Normal' });
const addStyle =
  (id: string, ...more: string[]) =>
  (doc: Node) => {
    const at = posOf(doc, 'ps1');
    return [
      new ReplaceStep(
        at,
        at,
        new Slice(Fragment.from([id, ...more].map((s) => styleNode(s))), 0, 0),
      ),
    ];
  };
const removeStyle = (id: string) => (doc: Node) => {
  const at = posOf(doc, id);
  return [new ReplaceStep(at, at + doc.nodeAt(at)!.nodeSize, Slice.empty)];
};
const both =
  (...makes: Array<(doc: Node) => Step[]>) =>
  (doc: Node) => {
    // Attribute steps do not move positions; an insertion goes last.
    const out: Step[] = [];
    let cur = doc;
    for (const m of makes) {
      const steps = m(cur);
      const r = applySteps(cur, steps);
      if (!r.ok) throw new Error(r.reason);
      cur = r.value.doc;
      out.push(...steps);
    }
    return out;
  };

const verdict = (
  conn: Connection,
  doc: Node,
  make: (doc: Node) => Step[],
  perms: PermissionState,
  more: { now?: number; isRetired?: (id: string) => boolean } = {},
) =>
  verdictOf(conn, doc, make, {
    perms,
    now: more.now ?? NOW,
    ...(more.isRetired ? { extra: { isRetired: more.isRetired } } : {}),
  });

describe('region.retitle through a grant (PRM-069, criterion 1)', () => {
  const listed = permsWith([grant(TERMS, 'user:rita', ['region.retitle'])]);

  it('accepts a change of the title of that region, and of nothing else, for a viewer', () => {
    const v = verdict(RITA, baseDoc(), retitle(TERMS), listed);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.scopes).toEqual([`region:${TERMS}`]);
  });

  it('refuses it without the listing, citing the operation', () => {
    for (const perms of [
      permsWith([grant(TERMS, 'user:rita', undefined)]),
      permsWith([grant(TERMS, 'user:rita', ['defs.add'])]),
      permsWith([grant(TERMS, 'user:rita', [])]),
    ]) {
      const v = verdict(RITA, baseDoc(), retitle(TERMS), perms);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe('permission_denied');
        expect(v.reason).toContain('`region.retitle` needs `structure`');
      }
    }
  });

  it("refuses another region's title, and a title the listing does not cover", () => {
    const v = verdict(RITA, baseDoc(), retitle(NOTES), listed);
    expect(v.ok).toBe(false);
    // Two regions: only one of them is covered.
    const grantTerms = permsWith([
      grant(TERMS, 'user:rita', ['region.retitle']),
      grant(NOTES, 'user:rita', undefined),
    ]);
    expect(
      verdict(RITA, baseDoc(), both(retitle(TERMS), retitle(NOTES, 'Other')), grantTerms).ok,
    ).toBe(false);
  });

  it('refuses it without `edit` in the region, with an expired grant and with a grant that conveys nothing', () => {
    // The region is approved: its holders may view and comment only (07 §4 limit 2).
    const approved = permsWith([grant(TERMS, 'user:rita', ['region.retitle'])], {
      regionStates: new Map([[TERMS, 'approved' as const]]),
    });
    expect(verdict(RITA, baseDoc(), retitle(TERMS), approved).ok).toBe(false);
    // Another person holds the lease.
    const leased = permsWith([grant(TERMS, 'user:rita', ['region.retitle'])], {
      leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 60_000 }],
    });
    expect(verdict(RITA, baseDoc(), retitle(TERMS), leased).ok).toBe(false);
    // Expired grants: at the instant, `expiresAt` no longer matches.
    const expiring = permsWith([grant(TERMS, 'user:rita', ['region.retitle'], { expiresAt: NOW })]);
    expect(verdict(RITA, baseDoc(), retitle(TERMS), expiring, { now: NOW - 1 }).ok).toBe(true);
    const e = verdict(RITA, baseDoc(), retitle(TERMS), expiring, { now: NOW });
    expect(e.ok).toBe(false);
    // A grant of another person, of a group the user is not in, or of `everyone` on a restricted region.
    for (const principal of ['user:someone', 'group:nobody'])
      expect(
        verdict(
          RITA,
          baseDoc(),
          retitle(TERMS),
          permsWith([grant(TERMS, principal, ['region.retitle'])]),
        ).ok,
        principal,
      ).toBe(false);
    expect(
      verdict(
        RITA,
        baseDoc(),
        retitle(LEGAL),
        permsWith([grant(LEGAL, 'everyone', ['region.retitle'])]),
      ).ok,
    ).toBe(false);
    // A grant to a group the user belongs to, and to `everyone` on an inherit region, count.
    const member = user('rita', 'viewer', { groups: ['editors'] });
    expect(
      verdict(
        member,
        baseDoc(),
        retitle(TERMS),
        permsWith([grant(TERMS, 'group:editors', ['region.retitle'])]),
      ).ok,
    ).toBe(true);
    expect(
      verdict(
        RITA,
        baseDoc(),
        retitle(TERMS),
        permsWith([grant(TERMS, 'everyone', ['region.retitle'])]),
      ).ok,
    ).toBe(true);
  });

  it('is limited to an editor grant, an active document and a person (not an agent)', () => {
    // A listing on any other role conveys nothing (validation refuses it; a stored one fails closed).
    for (const role of ['viewer', 'commenter', 'suggester'] as const) {
      const odd = permsWith([
        { ...grant(TERMS, 'user:rita', ['region.retitle']), role: role as RegionGrant['role'] },
      ]);
      expect(verdict(RITA, baseDoc(), retitle(TERMS), odd).ok, role).toBe(false);
    }
    const locked = { ...listed, documentState: 'locked' as const };
    expect(verdict(RITA, baseDoc(), retitle(TERMS), locked).ok).toBe(false);
    const agent = user('rita', 'viewer', { agent: 'assistant' });
    expect(verdict(agent, baseDoc(), retitle(TERMS), listed).ok).toBe(false);
  });

  it('leaves the document-level path as it was', () => {
    const none = permsWith([]);
    expect(verdict(user('carol', 'editor'), baseDoc(), retitle(TERMS), none).ok).toBe(true);
    expect(verdict(user('alice', 'owner'), baseDoc(), retitle(NOTES), none).ok).toBe(true);
    expect(verdict(user('dave', 'suggester'), baseDoc(), retitle(TERMS), none).ok).toBe(false);
  });
});

describe('defs.add through a grant (PRM-069, criterion 2)', () => {
  const listed = permsWith([grant(TERMS, 'user:rita', ['defs.add'])]);

  it('accepts a new style_def whose identifier no earlier commit used', () => {
    const v = verdict(RITA, docWith(), addStyle('Mine'), listed);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.scopes).toContain('defs:style_def/Mine');
    // Several at once, and applied in a region the user may edit.
    expect(verdict(RITA, docWith(), addStyle('Mine', 'Yours'), listed).ok).toBe(true);
    const apply = both(addStyle('Mine'), setAttr('pTerms000000001A', 'style', 'Mine'));
    expect(verdict(RITA, docWith(), apply, listed).ok).toBe(true);
  });

  it('refuses it without the listing', () => {
    for (const perms of [
      permsWith([grant(TERMS, 'user:rita', undefined)]),
      permsWith([grant(TERMS, 'user:rita', ['region.retitle'])]),
    ]) {
      const v = verdict(RITA, docWith(), addStyle('Mine'), perms);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toContain('needs `structure`');
    }
  });

  it('refuses a change to an existing definition, and the removal of any style', () => {
    expect(verdict(RITA, docWith(), setAttr('Spare', 'name', 'Other'), listed).ok).toBe(false);
    expect(verdict(RITA, docWith(), setAttr('Heading1', 'color', '#00AA00'), listed).ok).toBe(
      false,
    );
    expect(verdict(RITA, docWith(), removeStyle('Spare'), listed).ok).toBe(false);
    // A style they added themselves, in an earlier commit, is an existing definition by now.
    expect(verdict(RITA, docWith(['Mine']), removeStyle('Mine'), listed).ok).toBe(false);
    expect(verdict(RITA, docWith(['Mine']), setAttr('Mine', 'name', 'X'), listed).ok).toBe(false);
    // An addition that also removes one.
    expect(verdict(RITA, docWith(), both(addStyle('Mine'), removeStyle('Spare')), listed).ok).toBe(
      false,
    );
  });

  it('refuses a style whose identifier an earlier commit retired', () => {
    const doc = docWith();
    const retired = (id: string) => id === 'defs:style_def/Mine';
    const v = verdict(RITA, doc, addStyle('Mine'), listed, { isRetired: retired });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('defs.add');
      expect(v.scopes).toContain('defs:style_def/Mine');
    }
    expect(verdict(RITA, doc, addStyle('Yours'), listed, { isRetired: retired }).ok).toBe(true);
    // A user with `structure` is not bound by the rule: it is part of `defs.add` alone.
    expect(
      verdict(user('carol', 'editor'), doc, addStyle('Mine'), listed, { isRetired: retired }).ok,
    ).toBe(true);
  });

  it('refuses any other kind of definition and any other change to the definitions node', () => {
    const numbering = (doc: Node) => {
      const at = posOf(doc, 'ps1');
      const n = schema.nodes['numbering_def']!.create({
        id: 'numX',
        levels: [
          {
            format: 'decimal',
            text: '%1.',
            start: 1,
            restartAfter: null,
            legal: false,
            indentLeft: 720,
            hanging: 360,
            align: 'start',
            bulletChar: null,
            runProps: null,
          },
        ],
      });
      return [new ReplaceStep(at, at, new Slice(Fragment.from(n), 0, 0))];
    };
    expect(verdict(RITA, docWith(), numbering, listed).ok).toBe(false);
    // A style added at the same time as a change of the page setup.
    expect(
      verdict(
        RITA,
        docWith(),
        both(addStyle('Mine'), setAttr('ps1', 'orientation', 'landscape')),
        listed,
      ).ok,
    ).toBe(false);
  });
});

describe('a commit that mixes an allowed operation with one that is not is refused whole (criterion 3)', () => {
  const both2 = permsWith([grant(TERMS, 'user:rita', ['region.retitle', 'defs.add'])]);

  it('accepts each operation alone and both together', () => {
    expect(verdict(RITA, docWith(), retitle(TERMS), both2).ok).toBe(true);
    expect(verdict(RITA, docWith(), addStyle('Mine'), both2).ok).toBe(true);
    expect(verdict(RITA, docWith(), both(retitle(TERMS), addStyle('Mine')), both2).ok).toBe(true);
  });

  it('refuses a rename or a style together with a page setup change', () => {
    const doc = docWith();
    for (const [name, mixed] of [
      ['rename + page setup', both(retitle(TERMS), setAttr('ps1', 'orientation', 'landscape'))],
      ['style + page setup', both(addStyle('Mine'), setAttr('ps1', 'orientation', 'landscape'))],
      ['rename + style change', both(retitle(TERMS), setAttr('Spare', 'name', 'Other'))],
    ] as const) {
      expect(verdict(RITA, doc, mixed, both2).ok, name).toBe(false);
    }
  });

  it('refuses a rename or a style together with a region created or removed, or a policy flip', () => {
    const doc = docWith();
    const removeRegion = (id: string) => (d: Node) => {
      const at = posOf(d, id);
      return [new ReplaceStep(at, at + d.nodeAt(at)!.nodeSize, Slice.empty)];
    };
    const v = verdict(RITA, doc, both(retitle(TERMS), removeRegion(NOTES)), both2);
    expect(v.ok).toBe(false);
    const w = verdict(RITA, doc, both(addStyle('Mine'), removeRegion(TERMS)), both2);
    expect(w.ok).toBe(false);
    const policy = verdict(
      RITA,
      doc,
      both(retitle(TERMS), setAttr(TERMS, 'policy', 'restricted')),
      both2,
    );
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.reason).toContain('`region.policy` needs `manage`');
  });
});

describe('the grants as they stood at the commit (PRM-069, criterion 4; 04 G7)', () => {
  it('accepts a commit checked before the revocation and refuses one checked after it', () => {
    const perms = permsWith([grant(TERMS, 'user:rita', ['region.retitle', 'defs.add'])], {
      revision: 3,
    });
    const doc = docWith();
    const room = roomWith(doc, perms);
    room.open('r1', RITA);
    // Under revision 3: accepted, and stamped with the revision it was checked against.
    const first = room.submit('r1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(retitle(TERMS)(doc)),
    });
    expect(rejection(first, 'r1')).toBeNull();
    expect(first.write?.commits[0]).toMatchObject({ revision: 3, scopes: [`region:${TERMS}`] });
    room.writeCompleted({ status: 'ok' });
    // The grant is revoked (revision 4). A commit that comes after is refused.
    const revoked = permsWith([], { revision: 4 });
    room.permissionsChanged(revoked);
    room.writeCompleted({ status: 'ok' });
    const after = room.submit('r1', {
      id: commitId(),
      base: room.head,
      steps: stepsToJson(retitle(TERMS, 'Again')(room.document)),
    });
    expect(rejection(after, 'r1')).toMatchObject({ code: 'permission_denied' });
    const style = room.submit('r1', {
      id: commitId(),
      base: room.head,
      steps: stepsToJson(addStyle('Mine')(room.document)),
    });
    expect(rejection(style, 'r1')).toMatchObject({ code: 'permission_denied' });
    expect(messages(after, 'r1').some((m) => m.t === 'sync.ack')).toBe(false);
  });

  it('does not store a commit under a revision that moved while it was written', () => {
    const perms = permsWith([grant(TERMS, 'user:rita', ['region.retitle'])], { revision: 3 });
    const doc = docWith();
    const room = roomWith(doc, perms);
    room.open('r1', RITA);
    room.submit('r1', { id: commitId(), base: 0, steps: stepsToJson(retitle(TERMS)(doc)) });
    const done = room.writeCompleted({
      status: 'revision_moved',
      perms: permsWith([], { revision: 4 }),
    });
    expect(rejection(done, 'r1')).toMatchObject({ code: 'unavailable', action: 'retry' });
  });

  it('retires the identifier of a removed style, so that defs.add cannot bring it back', () => {
    const perms = permsWith([grant(TERMS, 'user:rita', ['defs.add'])]);
    const doc = docWith();
    const room = roomWith(doc, perms);
    room.open('a1', user('alice', 'owner'));
    room.open('r1', RITA);
    const removed = room.submit('a1', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(removeStyle('Spare')(doc)),
    });
    expect(removed.write?.commits[0]?.retired).toEqual(['defs:style_def/Spare']);
    // While the removal is still being written, and once it is stored.
    const removedDoc = applySteps(doc, removeStyle('Spare')(doc));
    if (!removedDoc.ok) throw new Error(removedDoc.reason);
    const again = (base: number, at: Node) =>
      room.submit('r1', {
        id: commitId(),
        base,
        steps: stepsToJson(addStyle('Spare')(at)),
      });
    expect(rejection(again(1, removedDoc.value.doc), 'r1')).toMatchObject({
      code: 'permission_denied',
    });
    room.writeCompleted({ status: 'ok' });
    expect(rejection(again(1, room.document), 'r1')).toMatchObject({ code: 'permission_denied' });
    const fresh = room.submit('r1', {
      id: commitId(),
      base: 1,
      steps: stepsToJson(addStyle('Fresh')(room.document)),
    });
    expect(rejection(fresh, 'r1')).toBeNull();
  });
});

// -- an oracle written from 07 and ADR 0424, not from the code -----------------------------------

interface Case {
  role: DocRole;
  /** Grants of the user's own and of others, on the three regions. */
  grants: Array<{
    region: string;
    who: 'self' | 'other' | 'inGroup' | 'outGroup' | 'everyone' | 'roleSlot';
    role: RegionGrant['role'];
    structure: OperationId[];
    expiry: 'none' | 'past' | 'future';
  }>;
  operation: 'retitleTerms' | 'retitleLegal' | 'retitleNotes' | 'addStyle';
  termsApproved: boolean;
}

const POLICY: Record<string, 'inherit' | 'restricted'> = {
  [TERMS]: 'inherit',
  [LEGAL]: 'restricted',
  [NOTES]: 'inherit',
};

function oracle(c: Case): boolean {
  const privileged = c.role === 'editor' || c.role === 'owner';
  // Grants that apply: the right person, not expired, and not `everyone` on a restricted region.
  const applying = c.grants.filter(
    (g) =>
      (g.who === 'self' || g.who === 'inGroup' || g.who === 'everyone') &&
      g.expiry !== 'past' &&
      !(g.who === 'everyone' && POLICY[g.region] === 'restricted'),
  );
  const listing = (region: string | null, op: OperationId) =>
    applying.some(
      (g) =>
        (region === null || g.region === region) && g.role === 'editor' && g.structure.includes(op),
    );
  const editIn = (region: string): boolean => {
    if (region === TERMS && c.termsApproved) return false; // approved: view and comment only
    if (c.role === 'owner') return true;
    const grantEdit = applying.some((g) => g.region === region && g.role === 'editor');
    if (POLICY[region] === 'inherit') return c.role === 'editor' || grantEdit;
    return grantEdit; // restricted: only a grant conveys edit
  };
  switch (c.operation) {
    case 'addStyle': {
      if (privileged) return true;
      // P6: a connection that can only view and comment submits nothing, whatever it is granted.
      const submits =
        c.role === 'suggester' ||
        c.role === 'filler' ||
        applying.some(
          (g) =>
            (g.role === 'editor' || g.role === 'suggester') &&
            !(g.region === TERMS && c.termsApproved),
        );
      return submits && listing(null, 'defs.add');
    }
    default: {
      const region =
        c.operation === 'retitleTerms' ? TERMS : c.operation === 'retitleLegal' ? LEGAL : NOTES;
      if (!editIn(region)) return false;
      return privileged || listing(region, 'region.retitle');
    }
  }
}

function connection(c: Case): { conn: Connection; perms: PermissionState } {
  const conn = user('pat', c.role, { groups: ['team'] });
  const principals: Record<Case['grants'][number]['who'], string> = {
    self: 'user:pat',
    other: 'user:quinn',
    inGroup: 'group:team',
    outGroup: 'group:strangers',
    everyone: 'everyone',
    roleSlot: 'role:role_tenant',
  };
  const grants: RegionGrant[] = c.grants.map((g) => ({
    region: g.region,
    principal: principals[g.who],
    role: g.role,
    expiresAt: g.expiry === 'none' ? null : g.expiry === 'past' ? NOW - 1 : NOW + 1,
    ...(g.structure.length ? { structure: g.structure } : {}),
  }));
  return {
    conn,
    perms: {
      ...basePermissions(),
      grants,
      regionStates: c.termsApproved ? new Map([[TERMS, 'approved' as const]]) : new Map(),
    },
  };
}

describe('every role and principal pair agrees with an oracle (PRM-069, criterion 5)', () => {
  const region = fc.constantFrom(TERMS, LEGAL, NOTES);
  const WHO = ['self', 'other', 'inGroup', 'outGroup', 'everyone', 'roleSlot'] as const;
  const arbitrary: fc.Arbitrary<Case> = fc.record({
    role: fc.constantFrom(...DOC_ROLES),
    grants: fc.array(
      fc.record({
        region,
        who: fc.constantFrom(...WHO),
        role: fc.constantFrom(...REGION_ROLES),
        structure: fc.subarray(['region.retitle', 'defs.add'] as OperationId[]),
        expiry: fc.constantFrom(...(['none', 'past', 'future'] as const)),
      }),
      { maxLength: 4 },
    ),
    operation: fc.constantFrom(
      ...(['retitleTerms', 'retitleLegal', 'retitleNotes', 'addStyle'] as const),
    ),
    termsApproved: fc.boolean(),
  });

  it('accepts exactly what 07 and ADR 0424 allow', () => {
    const doc = docWith();
    fc.assert(
      fc.property(arbitrary, (c) => {
        const { conn, perms } = connection(c);
        const make =
          c.operation === 'addStyle'
            ? addStyle('Mine')
            : retitle(
                c.operation === 'retitleTerms'
                  ? TERMS
                  : c.operation === 'retitleLegal'
                    ? LEGAL
                    : NOTES,
              );
        const v = verdict(conn, doc, make, perms);
        // A viewer-only person with no grant cannot submit at all (P6); the oracle agrees.
        return v.ok === oracle(c);
      }),
      { numRuns: 600 },
    );
  });

  it('reads no grant for a commit that needs no structure (PRM-016)', () => {
    const doc = docWith();
    const perms = permsWith([grant(TERMS, 'user:rita', ['region.retitle', 'defs.add'])]);
    const access = computeAccess(RITA, regionInfos(doc), perms, NOW);
    let reads = 0;
    const watched = {
      ...access,
      get structureGrants() {
        reads++;
        return access.structureGrants;
      },
    };
    const typing = (d: Node) => {
      const at = posOf(d, 'pTerms000000001A') + 1;
      return [new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('x')), 0, 0))];
    };
    const steps = typing(doc);
    const r = applySteps(doc, steps);
    if (!r.ok) throw new Error(r.reason);
    const poisoned: PermissionState = {
      ...perms,
      get grants(): readonly RegionGrant[] {
        throw new Error('the grants were read');
      },
    };
    const v = outcomeCheck({
      before: doc,
      after: r.value.doc,
      user: RITA.sub,
      access: watched,
      perms: poisoned,
      suggestionOwners: new Map(),
      fieldsChangedSinceBase: new Set(),
      serverAuthored: false,
      origin: 'input',
    });
    expect(v.ok).toBe(true);
    expect(reads).toBe(0);
    // A rename does read the access, and still never the stored grants.
    const rename = applySteps(doc, retitle(TERMS)(doc));
    if (!rename.ok) throw new Error(rename.reason);
    const w = outcomeCheck({
      before: doc,
      after: rename.value.doc,
      user: RITA.sub,
      access: watched,
      perms: poisoned,
      suggestionOwners: new Map(),
      fieldsChangedSinceBase: new Set(),
      serverAuthored: false,
      origin: 'input',
    });
    expect(w.ok).toBe(true);
    expect(reads).toBeGreaterThan(0);
  });
});
