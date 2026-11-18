// Restore plans and their dry runs (08 §8; 07 §12, §13; HIS-018 to HIS-021), checked by applying
// them through the authority's room, which re-checks them as server-authored commits (SYN-030).
import {
  type Access,
  type Connection,
  type Effects,
  type PermissionState,
  Room,
  type WriteRequest,
  computeAccess,
  mapRanges,
  regionInfos,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import { type RestoreContext, planRestore } from '../src/restore.ts';
import {
  HIDDEN,
  LogBuilder,
  REQUIRES,
  baseDoc,
  posInside,
  posOf,
  schema,
  typeAt,
  uuid,
} from './fixtures.ts';

const NOW = 1_790_000_000_000;

const conn = (sub: string, role: Connection['role']): Connection => ({
  sub,
  session: `s-${sub}`,
  role,
  groups: [],
  participantRoles: [],
  participantActive: false,
});

const USERS = {
  alice: conn('alice', 'owner'),
  bob: conn('bob', 'editor'),
  frank: conn('frank', 'viewer'),
  dave: conn('dave', 'suggester'),
  // A viewer who may edit the terms through a grant, without `structure`.
  gina: conn('gina', 'viewer'),
};

function perms(extra: Partial<PermissionState> = {}): PermissionState {
  return {
    revision: 1,
    grants: [
      { region: 'rTerms000000000A', principal: 'user:gina', role: 'editor', expiresAt: null },
    ],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
    ...extra,
  };
}

const accessOf = (c: Connection, doc: Node, p = perms()): Access =>
  computeAccess(c, regionInfos(doc), p, NOW);

/** The terms region edited after seq 0: the first paragraph changed, the second removed, one added. */
function edited(): LogBuilder {
  const b = new LogBuilder();
  b.add((d) => typeAt(d, 'pTerms000000001A', 0, 'Changed. '), { user: 'carol' });
  b.add(
    (d) => {
      const at = posOf(d, 'pTerms000000002A');
      return new Transform(d).delete(at, at + d.nodeAt(at)!.nodeSize);
    },
    { user: 'carol' },
  );
  b.add(
    (d) => {
      const at = posOf(d, 'pTerms000000003A');
      const n = d.nodeAt(at)!;
      return new Transform(d).insert(
        at + n.nodeSize,
        schema.nodes['paragraph']!.create(
          { id: 'pTermsNew000004A' },
          schema.text('An extra clause.'),
        ),
      );
    },
    { user: 'carol' },
  );
  return b;
}

function mapsOf(b: LogBuilder): AttributionMap[] {
  const maps = [AttributionMap.create(b.docs[0]!.content.size, { user: 'owner', seq: 0 })];
  for (const c of b.log) {
    const m = maps[maps.length - 1]!.clone();
    applyCommit(m, c, schema);
    maps.push(m);
  }
  return maps;
}

function ctx(
  b: LogBuilder,
  who: Connection,
  extra: Partial<RestoreContext> = {},
  p = perms(),
): RestoreContext {
  const maps = mapsOf(b);
  return {
    schema,
    head: { seq: b.head, doc: b.doc, attribution: maps[b.head]! },
    target: (seq) => ({ doc: b.docs[seq]!, attribution: maps[seq]! }),
    gate: { min: 0, head: b.head },
    hidden: { regions: new Set(), values: new Set(), titles: false },
    access: accessOf(who, b.doc, p),
    user: who.sub,
    ...extra,
  };
}

const children = (doc: Node, region: string) => {
  const out: string[] = [];
  doc.nodeAt(posOf(doc, region))!.forEach((c) => out.push(String(c.attrs['id'])));
  return out;
};

function room(b: LogBuilder, p = perms()): { room: Room; flush: (fx: Effects) => Effects } {
  const r = new Room({
    schema,
    initial: b.docs[0]!,
    requires: REQUIRES,
    log: b.log,
    perms: p,
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => NOW,
  });
  const flush = (fx: Effects): Effects => {
    const all: Effects = { send: [...fx.send], write: null };
    let write: WriteRequest | null = fx.write;
    while (write) {
      const done = r.writeCompleted({ status: 'ok' });
      all.send.push(...done.send);
      write = done.write;
    }
    return all;
  };
  return { room: r, flush };
}

describe('restoring one region (HIS-018)', () => {
  it('aligns blocks by identifier: unchanged left alone, changed replaced, missing inserted, extra removed', () => {
    const b = edited();
    const r = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    expect(r.ok).toBe(true);
    if (!r.ok || r.plan.kind !== 'steps') throw new Error('no steps');
    expect(children(r.plan.result, 'rTerms000000000A')).toEqual(
      children(b.docs[0]!, 'rTerms000000000A'),
    );
    expect(
      r.plan.result
        .nodeAt(posOf(r.plan.result, 'rTerms000000000A'))!
        .eq(b.docs[0]!.nodeAt(posOf(b.docs[0]!, 'rTerms000000000A'))!),
    ).toBe(true);
    // Two stretches: before the unchanged third paragraph, and after it.
    expect(r.plan.steps).toHaveLength(2);
    // The rest of the document is untouched.
    expect(r.plan.result.nodeAt(posOf(r.plan.result, 'pIntro0000000001'))).toBe(
      b.doc.nodeAt(posOf(b.doc, 'pIntro0000000001')),
    );
    expect(r.plan.preconditions).toEqual({
      head: 3,
      revision: 1,
      regionStates: { rTerms000000000A: 'draft' },
    });
  });

  it('keeps comment ranges and attribution in the blocks it leaves alone', () => {
    const b = edited();
    const r = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    if (!r.ok || r.plan.kind !== 'steps') throw new Error('no steps');
    const at = posInside(b.doc, 'pTerms000000003A', 0);
    const [mapped] = mapRanges(
      [{ from: at, to: at + 4 }],
      r.plan.steps.map((s) => s.getMap()),
    );
    expect(mapped!.collapsed).toBe(false);
    expect(r.plan.result.textBetween(mapped!.from, mapped!.to)).toBe('Pets');
    const before = mapsOf(b)[3]!.slice(at, at + 4);
    const after = r.plan.resultAttribution!.slice(mapped!.from, mapped!.to);
    expect(after.map((x) => [x.user, x.seq, x.len, x.restoredBy])).toEqual(
      before.map((x) => [x.user, x.seq, x.len, x.restoredBy]),
    );
  });

  it('keeps the original authors of restored runs and marks them restored by the restoring user', () => {
    const b = edited();
    const r = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    if (!r.ok || r.plan.kind !== 'steps') throw new Error('no steps');
    const at = posInside(r.plan.result, 'pTerms000000002A', 0);
    expect(r.plan.resultAttribution!.at(at)).toEqual({
      user: 'owner',
      seq: 0,
      restoredBy: 'bob',
      restoredSeq: 4,
    });
    // The room host applies the same hint to the stored commit and gets the same map.
    const live = mapsOf(b)[3]!.clone();
    r.plan.steps.forEach((s, i) =>
      live.applyStep(
        s,
        { user: 'bob', seq: 4 },
        r.plan.kind === 'steps' ? r.plan.hint[i] : undefined,
      ),
    );
    expect(live.equals(r.plan.resultAttribution!)).toBe(true);
  });

  it('falls back to a snapshot commit when the steps are too large for one commit', () => {
    const b = edited();
    const r = planRestore(
      { toSeq: 0, region: 'rTerms000000000A' },
      ctx(b, USERS.bob, { maxCommitBytes: 200 }),
    );
    expect(r.ok && r.plan).toMatchObject({
      kind: 'snapshot',
      reason: 'restore',
      region: 'rTerms000000000A',
      fallback: 'too_large',
    });
    const steps = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    // The snapshot holds the same content, with the head as a precondition so that it cannot
    // overwrite commits made after it was planned.
    expect(r.ok && steps.ok && r.plan.result.eq(steps.plan.result)).toBe(true);
    expect(r.ok && r.plan.preconditions).toMatchObject({ head: 3 });
  });

  it('refuses a user without edit in the region with forbidden', () => {
    const b = edited();
    for (const who of [USERS.frank, USERS.dave])
      expect(planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, who))).toMatchObject({
        ok: false,
        code: 'forbidden',
      });
    // Gina may edit the terms through a grant.
    expect(planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.gina)).ok).toBe(true);
  });

  it('applies as one server-authored commit with origin restore through the room', () => {
    const b = edited();
    const r = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    if (!r.ok || r.plan.kind !== 'steps') throw new Error('no steps');
    const { room: rm, flush } = room(b);
    const fx = flush(
      rm.author('svc', {
        id: uuid(),
        base: 3,
        steps: r.plan.stepsJson,
        origin: 'restore',
        as: USERS.bob,
        preconditions: r.plan.preconditions,
      }),
    );
    expect(fx.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({ t: 'sync.ack', seq: 4 });
    expect(rm.document.eq(r.plan.result)).toBe(true);
  });
});

describe('restoring the whole document (HIS-019)', () => {
  it('is a snapshot commit with reason restore for a user with manage and no active workflow', () => {
    const b = edited();
    const r = planRestore({ toSeq: 1 }, ctx(b, USERS.alice));
    expect(r.ok && r.plan).toMatchObject({
      kind: 'snapshot',
      reason: 'restore',
      preconditions: { head: 3, revision: 1, workflowActive: false },
    });
    expect(r.ok && r.plan.result.eq(b.docs[1]!)).toBe(true);
    // Through the room: a snapshot commit, the grants revision unchanged (a restore never brings back grants).
    const { room: rm, flush } = room(b);
    const fx = flush(
      rm.snapshot('svc', {
        id: uuid(),
        reason: 'restore',
        content: r.ok ? r.plan.result : b.doc,
        checkpoint: 'k4',
        as: USERS.alice,
        ...(r.ok ? { preconditions: r.plan.preconditions } : {}),
      }),
    );
    expect(fx.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({ t: 'sync.ack', seq: 4 });
    expect(rm.permissions.revision).toBe(1);
    expect(rm.permissions.grants).toEqual(perms().grants);
  });

  it('is refused while a workflow is active, without manage, and below the gate', () => {
    const b = edited();
    expect(planRestore({ toSeq: 1 }, ctx(b, USERS.alice, { workflowActive: true }))).toMatchObject({
      ok: false,
      code: 'workflow_active',
    });
    expect(planRestore({ toSeq: 1 }, ctx(b, USERS.bob))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      planRestore({ toSeq: 1 }, ctx(b, USERS.alice, { gate: { min: 3, head: 3 } })),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(
      planRestore(
        { toSeq: 1 },
        ctx(b, USERS.alice, { gate: { min: 3, head: 3, named: (s) => s === 1 } }),
      ).ok,
    ).toBe(true);
    expect(planRestore({ toSeq: 9 }, ctx(b, USERS.alice))).toMatchObject({
      ok: false,
      code: 'not_found',
    });
  });

  it('gives a region whose identifier was retired a new one (I3)', () => {
    const b = edited();
    const r = planRestore(
      { toSeq: 0 },
      ctx(b, USERS.alice, { retired: new Set(['rTerms000000000A']) }),
    );
    if (!r.ok) throw new Error(r.reason);
    const renamed = r.plan.reidentified['rTerms000000000A']!;
    expect(renamed).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(children(r.plan.result, renamed)).toEqual(children(b.docs[0]!, 'rTerms000000000A'));
  });
});

describe('re-checking restores (HIS-020)', () => {
  it('refuses a restore that would change an approved region, when requested and when applied', () => {
    const b = edited();
    const approved = perms({ regionStates: new Map([['rTerms000000000A', 'approved']]) });
    expect(
      planRestore(
        { toSeq: 0, region: 'rTerms000000000A' },
        ctx(b, USERS.bob, { regionStates: approved.regionStates }, approved),
      ),
    ).toMatchObject({ ok: false, code: 'conflict' });
    expect(
      planRestore(
        { toSeq: 0 },
        ctx(b, USERS.alice, { regionStates: approved.regionStates }, approved),
      ),
    ).toMatchObject({ ok: false, code: 'conflict' });
    // Planned while in draft, approved before the room applies it: the room refuses.
    const r = planRestore({ toSeq: 0, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    if (!r.ok || r.plan.kind !== 'steps') throw new Error('no steps');
    const { room: rm, flush } = room(b);
    rm.permissionsChanged({ ...approved, revision: 2 });
    const withPre = flush(
      rm.author('svc', {
        id: uuid(),
        base: 3,
        steps: r.plan.stepsJson,
        origin: 'restore',
        as: USERS.bob,
        preconditions: r.plan.preconditions,
      }),
    );
    expect(withPre.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({
      t: 'sync.reject',
      code: 'conflict',
    });
    const without = flush(
      rm.author('svc', {
        id: uuid(),
        base: 3,
        steps: r.plan.stepsJson,
        origin: 'restore',
        as: USERS.bob,
      }),
    );
    expect(without.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({ t: 'sync.reject' });
    expect(rm.head).toBe(3);
  });

  it('gives a restored block a new identifier when its old one is in use elsewhere', () => {
    const b = edited();
    // After seq 0 the second paragraph was deleted; now a paragraph with its identifier lives in the body.
    b.add(
      (d) =>
        new Transform(d).insert(
          posOf(d, 'pEnd00000000001Z'),
          schema.nodes['paragraph']!.create({ id: 'pTerms000000002A' }, schema.text('Moved out.')),
        ),
      { user: 'carol' },
    );
    const r = planRestore(
      { toSeq: 0, region: 'rTerms000000000A' },
      ctx(b, USERS.bob, { idSalt: 'request-1' }),
    );
    if (!r.ok) throw new Error(r.reason);
    const renamed = r.plan.reidentified['pTerms000000002A']!;
    expect(renamed).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(renamed).not.toBe('pTerms000000002A');
    expect(children(r.plan.result, 'rTerms000000000A')).toEqual([
      'pTerms000000001A',
      renamed,
      'pTerms000000003A',
    ]);
    // Deterministic for one request: the dry run and the restore agree.
    const again = planRestore(
      { toSeq: 0, region: 'rTerms000000000A', dryRun: true },
      ctx(b, USERS.bob, { idSalt: 'request-1' }),
    );
    expect(again.ok && again.plan.reidentified).toEqual(r.plan.reidentified);
    const other = planRestore(
      { toSeq: 0, region: 'rTerms000000000A' },
      ctx(b, USERS.bob, { idSalt: 'request-2' }),
    );
    expect(other.ok && other.plan.reidentified['pTerms000000002A']).not.toBe(renamed);
  });

  it('recreates a missing definition for a user with structure, and falls back to the default style otherwise', () => {
    const b = new LogBuilder();
    b.add(
      (d) => new Transform(d).setNodeAttribute(posOf(d, 'pTerms000000002A'), 'style', 'LegalQuote'),
      { user: 'bob' },
    );
    b.add((d) => new Transform(d).setNodeAttribute(posOf(d, 'pTerms000000002A'), 'style', null), {
      user: 'bob',
    });
    b.add(
      (d) => {
        const at = posOf(d, 'LegalQuote');
        return new Transform(d).delete(at, at + 1);
      },
      { user: 'alice', scopes: ['defs:style_def/LegalQuote'] },
    );
    const withStructure = planRestore({ toSeq: 1, region: 'rTerms000000000A' }, ctx(b, USERS.bob));
    if (!withStructure.ok) throw new Error(withStructure.reason);
    expect(withStructure.plan.recreated).toEqual(['style_def/LegalQuote']);
    expect(
      withStructure.plan.result.nodeAt(posOf(withStructure.plan.result, 'pTerms000000002A'))!.attrs[
        'style'
      ],
    ).toBe('LegalQuote');
    expect(
      withStructure.plan.result.nodeAt(posOf(withStructure.plan.result, 'LegalQuote'))?.type.name,
    ).toBe('style_def');
    const without = planRestore({ toSeq: 1, region: 'rTerms000000000A' }, ctx(b, USERS.gina));
    if (!without.ok) throw new Error(without.reason);
    expect(without.plan.replaced).toEqual(['style_def/LegalQuote']);
    expect(without.plan.recreated).toEqual([]);
    expect(
      without.plan.result.nodeAt(posOf(without.plan.result, 'pTerms000000002A'))!.attrs['style'],
    ).toBe(null);
    // Both pass the room's invariant and outcome checks, as any server-authored commit (SYN-030).
    for (const [plan, who] of [
      [withStructure.plan, USERS.bob],
      [without.plan, USERS.gina],
    ] as const) {
      if (plan.kind !== 'steps') throw new Error('no steps');
      const { room: rm, flush } = room(b);
      const fx = flush(
        rm.author('svc', {
          id: uuid(),
          base: 3,
          steps: plan.stepsJson,
          origin: 'restore',
          as: who,
          preconditions: plan.preconditions,
        }),
      );
      expect(fx.send.find((o) => o.channel === 'svc')?.msg, who.sub).toMatchObject({
        t: 'sync.ack',
        seq: 4,
      });
    }
    // Applied for a user without structure, the recreating plan is refused by the outcome check.
    if (withStructure.plan.kind !== 'steps') throw new Error('no steps');
    const { room: rm, flush } = room(b);
    const refused = flush(
      rm.author('svc', {
        id: uuid(),
        base: 3,
        steps: withStructure.plan.stepsJson,
        origin: 'restore',
        as: USERS.gina,
      }),
    );
    expect(refused.send.find((o) => o.channel === 'svc')?.msg).toMatchObject({
      t: 'sync.reject',
      code: 'permission_denied',
    });
  });

  it('a dry run reports the same recreated and replaced definitions as the restore (PRM-050 criterion 3)', () => {
    const b = new LogBuilder();
    b.add(
      (d) => new Transform(d).setNodeAttribute(posOf(d, 'pTerms000000002A'), 'style', 'LegalQuote'),
      { user: 'bob' },
    );
    b.add((d) => new Transform(d).setNodeAttribute(posOf(d, 'pTerms000000002A'), 'style', null), {
      user: 'bob',
    });
    b.add(
      (d) => {
        const at = posOf(d, 'LegalQuote');
        return new Transform(d).delete(at, at + 1);
      },
      { user: 'alice', scopes: ['defs:style_def/LegalQuote'] },
    );
    for (const [who, expected] of [
      [USERS.bob, ['style_def/LegalQuote']],
      [USERS.gina, []],
    ] as const) {
      const dry = planRestore(
        { toSeq: 1, region: 'rTerms000000000A', dryRun: true },
        ctx(b, who),
      );
      const real = planRestore({ toSeq: 1, region: 'rTerms000000000A' }, ctx(b, who));
      if (!dry.ok) throw new Error(dry.reason);
      if (!real.ok) throw new Error(real.reason);
      expect(dry.plan.recreated, who.sub).toEqual(real.plan.recreated);
      expect(dry.plan.replaced, who.sub).toEqual(real.plan.replaced);
      expect(dry.plan.recreated, who.sub).toEqual(expected);
      expect(dry.plan.replaced, who.sub).toEqual(
        expected.length === 0 ? ['style_def/LegalQuote'] : [],
      );
    }
  });
});

describe('previewing a restore with a dry run (HIS-021)', () => {
  it('returns the comparison the restore would produce, in the format of HIS-011', () => {
    const b = edited();
    const r = planRestore(
      { toSeq: 0, region: 'rTerms000000000A', dryRun: true },
      ctx(b, USERS.bob),
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.dryRun).toMatchObject({ fromSeq: 3, toSeq: 4, method: 'aligned' });
    expect(r.plan.dryRun!.changes.map((c) => `${c.kind}:${c.blockId}`)).toEqual([
      'modified:pTerms000000001A',
      'added:pTerms000000002A',
      'removed:pTermsNew000004A',
    ]);
    // The text brought back names its original author, as the restored runs will.
    const added = r.plan.dryRun!.changes.find((c) => c.kind === 'added')!;
    expect(added).toMatchObject({ user: 'owner', seq: 0 });
  });

  it('creates nothing: the room, its log and its head are as they were', () => {
    const b = edited();
    const { room: rm } = room(b);
    const before = rm.document;
    const r = planRestore({ toSeq: 0, dryRun: true }, ctx(b, USERS.alice));
    expect(r.ok).toBe(true);
    expect(rm.head).toBe(3);
    expect(rm.document).toBe(before);
  });

  it('needs the same permission and visibility as the restore itself', () => {
    const b = edited();
    expect(
      planRestore({ toSeq: 0, region: 'rTerms000000000A', dryRun: true }, ctx(b, USERS.frank)),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    expect(planRestore({ toSeq: 0, dryRun: true }, ctx(b, USERS.bob))).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(
      planRestore({ toSeq: 0, dryRun: true }, ctx(b, USERS.alice, { gate: { min: 2, head: 3 } })),
    ).toMatchObject({ ok: false, code: 'forbidden' });
    // A region the requester may not read is refused as if it did not exist.
    expect(
      planRestore(
        { toSeq: 0, region: 'rSecret00000000B', dryRun: true },
        ctx(b, USERS.bob, { hidden: HIDDEN }),
      ),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(baseDoc().eq(b.docs[0]!)).toBe(true);
  });
});
