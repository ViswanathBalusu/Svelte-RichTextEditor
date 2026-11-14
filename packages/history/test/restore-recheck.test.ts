// Restores are re-checked when the room applies them (07 §13; HIS-020 criterion 1). A plan made
// while the rules held is applied later: if a lease by someone else, or an active workflow, has
// come in since, the room refuses the commit. Helpers mirror restore.test.ts.
import {
  type Access,
  type Connection,
  type Effects,
  type PermissionState,
  Room,
  type WriteRequest,
  computeAccess,
  regionInfos,
} from '@docedit/authority';
import type { Node } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, applyCommit } from '../src/attribution.ts';
import { type RestoreContext, planRestore } from '../src/restore.ts';
import { LogBuilder, REQUIRES, posOf, schema, typeAt, uuid } from './fixtures.ts';

const NOW = 1_790_000_000_000;
const TERMS = 'rTerms000000000A';

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
};

function perms(extra: Partial<PermissionState> = {}): PermissionState {
  return {
    revision: 1,
    grants: [{ region: TERMS, principal: 'user:bob', role: 'editor', expiresAt: null }],
    regionStates: new Map(),
    leases: [],
    documentState: 'active',
    workflowActive: false,
    ...extra,
  };
}

const accessOf = (c: Connection, doc: Node, p = perms()): Access =>
  computeAccess(c, regionInfos(doc), p, NOW);

/** The terms region edited after seq 0: the first paragraph changed, the second removed. */
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

const answerTo = (fx: Effects) => fx.send.find((o) => o.channel === 'svc')?.msg;

describe('the room re-checks a restore when it applies it (HIS-020 criterion 1)', () => {
  it('refuses a region restore when someone else takes a lease on the region after planning', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0, region: TERMS }, ctx(b, USERS.bob));
    if (!planned.ok || planned.plan.kind !== 'steps') throw new Error('no steps');

    const { room: rm, flush } = room(b);
    rm.permissionsChanged(
      perms({ revision: 2, leases: [{ region: TERMS, holder: 'carol', expiresAt: 1e15 }] }),
    );
    // Without the preconditions the room re-checks the steps alone (the outcome check, 04 §5).
    const out = flush(
      rm.author('svc', {
        id: uuid(),
        base: b.head,
        steps: planned.plan.stepsJson,
        origin: 'restore',
        as: USERS.bob,
      }),
    );
    expect(answerTo(out)).toMatchObject({ t: 'sync.reject' });
    expect(rm.head).toBe(b.head);
  });

  it('refuses a region restore when the planner loses edit in the region after planning (HIS-020 criterion 1, U-HIS-017-032)', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0, region: TERMS }, ctx(b, USERS.bob));
    if (!planned.ok || planned.plan.kind !== 'steps') throw new Error('no steps');

    const { room: rm, flush } = room(b);
    // Bob's edit in the region came from his editor grant on it. After planning the grant is
    // withdrawn and his document role is viewer, so he no longer holds edit anywhere. (A viewer
    // grant alone does not cut an editor's document role: `inherit` regions take the role and add
    // grants, access.ts.) The control commit of the change is written first (one write in flight
    // per room), so the restore is judged only once that write has completed.
    const changed = flush(rm.permissionsChanged(perms({ revision: 2, grants: [] })));
    const out = flush(
      rm.author('svc', {
        id: uuid(),
        base: b.head,
        steps: planned.plan.stepsJson,
        origin: 'restore',
        as: conn('bob', 'viewer'),
      }),
    );
    expect(answerTo({ send: [...changed.send, ...out.send], write: null })).toMatchObject({
      t: 'sync.reject',
    });
    expect(rm.head).toBe(b.head + 1);
  });

  it('applies the same planned region restore when no lease is held (control)', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0, region: TERMS }, ctx(b, USERS.bob));
    if (!planned.ok || planned.plan.kind !== 'steps') throw new Error('no steps');

    const { room: rm, flush } = room(b);
    flush(
      rm.author('svc', {
        id: uuid(),
        base: b.head,
        steps: planned.plan.stepsJson,
        origin: 'restore',
        as: USERS.bob,
      }),
    );
    expect(rm.head).toBe(b.head + 1);
  });

  it('refuses a whole-document restore whose preconditions no longer hold when a workflow starts', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0 }, ctx(b, USERS.alice));
    if (!planned.ok) throw new Error(planned.reason);

    const { room: rm, flush } = room(b);
    rm.permissionsChanged(perms({ revision: 2, workflowActive: true }));
    const out = flush(
      rm.snapshot('svc', {
        id: uuid(),
        reason: 'restore',
        content: planned.plan.result,
        checkpoint: 'k-recheck',
        as: USERS.alice,
        preconditions: planned.plan.preconditions,
      }),
    );
    expect(answerTo(out)).toMatchObject({ t: 'sync.reject' });
    expect(rm.head).toBe(b.head);
  });
});
