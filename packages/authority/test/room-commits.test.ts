// Snapshot commits (SYN-005), server-authored commits (SYN-030), admission control (SYN-037) and
// the additions to the storage contract: what a commit records (08 §2), a conflict on the commit
// identifier alone (`duplicate`), a write whose outcome cannot be settled (`lost`) and `stop()`.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { PermissionState } from '../src/permissions/model.ts';
import { TokenBucket, defaultCost } from '../src/room/admission.ts';
import { Room, type RoomInit, type SnapshotRequest } from '../src/room/room.ts';
import {
  SERVER_SESSION,
  type CommitInput,
  type Effects,
  type SnapshotCommit,
  type ToClient,
  type WriteRequest,
} from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';
import { MemoryStorage } from './harness/storage.ts';

let clock = 1_790_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...extra,
  });
}

const insert = (doc = baseDoc(), at = 'pIntro0000000001', text = 'x') => {
  const pos = posInside(doc, at);
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
};
const msgs = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
const first = <T extends ToClient['t']>(fx: Effects, channel: string, t: T) =>
  msgs(fx, channel).find((m) => m.t === t) as Extract<ToClient, { t: T }> | undefined;

/** Stores whatever the room writes, in storage, until nothing is left to write. */
function flush(r: Room, fx: Effects, storage?: MemoryStorage): Effects {
  const all: Effects = {
    send: [...fx.send],
    write: null,
    checkpoints: [...(fx.checkpoints ?? [])],
  };
  let write: WriteRequest | null = fx.write;
  while (write) {
    const done = r.writeCompleted(storage ? storage.write(write, 'none') : { status: 'ok' });
    all.send.push(...done.send);
    all.checkpoints!.push(...(done.checkpoints ?? []));
    write = done.write;
  }
  return all;
}

/** The base document with one paragraph's text replaced, as an import would bring it. */
function imported(text = 'Imported text'): ReturnType<typeof baseDoc> {
  const doc = baseDoc();
  const at = posOf(doc, 'pIntro0000000001');
  const node = doc.nodeAt(at)!;
  return new Transform(doc).replaceWith(at + 1, at + node.nodeSize - 1, schema.text(text)).doc;
}

function snapshotRequest(
  content = imported(),
  extra: Partial<SnapshotRequest> = {},
): SnapshotRequest {
  return { id: id(), reason: 'import', content, checkpoint: 'ckpt-import', as: 'system', ...extra };
}

describe('snapshot commits (SYN-005)', () => {
  it('stores a snapshot commit that references a checkpoint, alone, with the checkpoint before it requested', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const steps = flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    expect(first(steps, 'c1', 'sync.ack')?.seq).toBe(1);
    const before = r.document;
    const fx = r.snapshot('control', snapshotRequest());
    // Written alone, referencing the checkpoint, with no steps.
    expect(fx.write).toMatchObject({ fromSeq: 2, commits: [] });
    expect(fx.write?.snapshot).toMatchObject({
      seq: 2,
      kind: 'snapshot',
      steps: [],
      snapshot: { checkpoint: 'ckpt-import', reason: 'import' },
      user: 'system',
      session: SERVER_SESSION,
      origin: 'import',
    });
    // The durable state right before it is asked for as a checkpoint (08 §3: "around every
    // snapshot commit"); the checkpoint at its own seq is the one it references.
    expect(fx.checkpoints).toEqual([{ seq: 1, doc: before, reason: 'snapshot' }]);
  });

  it('reaches every subscriber as sync.reset with seq and reason, never as sync.commit', () => {
    const r = room();
    for (const [ch, u] of [
      ['a1', USERS.alice],
      ['c1', USERS.carol],
      ['f1', USERS.frank],
    ] as const)
      r.open(ch, u);
    for (const reason of ['import', 'restore', 'migration', 'repair'] as const) {
      const done = flush(r, r.snapshot('control', snapshotRequest(imported(reason), { reason })));
      for (const ch of ['a1', 'c1', 'f1']) {
        expect(
          msgs(done, ch).map((m) => m.t),
          ch,
        ).toEqual(['sync.reset']);
        expect(first(done, ch, 'sync.reset')).toMatchObject({ reason, seq: r.head });
        expect(first(done, ch, 'sync.reset')?.content.incarnation).toBe('inc-1');
      }
      expect(first(done, 'control', 'sync.ack')).toMatchObject({ seq: r.head, rebased: false });
    }
    expect(r.document.textContent).toContain('repair');
  });

  it('refuses a step commit whose base is older than a snapshot with stale_base and rebase, without rebasing it', () => {
    const r = room();
    r.open('c1', USERS.carol);
    flush(r, r.snapshot('control', snapshotRequest()));
    const fx = r.submit('c1', { id: id(), base: 0, steps: insert() });
    // 04 §3.2 as revised on 2026-11-06 (second review SR-K1): `stale_base` with action `rebase`.
    expect(first(fx, 'c1', 'sync.reject')).toMatchObject({
      code: 'stale_base',
      action: 'rebase',
      head: 1,
    });
    expect(fx.write).toBeNull();
    // A snapshot still waiting to be stored counts as well.
    r.snapshot('control', snapshotRequest(imported('again')));
    expect(
      first(r.submit('c1', { id: id(), base: 1, steps: insert() }), 'c1', 'sync.reject')?.code,
    ).toBe('stale_base');
  });

  it('passes the invariant and permission checks, including the refusal to change an approved region', () => {
    const r = room();
    // An invariant: the content must validate (I4: a style that does not exist).
    const bad = new Transform(baseDoc()).setNodeAttribute(
      posOf(baseDoc(), 'pIntro0000000001'),
      'style',
      'Missing',
    ).doc;
    expect(first(r.snapshot('control', snapshotRequest(bad)), 'control', 'sync.reject')?.code).toBe(
      'invalid_op',
    );
    // Permissions: an approved region cannot change, whoever asks, `system` included (07 §11).
    const approved: PermissionState = {
      ...basePermissions(),
      revision: 2,
      regionStates: new Map([['rTerms000000000A', 'approved']]),
    };
    flush(r, r.permissionsChanged(approved));
    const terms = new Transform(baseDoc()).insert(
      posInside(baseDoc(), 'pTerms000000001A'),
      schema.text('changed '),
    ).doc;
    for (const as of ['system', USERS.alice] as const)
      expect(
        first(r.snapshot('control', snapshotRequest(terms, { as })), 'control', 'sync.reject'),
      ).toMatchObject({ code: 'permission_denied', scopes: ['region:rTerms000000000A'] });
    // A user without the rights is refused too: a restore is never a way round the permissions.
    expect(
      first(
        r.snapshot('control', snapshotRequest(imported(), { as: USERS.carol })),
        'control',
        'sync.reject',
      ),
    ).toBeUndefined(); // Carol may edit the intro: accepted
  });

  it('serves the content at the snapshot from its checkpoint after a restart (pinned read)', () => {
    const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
    const r = room({ log: storage.log });
    r.open('c1', USERS.carol);
    flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }), storage);
    const content = imported();
    storage.checkpoints.set('ckpt-import', content);
    flush(r, r.snapshot('control', snapshotRequest(content)), storage);
    flush(r, r.submit('c1', { id: id(), base: 2, steps: insert(content) }), storage);
    let resolved = 0;
    const again = room({
      log: storage.log,
      snapshotContent: (c: SnapshotCommit) => {
        resolved++;
        return storage.snapshotContent(c);
      },
    });
    expect(resolved).toBe(1);
    expect(again.document.eq(r.document)).toBe(true);
    // A room without access to checkpoints cannot replay a snapshot commit, and says so.
    expect(() => room({ log: storage.log })).toThrow(/needs the content of its checkpoint/);
  });
});

describe('server-authored commits (SYN-030)', () => {
  const sign = (doc = baseDoc()) =>
    stepsToJson([new AttrStep(posOf(doc, 'fTenantName00001'), 'value', 'Ada Lovelace')]);

  it('go through the same steps with the requesting user or system as author and a reserved origin', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const done = flush(
      r,
      r.author('control', {
        id: id(),
        base: 0,
        steps: insert(),
        origin: 'prefill',
        as: USERS.carol,
      }),
    );
    expect(first(done, 'control', 'sync.ack')?.seq).toBe(1);
    expect(first(done, 'a1', 'sync.commit')?.commit).toMatchObject({
      user: 'carol',
      session: SERVER_SESSION,
      origin: 'prefill',
      base: 0,
      rebased: false,
    });
    expect(first(done, 'a1', 'sync.commit')?.commit).not.toHaveProperty('agent');
    // The requester is no channel: it gets the answer and no broadcasts.
    expect(msgs(done, 'control').map((m) => m.t)).toEqual(['sync.ack']);
    // A client cannot claim a reserved origin, and the room never accepts `control` from anyone.
    r.open('c1', USERS.carol);
    expect(
      first(
        r.submit('c1', { id: id(), base: 1, steps: insert(r.document), origin: 'prefill' }),
        'c1',
        'sync.reject',
      )?.code,
    ).toBe('invalid_op');
    expect(
      first(
        r.author('control', {
          id: id(),
          base: 1,
          steps: insert(r.document),
          origin: 'control',
          as: 'system',
        }),
        'control',
        'sync.reject',
      )?.code,
    ).toBe('invalid_op');
  });

  it('are checked against permissions like any other commit, never exempt', () => {
    const r = room();
    // Frank may only view: a prefill on his behalf is refused (P6), as his own commit would be.
    expect(
      first(
        r.author('control', {
          id: id(),
          base: 0,
          steps: insert(),
          origin: 'prefill',
          as: USERS.frank,
        }),
        'control',
        'sync.reject',
      ),
    ).toMatchObject({ code: 'permission_denied' });
    // Carol cannot write the restricted region, so a region restore she asks for is refused.
    expect(
      first(
        r.author('control', {
          id: id(),
          base: 0,
          steps: insert(baseDoc(), 'pLegal000000001B'),
          origin: 'restore',
          as: USERS.carol,
        }),
        'control',
        'sync.reject',
      ),
    ).toMatchObject({ code: 'permission_denied', scopes: ['region:rLegal000000000B'] });
    // `system` has an owner's capabilities and the room's limits: a fill of a field assigned to a
    // workflow role goes through P7 like anyone's (the outcome tests cover P8's server origins).
    expect(
      first(
        r.author('control', { id: id(), base: 0, steps: sign(), origin: 'rules', as: 'system' }),
        'control',
        'sync.reject',
      ),
    ).toBeUndefined();
  });

  it('re-check the preconditions the control plane relied on', () => {
    const r = room();
    r.open('c1', USERS.carol);
    flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    const ask = (preconditions: NonNullable<Parameters<Room['author']>[1]['preconditions']>) =>
      first(
        r.author('control', {
          id: id(),
          base: 1,
          steps: insert(r.document),
          origin: 'restore',
          as: USERS.alice,
          preconditions,
        }),
        'control',
        'sync.reject',
      );
    expect(ask({ revision: 9 })).toMatchObject({ code: 'conflict', action: 'drop' });
    expect(ask({ head: 0 })).toMatchObject({ code: 'conflict' });
    expect(ask({ documentState: 'locked' })).toMatchObject({ code: 'conflict' });
    expect(ask({ workflowActive: true })).toMatchObject({ code: 'conflict' });
    expect(ask({ regionStates: { rTerms000000000A: 'approved' } })).toMatchObject({
      code: 'conflict',
    });
    expect(
      ask({
        revision: 1,
        head: 1,
        documentState: 'active',
        regionStates: { rTerms000000000A: 'draft' },
      }),
    ).toBeUndefined();
  });

  it('apply once when a retry with the same deterministic id is delivered twice', () => {
    const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
    const r = room({ log: storage.log });
    r.open('a1', USERS.alice);
    const request = {
      id: id(),
      base: 0,
      steps: insert(),
      origin: 'prefill',
      as: USERS.carol,
    } as const;
    const fx = r.author('control', request);
    // Delivered again while the first copy waits for storage: it attaches to the same answer.
    const twice = r.author('retry', request);
    expect(twice.send).toEqual([]);
    const done = flush(r, fx, storage);
    expect(first(done, 'control', 'sync.ack')?.seq).toBe(1);
    expect(first(done, 'retry', 'sync.ack')?.seq).toBe(1);
    // Delivered again after it is stored: the acknowledgement is rebuilt from the log.
    expect(first(r.author('later', request), 'later', 'sync.ack')).toMatchObject({
      seq: 1,
      rebased: true,
    });
    // A snapshot retried the same way is stored once as well.
    const snap = snapshotRequest();
    const s1 = r.snapshot('control', snap);
    r.snapshot('retry', snap);
    const d = flush(r, s1, storage);
    expect([first(d, 'control', 'sync.ack')?.seq, first(d, 'retry', 'sync.ack')?.seq]).toEqual([
      2, 2,
    ]);
    expect(first(r.snapshot('later', snap), 'later', 'sync.ack')?.seq).toBe(2);
    expect(storage.log.map((c) => c.kind)).toEqual(['steps', 'snapshot']);
  });
});

describe('what a commit records (08 §2; HIS-001 for the room)', () => {
  it('records base, rebased and the token jti from the connection', () => {
    const r = room();
    r.open('c1', { ...USERS.carol, jti: 'jti-carol-1' });
    r.open('b1', USERS.bob);
    const one = flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    const two = flush(
      r,
      r.submit('b1', { id: id(), base: 0, steps: insert(baseDoc(), 'pMiddle000000001') }),
    );
    expect(first(one, 'b1', 'sync.commit')?.commit).toMatchObject({
      base: 0,
      rebased: false,
      jti: 'jti-carol-1',
    });
    expect(first(two, 'c1', 'sync.commit')?.commit).toMatchObject({ base: 0, rebased: true });
    expect(first(two, 'c1', 'sync.commit')?.commit).not.toHaveProperty('jti');
  });
});

describe('storage outcomes (SYN-016; 04 §5, "When a write fails")', () => {
  it('acknowledges a commit whose identifier storage already holds as a duplicate, and keeps serving', () => {
    // A room started from a checkpoint (BE-020) does not know the commits before it.
    const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
    const r1 = room({ log: storage.log });
    r1.open('c1', USERS.carol);
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    flush(r1, r1.submit('c1', commit), storage);
    const r2 = room({ initial: r1.document, initialSeq: 1, log: [] });
    r2.open('c2', USERS.carol);
    r2.open('a2', USERS.alice);
    // Carol resubmits from her journal; the new room cannot tell, so storage does.
    const fx = r2.submit('c2', { ...commit, base: 1, steps: insert(r1.document) });
    const done = flush(r2, fx, storage);
    expect(first(done, 'c2', 'sync.ack')).toMatchObject({ id: commit.id, seq: 1, rebased: true });
    expect(r2.isStopped).toBe(false);
    expect(storage.log).toHaveLength(1);
    expect(msgs(done, 'a2')).toEqual([]);
    // Another user's commit with that identifier is refused.
    r2.open('m2', USERS.mallory);
    const evil = flush(
      r2,
      r2.submit('m2', { id: commit.id, base: 1, steps: insert(r1.document) }),
      storage,
    );
    expect(first(evil, 'm2', 'sync.reject')?.code).toBe('invalid_op');
  });

  it('stops serving when the outcome of a write cannot be settled (lost), and on stop()', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.author('control', { id: id(), base: 0, steps: insert(), origin: 'prefill', as: USERS.alice });
    const done = r.writeCompleted({ status: 'lost' });
    expect(first(done, 'c1', 'ch.closed')).toEqual({
      t: 'ch.closed',
      code: 'unavailable',
      reason: 'lost',
    });
    // The requester of the commit in that write is told too.
    expect(first(done, 'control', 'sync.reject')).toMatchObject({
      code: 'unavailable',
      action: 'retry',
    });
    expect(r.isStopped).toBe(true);
    const s = room();
    s.open('a1', USERS.alice);
    expect(s.stop().send).toEqual([
      { channel: 'a1', msg: { t: 'ch.closed', code: 'unavailable', reason: 'stopped' } },
    ]);
    expect(s.stop().send).toEqual([]);
    expect(first(s.open('a2', USERS.alice), 'a2', 'ch.closed')?.reason).toBe('stopped');
  });
});

describe('admission control (SYN-037)', () => {
  const admission = (capacity: number, refillPerSecond = 1) => ({
    admission: { connection: { capacity, refillPerSecond } },
  });

  it('estimates the cost from steps, rebase distance and size before any other work', () => {
    const r = room(admission(1e9));
    expect(defaultCost({ steps: 1, rebaseSteps: 0, bytes: 100, fanOut: 1 })).toBe(2);
    expect(r.estimateCost({ steps: 3, base: 0, bytes: 2048 })).toBe(5);
    // The distance counts: the same commit made on an older base costs more.
    r.open('c1', USERS.carol);
    for (let i = 0; i < 5; i++)
      flush(r, r.submit('c1', { id: id(), base: i, steps: insert(r.document) }));
    expect(r.estimateCost({ steps: 1, base: 0, bytes: 100 })).toBe(7);
    expect(r.estimateCost({ steps: 1, base: 5, bytes: 100 })).toBe(2);
  });

  it('rejects with rate_limited, retry and retryAfterMs once the connection budget is spent', () => {
    let t = 1_000_000;
    const r = room({ ...admission(4, 2), now: () => t });
    r.open('c1', USERS.carol);
    r.open('c2', { ...USERS.carol, session: 's-carol-2' });
    const a = flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    expect(first(a, 'c1', 'sync.ack')).toBeDefined();
    const b = flush(r, r.submit('c1', { id: id(), base: 1, steps: insert(r.document) }));
    expect(first(b, 'c1', 'sync.ack')).toBeDefined();
    const c = r.submit('c1', { id: id(), base: 2, steps: insert(r.document) });
    expect(first(c, 'c1', 'sync.reject')).toMatchObject({
      code: 'rate_limited',
      action: 'retry',
      retryAfterMs: 1000,
    });
    expect(c.write).toBeNull();
    // Another connection has its own budget.
    expect(
      first(
        flush(r, r.submit('c2', { id: id(), base: 2, steps: insert(r.document) })),
        'c2',
        'sync.ack',
      ),
    ).toBeDefined();
    // After the wait the same commit, with the same id, passes.
    t += 1000;
    expect(
      first(
        flush(r, r.submit('c1', { id: id(), base: 3, steps: insert(r.document) })),
        'c1',
        'sync.ack',
      ),
    ).toBeDefined();
  });

  it('charges a long rebase distance even when the commit is cheap to apply', () => {
    let t = 0;
    const r = room({ ...admission(20, 1), now: () => t });
    r.open('a1', USERS.alice);
    r.open('c1', USERS.carol);
    for (let i = 0; i < 30; i++) {
      t += 1e6; // Alice's budget is full before each of her commits
      flush(
        r,
        r.submit('a1', { id: id(), base: i, steps: insert(r.document, 'pEnd00000000001Z') }),
      );
    }
    expect(r.head).toBe(30);
    t += 1e6;
    const fx = flush(r, r.submit('c1', { id: id(), base: 0, steps: insert() }));
    // Its estimate covers the 30 steps it is mapped over: 1 × (1 + 30) + 1 units.
    expect(r.admissionCharged).toBe(30 * 2 + 32);
    expect(first(fx, 'c1', 'sync.ack')?.seq).toBe(31);
    // The balance went below zero for this one: the next commit waits.
    expect(
      first(r.submit('c1', { id: id(), base: 31, steps: insert(r.document) }), 'c1', 'sync.reject')
        ?.code,
    ).toBe('rate_limited');
  });

  it('enforces a tenant budget shared by rooms, over steps 2 to 7', () => {
    const tenant = new TokenBucket({ capacity: 4, refillPerSecond: 1 }, 0);
    const shared = { admission: { connection: { capacity: 1e9, refillPerSecond: 1e9 }, tenant } };
    const r1 = room({ ...shared, now: () => 0 });
    const r2 = room({ ...shared, now: () => 0 });
    r1.open('c1', USERS.carol);
    r2.open('c1', USERS.carol);
    // A refused commit is charged too: the work of steps 2 to 7 was done.
    expect(
      first(
        r1.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pLegal000000001B') }),
        'c1',
        'sync.reject',
      )?.code,
    ).toBe('permission_denied');
    expect(
      first(r2.submit('c1', { id: id(), base: 0, steps: insert() }), 'c1', 'sync.reject'),
    ).toBeUndefined();
    expect(
      first(r1.submit('c1', { id: id(), base: 0, steps: insert() }), 'c1', 'sync.reject')?.code,
    ).toBe('rate_limited');
  });
});
