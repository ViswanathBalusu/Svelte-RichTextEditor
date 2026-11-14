// Leases (07 §10; PRM-043 to PRM-045), region states (07 §11; PRM-046, PRM-047) and restores
// (07 §13; 08 §8; PRM-049, PRM-050): the authority's rules and the room's part.
import { canonicalize, documentHash, sha256Hex } from '@docedit/model';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { computeAccess } from '../src/permissions/access.ts';
import { LEASE_DEFAULTS, acquireLease, endLease, renewLease } from '../src/permissions/leases.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { planRestoreDefinitions } from '../src/permissions/restore.ts';
import { approvalHash, regionCanonicalText, setRegionState } from '../src/permissions/states.ts';
import { regionInfos } from '../src/permissions/visibility.ts';
import { applySteps } from '../src/rebase.ts';
import type { Effects } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  BASE_JSON,
  USERS,
  baseDoc,
  basePermissions,
  posInside,
  posOf,
  schema,
} from './fixtures.ts';
import {
  FIELDS,
  MORE,
  commitId,
  fieldsDoc,
  messages,
  morePermissions,
  rejection,
  roomWith,
} from './permission-fixtures.ts';

const TERMS = 'rTerms000000000A';
const NOW = 1_770_700_000_000;
const access = (conn: Connection, perms: PermissionState, doc = baseDoc(), now = NOW) =>
  computeAccess(conn, regionInfos(doc), perms, now);
const typeAt = (doc: Node, at: string, text: string) => {
  const pos = posInside(doc, at);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};
const submit = (room: ReturnType<typeof roomWith>, channel: string, base: number, steps: Step[]) =>
  room.submit(channel, { id: commitId(), base, steps: stepsToJson(steps) });
const store = (room: ReturnType<typeof roomWith>): Effects => {
  const all: Effects = { send: [], write: null };
  for (
    let fx = room.writeCompleted({ status: 'ok' });
    ;
    fx = room.writeCompleted({ status: 'ok' })
  ) {
    all.send.push(...fx.send);
    if (!fx.write) break;
  }
  return all;
};

describe('acquiring and releasing a lease (PRM-043)', () => {
  it('gives a lease with an identifier, the holder and the default expiry to a user with edit', () => {
    const perms = basePermissions();
    const v = acquireLease({
      access: access(USERS.carol, perms),
      perms,
      region: TERMS,
      holder: 'carol',
      now: NOW,
      id: 'lease-1',
    });
    expect(v).toMatchObject({
      ok: true,
      lease: {
        id: 'lease-1',
        region: TERMS,
        holder: 'carol',
        expiresAt: NOW + LEASE_DEFAULTS.durationMs,
        acquiredAt: NOW,
      },
    });
  });

  it('refuses a user without edit, an approved region, and a region another user holds', () => {
    const perms = basePermissions();
    expect(
      acquireLease({
        access: access(USERS.dave, perms),
        perms,
        region: TERMS,
        holder: 'dave',
        now: NOW,
        id: 'l',
      }).ok,
    ).toBe(false);
    const approved = { ...perms, regionStates: new Map([[TERMS, 'approved' as const]]) };
    expect(
      acquireLease({
        access: access(USERS.alice, approved),
        perms: approved,
        region: TERMS,
        holder: 'alice',
        now: NOW,
        id: 'l',
      }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
    const held = {
      ...perms,
      leases: [{ region: TERMS, holder: 'alice', expiresAt: NOW + 1000, id: 'a', acquiredAt: NOW }],
    };
    const v = acquireLease({
      access: access(USERS.carol, held),
      perms: held,
      region: TERMS,
      holder: 'carol',
      now: NOW,
      id: 'l',
    });
    expect(v).toMatchObject({ ok: false, code: 'conflict', held: { holder: 'alice' } });
  });

  it('limits everyone else to view and comment while a lease is held, owners included, and the room refuses their commits', () => {
    const leased = {
      ...basePermissions(),
      revision: 2,
      leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 60_000 }],
    };
    expect([...access(USERS.alice, leased).regions.get(TERMS)!].sort()).toEqual([
      'comment',
      'view',
    ]);
    expect(access(USERS.carol, leased).regions.get(TERMS)!.has('edit')).toBe(true);
    const room = roomWith(baseDoc(), leased, () => NOW);
    room.open('a1', USERS.alice);
    expect(
      rejection(submit(room, 'a1', 0, [typeAt(room.document, 'pTerms000000001A', 'x')]), 'a1'),
    ).toMatchObject({
      code: 'permission_denied',
      scopes: [`region:${TERMS}`],
    });
  });

  it('sends perm.changed to everyone when a lease is released, and leaves the content and its hash unchanged', async () => {
    const leased = {
      ...basePermissions(),
      revision: 2,
      leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 60_000 }],
    };
    const room = roomWith(baseDoc(), leased, () => NOW);
    room.open('a1', USERS.alice);
    room.open('c1', USERS.carol);
    const hash = await documentHash({
      cdm: 1,
      requires: ['fields'],
      doc: room.document.toJSON() as never,
    });
    const end = endLease({
      access: access(USERS.carol, leased),
      perms: leased,
      region: TERMS,
      user: 'carol',
      now: NOW,
    });
    if (!end.ok) throw new Error(end.reason);
    const fx = room.permissionsChanged({ ...leased, revision: 3, leases: end.leases });
    expect(messages(fx, 'a1').map((m) => m.t)).toContain('perm.changed');
    expect(messages(fx, 'c1').map((m) => m.t)).toContain('perm.changed');
    // A lease is not document content: only a control commit is written.
    expect(fx.write?.commits.map((c) => c.kind)).toEqual(['control']);
    store(room);
    expect(
      await documentHash({ cdm: 1, requires: ['fields'], doc: room.document.toJSON() as never }),
    ).toBe(hash);
  });
});

describe('keeping a lease alive and letting it end (PRM-044)', () => {
  const held = (expiresAt: number, acquiredAt = NOW) => ({
    ...basePermissions(),
    leases: [{ region: TERMS, holder: 'carol', expiresAt, id: 'lease-1', acquiredAt }],
  });

  it('moves the expiry with each heartbeat, never past eight hours from acquisition', () => {
    const v = renewLease({
      perms: held(NOW + 1000),
      region: TERMS,
      id: 'lease-1',
      holder: 'carol',
      now: NOW + 500,
    });
    expect(v).toMatchObject({
      ok: true,
      lease: { expiresAt: NOW + 500 + LEASE_DEFAULTS.durationMs },
    });
    const late = NOW + LEASE_DEFAULTS.maxTotalMs - 60_000;
    const capped = renewLease({
      perms: held(late + 1000),
      region: TERMS,
      id: 'lease-1',
      holder: 'carol',
      now: late,
    });
    expect(capped).toMatchObject({
      ok: true,
      lease: { expiresAt: NOW + LEASE_DEFAULTS.maxTotalMs },
    });
    const atMax = NOW + LEASE_DEFAULTS.maxTotalMs;
    expect(
      renewLease({
        perms: held(atMax + 1),
        region: TERMS,
        id: 'lease-1',
        holder: 'carol',
        now: atMax,
      }).ok,
    ).toBe(false);
  });

  it('ends at its expiry without any other event: the room recomputes access and others regain their capabilities', () => {
    let now = NOW;
    const perms = {
      ...basePermissions(),
      revision: 2,
      leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 100 }],
    };
    const room = roomWith(baseDoc(), perms, () => now);
    room.open('a1', USERS.alice);
    expect(room.nextExpiry).toBe(NOW + 100);
    now = NOW + 100;
    const fx = room.expire();
    const changed = messages(fx, 'a1').find((m) => m.t === 'perm.changed');
    expect(changed?.t === 'perm.changed' && changed.access.regions.get(TERMS)?.has('edit')).toBe(
      true,
    );
    expect(
      rejection(submit(room, 'a1', 0, [typeAt(room.document, 'pTerms000000001A', 'x')]), 'a1'),
    ).toBeNull();
  });

  it('refuses a heartbeat for a lease that expired or was broken, and one from anyone but the holder', () => {
    expect(
      renewLease({ perms: held(NOW - 1), region: TERMS, id: 'lease-1', holder: 'carol', now: NOW }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      renewLease({
        perms: basePermissions(),
        region: TERMS,
        id: 'lease-1',
        holder: 'carol',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(
      renewLease({
        perms: held(NOW + 1000),
        region: TERMS,
        id: 'lease-1',
        holder: 'alice',
        now: NOW,
      }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
    // Without its acquisition time the maximum cannot be enforced: the renewal fails closed.
    const legacy = {
      ...basePermissions(),
      leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 1000 }],
    };
    expect(
      renewLease({ perms: legacy, region: TERMS, id: 'x', holder: 'carol', now: NOW }).ok,
    ).toBe(false);
  });
});

describe("breaking another person's lease (PRM-045)", () => {
  const leased = (): PermissionState => ({
    ...basePermissions(),
    revision: 2,
    leases: [{ region: TERMS, holder: 'carol', expiresAt: NOW + 60_000 }],
  });

  it('needs manage; the holder only releases their own', () => {
    const perms = leased();
    expect(
      endLease({ access: access(USERS.bob, perms), perms, region: TERMS, user: 'bob', now: NOW }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(
      endLease({
        access: access(USERS.alice, perms),
        perms,
        region: TERMS,
        user: 'alice',
        now: NOW,
      }),
    ).toMatchObject({ ok: true, broken: true, leases: [] });
  });

  it('is a control commit, and the holder’s commit made under the lease is then refused', () => {
    const perms = leased();
    const room = roomWith(baseDoc(), perms, () => NOW);
    room.open('c1', USERS.carol);
    const broken = endLease({
      access: access(USERS.alice, perms),
      perms,
      region: TERMS,
      user: 'alice',
      now: NOW,
    });
    if (!broken.ok) throw new Error(broken.reason);
    // Carol's commit is checked under the lease, then the break is stored before her write.
    const fx = submit(room, 'c1', 0, [typeAt(room.document, 'pTerms000000001A', 'mine ')]);
    expect(fx.write?.revision).toBe(2);
    const done = room.writeCompleted({
      status: 'revision_moved',
      perms: { ...perms, revision: 3, leases: broken.leases },
    });
    expect(rejection(done, 'c1')).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(done.write?.commits.map((c) => c.kind)).toEqual(['control']);
    expect(messages(done, 'c1').some((m) => m.t === 'perm.changed')).toBe(true);
  });
});

describe('setting a region state (PRM-046)', () => {
  it('leaves capabilities as they are in draft and in review', () => {
    for (const state of ['draft', 'in_review'] as const) {
      const perms = { ...basePermissions(), regionStates: new Map([[TERMS, state]]) };
      expect([...access(USERS.carol, perms).regions.get(TERMS)!].sort()).toEqual([
        'comment',
        'edit',
        'suggest',
        'view',
      ]);
    }
  });

  it('binds an approval to the seq and hash the room computes, and refuses a caller without manage', async () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    room.open('c1', USERS.carol);
    submit(room, 'c1', 0, [typeAt(room.document, 'pTerms000000001A', 'Agreed: ')]);
    // A commit to the region is still waiting to be stored: no approval is offered.
    expect(room.regionApproval(TERMS)).toBeNull();
    store(room);
    const basis = room.regionApproval(TERMS)!;
    expect(basis.seq).toBe(1);
    const region = room.document.nodeAt(posOf(room.document, TERMS))!;
    expect(basis.canonical).toBe(regionCanonicalText(region));
    const approval = { seq: basis.seq, hash: await sha256Hex(basis.canonical) };
    expect(approval.hash).toBe(await approvalHash(region));
    const perms = room.permissions;
    expect(
      setRegionState({
        access: access(USERS.carol, perms),
        perms,
        region: TERMS,
        exists: true,
        state: 'approved',
        approval,
      }),
    ).toMatchObject({ ok: false, code: 'permission_denied' });
    expect(
      setRegionState({
        access: access(USERS.alice, perms),
        perms,
        region: 'rGone0000000000X',
        exists: false,
        state: 'approved',
        approval,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    const v = setRegionState({
      access: access(USERS.alice, perms),
      perms,
      region: TERMS,
      exists: true,
      state: 'approved',
      approval,
    });
    if (!v.ok) throw new Error(v.reason);
    expect(v.approvals.get(TERMS)).toEqual(approval);
    // The change is stored under a new revision; the room records it as a control commit and
    // sends perm.changed.
    const fx = room.permissionsChanged({
      ...perms,
      revision: perms.revision + 1,
      regionStates: v.regionStates,
      approvals: v.approvals,
    });
    expect(fx.write?.commits.map((c) => c.kind)).toEqual(['control']);
    expect(messages(fx, 'c1').some((m) => m.t === 'perm.changed')).toBe(true);
  });

  it('includes a commit stored before the approval in its hash and refuses one ordered after it', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    room.open('c1', USERS.carol);
    submit(room, 'c1', 0, [typeAt(room.document, 'pTerms000000001A', 'Before. ')]);
    store(room);
    const basis = room.regionApproval(TERMS)!;
    expect(basis.canonical).toContain('Before.');
    // A commit checked before the room learns of the approval: its write is refused because the
    // grants revision moved, and its resubmission is refused by the approval.
    const racing = submit(room, 'c1', 1, [typeAt(room.document, 'pTerms000000001A', 'After. ')]);
    const approved = {
      ...room.permissions,
      revision: 2,
      regionStates: new Map([[TERMS, 'approved' as const]]),
    };
    expect(racing.write?.revision).toBe(1);
    room.writeCompleted({ status: 'revision_moved', perms: approved });
    store(room);
    const again = submit(room, 'c1', room.head, [
      typeAt(room.document, 'pTerms000000001A', 'After. '),
    ]);
    expect(rejection(again, 'c1')).toMatchObject({
      code: 'permission_denied',
      scopes: [`region:${TERMS}`],
    });
    expect(regionCanonicalText(room.document.nodeAt(posOf(room.document, TERMS))!)).toBe(
      basis.canonical,
    );
  });
});

describe('an approved region stays as approved (PRM-047)', () => {
  const approvedPerms = (extra: Partial<PermissionState> = {}) => ({
    ...morePermissions(),
    regionStates: new Map([[TERMS, 'approved' as const]]),
    ...extra,
  });

  it('limits everyone, owners included, to view and comment; an owner reopens it with a state change', () => {
    const perms = approvedPerms();
    expect([...access(USERS.alice, perms).regions.get(TERMS)!].sort()).toEqual(['comment', 'view']);
    const room = roomWith(baseDoc(), perms, () => NOW);
    room.open('a1', USERS.alice);
    expect(
      rejection(submit(room, 'a1', 0, [typeAt(room.document, 'pTerms000000001A', 'x')]), 'a1'),
    ).toMatchObject({ code: 'permission_denied' });
    room.permissionsChanged({ ...perms, revision: perms.revision + 1, regionStates: new Map() });
    store(room);
    expect(
      rejection(
        submit(room, 'a1', room.head, [typeAt(room.document, 'pTerms000000001A', 'x')]),
        'a1',
      ),
    ).toBeNull();
  });

  it('refuses server-authored commits that would change it, and accepts those that leave it alone', () => {
    const room = roomWith(baseDoc(), approvedPerms(), () => NOW);
    const changed = applySteps(room.document, [typeAt(room.document, 'pTerms000000001A', 'x')]);
    const elsewhere = applySteps(room.document, [typeAt(room.document, 'pIntro0000000001', 'x')]);
    if (!changed.ok || !elsewhere.ok) throw new Error('steps');
    for (const reason of ['restore', 'import', 'repair', 'migration'] as const) {
      const fx = room.snapshot('control', {
        id: commitId(),
        reason,
        content: changed.value.doc,
        checkpoint: 'c',
        as: 'system',
      });
      expect(messages(fx, 'control')[0], reason).toMatchObject({
        t: 'sync.reject',
        code: 'permission_denied',
      });
      expect(fx.write).toBeNull();
    }
    const region = room.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typeAt(room.document, 'pTerms000000001A', 'x')]),
      origin: 'restore',
      as: 'system',
      region: TERMS,
    });
    expect(messages(region, 'control')[0]).toMatchObject({
      t: 'sync.reject',
      code: 'permission_denied',
    });
    const ok = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content: elsewhere.value.doc,
      checkpoint: 'c',
      as: 'system',
    });
    expect(ok.write?.snapshot).toBeDefined();
  });

  it('refuses changing a definition it uses, removing, moving or retitling it; accepts a fill and a comment', () => {
    const doc = fieldsDoc();
    const perms = approvedPerms();
    const room = roomWith(doc, perms, () => NOW);
    room.open('a1', USERS.alice);
    room.open('n1', MORE.lena);
    const at = posOf(doc, TERMS);
    const size = doc.nodeAt(at)!.nodeSize;
    for (const steps of [
      [new AttrStep(posOf(doc, 'Normal'), 'color', '#FF0000')],
      [new ReplaceStep(at, at + size, Slice.empty)],
      [new AttrStep(at, 'title', 'Renamed')],
    ])
      expect(rejection(submit(room, 'a1', 0, steps), 'a1')?.code).toBe('permission_denied');
    // Lena fills the landlord's value inside the approved region under P7.
    const fill = submit(room, 'n1', 0, [
      new AttrStep(posOf(doc, FIELDS.termsSecret), 'value', 'SECRET-RENT-2'),
    ]);
    expect(rejection(fill, 'n1')).toBeNull();
    store(room);
    const thread = room.createThread({
      id: commitId(),
      as: MORE.cora,
      target: { block: 'pTerms000000002A' },
    });
    expect(thread.ok).toBe(true);
  });
});

describe('checking rights when restoring (PRM-049)', () => {
  it('needs manage to restore a whole document, and refuses it while a workflow is active', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const content = baseDoc();
    const carol = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content,
      checkpoint: 'c',
      as: USERS.carol,
    });
    expect(messages(carol, 'control')[0]).toMatchObject({ code: 'permission_denied' });
    const alice = room.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content,
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(alice.write?.snapshot).toMatchObject({ origin: 'restore' });
    const busy = roomWith(baseDoc(), { ...basePermissions(), workflowActive: true }, () => NOW);
    const refused = busy.snapshot('control', {
      id: commitId(),
      reason: 'restore',
      content,
      checkpoint: 'c',
      as: USERS.alice,
    });
    expect(messages(refused, 'control')[0]).toMatchObject({ code: 'conflict' });
  });

  it('needs edit in the region to restore it, refuses it when approved or leased to someone else, and keeps the restore to that region', () => {
    const steps = (doc: Node) => stepsToJson([typeAt(doc, 'pTerms000000001A', 'Restored ')]);
    const ok = roomWith(baseDoc(), basePermissions(), () => NOW);
    expect(
      ok.author('control', {
        id: commitId(),
        base: 0,
        steps: steps(ok.document),
        origin: 'restore',
        as: USERS.carol,
        region: TERMS,
      }).write,
    ).not.toBeNull();
    const cases: PermissionState[] = [
      { ...basePermissions(), regionStates: new Map([[TERMS, 'approved' as const]]) },
      { ...basePermissions(), leases: [{ region: TERMS, holder: 'alice', expiresAt: NOW + 1000 }] },
    ];
    for (const perms of cases) {
      const room = roomWith(baseDoc(), perms, () => NOW);
      const fx = room.author('control', {
        id: commitId(),
        base: 0,
        steps: steps(room.document),
        origin: 'restore',
        as: USERS.carol,
        region: TERMS,
      });
      expect(messages(fx, 'control')[0]).toMatchObject({ code: 'permission_denied' });
    }
    // Dave may only suggest in Terms: no edit, no restore.
    const dave = roomWith(baseDoc(), basePermissions(), () => NOW);
    expect(
      messages(
        dave.author('control', {
          id: commitId(),
          base: 0,
          steps: steps(dave.document),
          origin: 'restore',
          as: USERS.dave,
          region: TERMS,
        }),
        'control',
      )[0],
    ).toMatchObject({ code: 'permission_denied' });
    // A "region restore" that also changes the body is refused, whatever the user may edit.
    const wide = roomWith(baseDoc(), basePermissions(), () => NOW);
    const tr = new Transform(wide.document);
    tr.insert(posInside(tr.doc, 'pTerms000000001A'), schema.text('Restored '));
    tr.insert(posInside(tr.doc, 'pIntro0000000001'), schema.text('Also '));
    const fx = wide.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson(tr.steps),
      origin: 'restore',
      as: USERS.carol,
      region: TERMS,
    });
    expect(messages(fx, 'control')[0]).toMatchObject({
      code: 'permission_denied',
      scopes: ['body'],
    });
  });

  it('checks the conditions again when it applies the commit, and never changes grants, states or the revision', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    // Approved between the request and the application: the room refuses.
    room.permissionsChanged({
      ...basePermissions(),
      revision: 2,
      regionStates: new Map([[TERMS, 'approved' as const]]),
    });
    store(room);
    const fx = room.author('control', {
      id: commitId(),
      base: room.head,
      steps: stepsToJson([typeAt(room.document, 'pTerms000000001A', 'x')]),
      origin: 'restore',
      as: USERS.carol,
      region: TERMS,
      preconditions: { regionStates: { [TERMS]: 'draft' } },
    });
    expect(messages(fx, 'control')[0]).toMatchObject({ code: 'conflict' });
    const ok = roomWith(baseDoc(), basePermissions(), () => NOW);
    const before = canonicalize({
      ...ok.permissions,
      regionStates: [...ok.permissions.regionStates],
    });
    ok.author('control', {
      id: commitId(),
      base: 0,
      steps: stepsToJson([typeAt(ok.document, 'pTerms000000001A', 'x')]),
      origin: 'restore',
      as: USERS.carol,
      region: TERMS,
    });
    store(ok);
    expect(
      canonicalize({ ...ok.permissions, regionStates: [...ok.permissions.regionStates] }),
    ).toBe(before);
  });
});

describe('restoring a region whose definition is gone (PRM-050)', () => {
  const withClause = () => {
    const json = structuredClone(BASE_JSON) as unknown as {
      content: Array<{ content: Array<Record<string, unknown>> }>;
    };
    json.content[0]!.content.push({
      type: 'style_def',
      attrs: { id: 'Clause', kind: 'paragraph', name: 'Clause', basedOn: 'LegalBody' },
    });
    const terms = json.content[1]!.content.find(
      (b) => (b['attrs'] as Record<string, unknown> | undefined)?.['id'] === TERMS,
    )!;
    ((terms['content'] as Array<Record<string, unknown>>)[0]!['attrs'] as Record<string, unknown>)[
      'style'
    ] = 'Clause';
    return schema.nodeFromJSON(json);
  };

  it('recreates the definition for a user with structure, subject to 07 §5.3, and falls back to the default style otherwise', () => {
    const old = withClause();
    const oldTerms = old.nodeAt(posOf(old, TERMS))!;
    const current = baseDoc(); // the style Clause no longer exists; the region was edited since
    const withStructure = planRestoreDefinitions(oldTerms, old, current, true);
    expect(withStructure.recreate.map((d) => d.attrs['id'])).toEqual(['Clause']);
    expect(withStructure.replaced).toEqual([]);
    const without = planRestoreDefinitions(oldTerms, old, current, false);
    expect(without.recreate).toEqual([]);
    expect(without.replaced).toEqual(['defs:style_def/Clause']);
    expect(without.region.child(0).attrs['style']).toBeNull();
    // A dry run is the same function of the same inputs.
    expect(planRestoreDefinitions(oldTerms, old, current, false).replaced).toEqual(
      without.replaced,
    );
    // Applied through the room as a region restore: with structure the definition comes back;
    // a region-only editor gets the fallback, which changes no definition.
    const room = roomWith(current, morePermissions(), () => NOW);
    const at = posOf(current, TERMS);
    const plan = (p: typeof without) => {
      const tr = new Transform(current);
      const node = current.nodeAt(at)!;
      tr.replaceWith(at + 1, at + node.nodeSize - 1, p.region.content);
      // Definitions keep their order in `defs`: the style goes after the last style.
      let afterStyles = 1;
      current.child(0).forEach((d, o) => {
        if (d.type.name === 'style_def') afterStyles = 1 + o + d.nodeSize;
      });
      if (p.recreate.length) tr.insert(afterStyles, p.recreate);
      expect(tr.steps.length).toBe(p.recreate.length ? 2 : 1);
      return stepsToJson(tr.steps);
    };
    const carol = room.author('control', {
      id: commitId(),
      base: 0,
      steps: plan(withStructure),
      origin: 'restore',
      as: USERS.carol,
      region: TERMS,
    });
    expect(messages(carol, 'control').find((m) => m.t === 'sync.reject')).toBeUndefined();
    const rita = roomWith(current, morePermissions(), () => NOW);
    const r = rita.author('control', {
      id: commitId(),
      base: 0,
      steps: plan(without),
      origin: 'restore',
      as: MORE.rita,
      region: TERMS,
    });
    expect(messages(r, 'control').find((m) => m.t === 'sync.reject')).toBeUndefined();
    const refused = roomWith(current, morePermissions(), () => NOW).author('control', {
      id: commitId(),
      base: 0,
      steps: plan(withStructure),
      origin: 'restore',
      as: MORE.rita,
      region: TERMS,
    });
    expect(messages(refused, 'control')[0]).toMatchObject({ code: 'permission_denied' });
  });
});
