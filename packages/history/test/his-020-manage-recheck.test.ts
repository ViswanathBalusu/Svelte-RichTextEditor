// The whole-document restore is re-checked when the room applies it: the `manage` right that the
// request needed (07 §13) must still hold at that moment (HIS-020 criterion 1). Lane
// V-HIS-017-032. The helpers mirror restore-recheck.test.ts, which is another lane's file.
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

describe('the room re-checks the manage right of a whole-document restore (HIS-020 criterion 1)', () => {
  it('applies the planned whole-document restore while the planner still holds manage (control)', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0 }, ctx(b, USERS.alice));
    if (!planned.ok) throw new Error(planned.reason);

    const { room: rm, flush } = room(b);
    const out = flush(
      rm.snapshot('svc', {
        id: uuid(),
        reason: 'restore',
        content: planned.plan.result,
        checkpoint: 'k-manage-control',
        as: USERS.alice,
        preconditions: planned.plan.preconditions,
      }),
    );
    expect(answerTo(out)).not.toMatchObject({ t: 'sync.reject' });
    expect(rm.head).toBe(b.head + 1);
  });

  it('refuses the planned whole-document restore when the planner loses manage after planning', () => {
    const b = edited();
    const planned = planRestore({ toSeq: 0 }, ctx(b, USERS.alice));
    if (!planned.ok) throw new Error(planned.reason);

    const { room: rm, flush } = room(b);
    // Alice's owner role is withdrawn before the room applies the restore: an editor holds no manage.
    const out = flush(
      rm.snapshot('svc', {
        id: uuid(),
        reason: 'restore',
        content: planned.plan.result,
        checkpoint: 'k-manage-lost',
        as: conn('alice', 'editor'),
        preconditions: planned.plan.preconditions,
      }),
    );
    expect(answerTo(out)).toMatchObject({ t: 'sync.reject' });
    expect(rm.head).toBe(b.head);
  });
});
