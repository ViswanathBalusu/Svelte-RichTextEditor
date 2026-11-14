// Resume and catch-up (04 §9; SYN-026, SYN-029; ADR 0034, proposed) and the visibility gate on
// resume (07 §8, 08 §9; PRM-041, HIS-023, HIS-024).
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Limits } from '../src/codes.ts';
import { minVisibleSeq, stateVisible } from '../src/room/gate.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, Resume, RoomConnection, ToClient, WriteRequest } from '../src/room/types.ts';
import { commitBytes, stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { SimClient, resetIds } from './harness/client.ts';
import { MemoryStorage } from './harness/storage.ts';

let clock = 1_800_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function roomOver(storage: MemoryStorage, extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: storage.initial,
    requires: storage.requires,
    log: storage.log,
    perms: storage.perms,
    initialRevision: storage.initialRevision,
    epoch: storage.epoch,
    incarnation: storage.incarnation,
    now: () => (clock += 10),
    ...extra,
  });
}

const insert = (doc = baseDoc(), text = 'x') => {
  const pos = posInside(doc, 'pIntro0000000001');
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
};
const opened = (fx: Effects, channel: string) => {
  const m = fx.send.find((o) => o.channel === channel)?.msg;
  if (m?.t !== 'ch.opened') throw new Error(`no ch.opened on ${channel}`);
  return m;
};
const types = (fx: Effects, channel: string) =>
  fx.send.filter((o) => o.channel === channel).map((o) => o.msg.t);

/** A storage whose log holds `n` commits by Alice, each stored at once. */
function withCommits(
  n: number,
  extra: Partial<RoomInit> = {},
): { storage: MemoryStorage; room: Room } {
  const storage = new MemoryStorage(baseDoc(), REQUIRES, basePermissions());
  const room = roomOver(storage, extra);
  room.open('alice', USERS.alice);
  for (let i = 0; i < n; i++) {
    let fx: Effects = room.submit('alice', { id: id(), base: i, steps: insert(room.document) });
    let w: WriteRequest | null = fx.write;
    while (w) {
      fx = room.writeCompleted(storage.write(w, 'none'));
      w = fx.write;
    }
  }
  room.close('alice');
  return { storage, room };
}

const resumeAt = (seq: number, extra: Partial<Resume> = {}): Resume => ({
  seq,
  incarnation: 'inc-1',
  inflight: null,
  ...extra,
});

describe('how a resuming channel catches up (SYN-026; ADR 0034)', () => {
  it('answers with head, incarnation, catchUp and inflight', () => {
    const { room } = withCommits(3);
    const fx = room.open('c1', USERS.carol, resumeAt(1, { inflight: id() }));
    expect(opened(fx, 'c1')).toMatchObject({
      head: 3,
      incarnation: 'inc-1',
      catchUp: 'stream',
      inflight: { state: 'unknown' },
    });
    expect(types(fx, 'c1')).toEqual(['ch.opened', 'sync.commit', 'sync.commit', 'sync.caughtUp']);
  });

  it('reloads without a resume, under another incarnation, or from a seq beyond the head', () => {
    const { room } = withCommits(2);
    const cases: Array<Resume | undefined> = [
      undefined,
      resumeAt(1, { incarnation: 'inc-0' }),
      resumeAt(3),
      resumeAt(-1),
    ];
    cases.forEach((resume, i) => {
      const fx = room.open(`c${i}`, USERS.carol, resume);
      expect(opened(fx, `c${i}`).catchUp, JSON.stringify(resume)).toBe('reload');
      expect(types(fx, `c${i}`)).toEqual(['ch.opened']);
      expect(opened(fx, `c${i}`).content).toMatchObject({ seq: 2, incarnation: 'inc-1' });
    });
  });

  it('streams within the catch-up limits, and pages or reloads beyond them', () => {
    const limits = (catchUpCommits: number, catchUpBytes = 1 << 30): Limits => ({
      maxStepsPerCommit: 500,
      maxCommitBytes: 1 << 20,
      maxRebaseSteps: 5000,
      catchUpCommits,
      catchUpBytes,
    });
    const at = (extra: Partial<RoomInit>) => {
      const { room } = withCommits(4, extra);
      return opened(room.open('c1', USERS.carol, resumeAt(0)), 'c1').catchUp;
    };
    expect(at({ limits: limits(4) })).toBe('stream');
    expect(at({ limits: limits(3) })).toBe('reload');
    expect(at({ limits: limits(3), commitsResource: true })).toBe('page');
    // The byte limit counts the commits' serialised size.
    const { storage } = withCommits(4);
    const bytes = storage.log.reduce((a, c) => a + commitBytes(c), 0);
    expect(at({ limits: limits(10, bytes) })).toBe('stream');
    expect(at({ limits: limits(10, bytes - 1), commitsResource: true })).toBe('page');
    // The defaults are 04 §9's: 5,000 commits and 5 MiB.
    expect(at({})).toBe('stream');
  });

  it('pages: no commit is streamed, the client reads them over REST and goes live from the head', () => {
    resetIds();
    const { storage, room } = withCommits(3, {
      limits: {
        maxStepsPerCommit: 500,
        maxCommitBytes: 1 << 20,
        maxRebaseSteps: 5000,
        catchUpCommits: 1,
      },
      commitsResource: true,
    });
    const carol = new SimClient('carol', USERS.carol, false);
    carol.connect();
    for (const o of room.open('carol#1', USERS.carol).send) carol.receive(o.msg);
    // Carol is at seq 3; she disconnects, two more commits arrive.
    carol.disconnected();
    room.close('carol#1');
    room.open('alice', USERS.alice);
    for (let i = 3; i < 5; i++) {
      const fx = room.submit('alice', { id: id(), base: i, steps: insert(room.document) });
      room.writeCompleted(storage.write(fx.write!, 'none'));
    }
    carol.connect();
    const resume = carol.outbox.shift()!;
    if (resume.t !== 'open') throw new Error('expected an open');
    // From seq 3 she is two commits behind, beyond the limit of one: page.
    const fx = room.open(resume.channel, USERS.carol, resume.resume);
    expect(types(fx, resume.channel)).toEqual(['ch.opened']);
    for (const o of fx.send) carol.receive(o.msg);
    expect(carol.paging).toBe(true);
    carol.paged(storage.log.filter((c) => c.kind !== 'snapshot') as never);
    expect(carol.confirmedSeq).toBe(5);
    expect(carol.confirmed!.eq(room.document)).toBe(true);
    expect(carol.idle).toBe(true);
  });

  it('reloads when a snapshot commit lies after the resume point', () => {
    const { room } = withCommits(2);
    const content = new Transform(room.document).insert(
      posInside(room.document, 'pIntro0000000001'),
      schema.text('imported '),
    ).doc;
    room.writeCompleted({ status: 'ok' });
    const fx = room.snapshot('control', {
      id: id(),
      reason: 'import',
      content,
      checkpoint: 'ckpt',
      as: 'system',
    });
    room.writeCompleted({ status: 'ok' });
    void fx;
    expect(opened(room.open('c1', USERS.carol, resumeAt(1)), 'c1').catchUp).toBe('reload');
    expect(opened(room.open('c2', USERS.carol, resumeAt(3)), 'c2').catchUp).toBe('stream');
  });

  it("reports inflight as accepted with its seq only for the caller's own stored commit", () => {
    const { storage, room } = withCommits(2);
    const mine = storage.log[1]!.id; // Alice's
    expect(
      opened(room.open('a1', USERS.alice, resumeAt(1, { inflight: mine })), 'a1').inflight,
    ).toEqual({
      state: 'accepted',
      seq: 2,
    });
    expect(
      opened(room.open('m1', USERS.mallory, resumeAt(1, { inflight: mine })), 'm1').inflight,
    ).toEqual({
      state: 'unknown',
    });
    // Also on a reload (05 §5.2 as decided in S6, D08): the field follows `resume.inflight`.
    expect(
      opened(room.open('a2', USERS.alice, resumeAt(9, { inflight: mine })), 'a2'),
    ).toMatchObject({
      catchUp: 'reload',
      inflight: { state: 'accepted', seq: 2 },
    });
  });
});

describe('the visibility gate on resume (PRM-041; HIS-023; ADR 0034)', () => {
  it('lets editors stream and tells everyone else to reload under the default setting, editors', () => {
    const { room } = withCommits(3);
    for (const [user, expected] of [
      [USERS.carol, 'stream'],
      [USERS.bob, 'stream'],
      [USERS.frank, 'reload'],
      [USERS.dave, 'reload'],
      [USERS.erin, 'reload'],
    ] as const) {
      const fx = room.open(user.sub, user, resumeAt(1));
      expect(opened(fx, user.sub).catchUp, user.sub).toBe(expected);
      if (expected === 'reload')
        expect(
          fx.send.filter((o) => o.msg.t === 'sync.commit'),
          user.sub,
        ).toEqual([]);
    }
    // At the head nothing old is sent, so anyone may stream.
    expect(opened(room.open('f-head', USERS.frank, resumeAt(3)), 'f-head').catchUp).toBe('stream');
  });

  it('follows the settings all and since_access, the latter with the token access_since claim', () => {
    const all = withCommits(3, { historyVisibility: 'all' }).room;
    expect(opened(all.open('f1', USERS.frank, resumeAt(0)), 'f1').catchUp).toBe('stream');
    const { storage, room } = withCommits(4, { historyVisibility: 'since_access' });
    const times = storage.log.map((c) => c.time);
    const frank = (accessSince?: number): RoomConnection =>
      accessSince === undefined ? USERS.frank : { ...USERS.frank, accessSince };
    // Access since just after commit 2: the state at 2 was current then, so seq 2 and later stream.
    const since = times[1]! + 1;
    expect(room.minVisibleSeq(frank(since))).toBe(2);
    expect(opened(room.open('f1', frank(since), resumeAt(2)), 'f1').catchUp).toBe('stream');
    expect(opened(room.open('f2', frank(since), resumeAt(1)), 'f2').catchUp).toBe('reload');
    // Access since before the first commit: full history.
    expect(room.minVisibleSeq(frank(times[0]! - 1))).toBe(0);
    // No claim: the gate fails closed at the head, for editors too.
    expect(room.minVisibleSeq(frank())).toBe(4);
    expect(room.minVisibleSeq(USERS.carol)).toBe(4);
    expect(opened(room.open('c1', USERS.carol, resumeAt(3)), 'c1').catchUp).toBe('reload');
  });

  it('recomputes the gate when access changes: a grant of edit opens history, its removal closes it', () => {
    const { storage, room } = withCommits(3);
    expect(room.minVisibleSeq(USERS.frank)).toBe(3);
    const granted = storage.changePermissions((p) => ({
      ...p,
      grants: [
        ...p.grants,
        { region: 'rNotes000000000C', principal: 'user:frank', role: 'editor', expiresAt: null },
      ],
    }));
    room.permissionsChanged(granted);
    expect(room.minVisibleSeq(USERS.frank)).toBe(0);
    expect(opened(room.open('f1', USERS.frank, resumeAt(1)), 'f1').catchUp).toBe('stream');
    room.permissionsChanged(
      storage.changePermissions((p) => ({ ...p, grants: basePermissions().grants })),
    );
    expect(opened(room.open('f2', USERS.frank, resumeAt(1)), 'f2').catchUp).toBe('reload');
    // A lock does not take history away from editors (07 §4 limits do not count).
    room.permissionsChanged(storage.changePermissions((p) => ({ ...p, documentState: 'locked' })));
    expect(room.minVisibleSeq(USERS.carol)).toBe(0);
  });

  it('never blocks the head, and admits named versions for single-state reads', () => {
    const g = { setting: 'editors' as const, editsSomewhere: false, head: 7, timeOf: () => 0 };
    const min = minVisibleSeq(g);
    expect(min).toBe(7);
    expect(stateVisible(min, 7, 7)).toBe(true);
    expect(stateVisible(min, 3, 7)).toBe(false);
    expect(stateVisible(min, 3, 7, (s) => s === 3)).toBe(true);
  });
});

describe('the log incarnation (SYN-029)', () => {
  it('reloads a client that resumes with the incarnation of a rewound log; its unconfirmed work goes to recovered edits', () => {
    resetIds();
    const { storage, room } = withCommits(5);
    const carol = new SimClient('carol', USERS.carol, false);
    carol.connect();
    for (const o of room.open('carol#1', USERS.carol).send) carol.receive(o.msg);
    expect(carol.confirmedSeq).toBe(5);
    // Carol types something that is not yet sent; then the database is restored to seq 3 and the
    // operator gives the log a new incarnation (06 §8, §9).
    expect(carol.edit(0, 0, 0, 'lost?')).toBe(true);
    carol.disconnected();
    storage.rewind(3, 'inc-2');
    const restored = roomOver(storage, { epoch: storage.claimOwnership() });
    carol.connect();
    const open = carol.outbox.shift()!;
    if (open.t !== 'open') throw new Error('expected an open');
    expect(open.resume).toMatchObject({ seq: 5, incarnation: 'inc-1' });
    const fx = restored.open(open.channel, USERS.carol, open.resume);
    expect(opened(fx, open.channel)).toMatchObject({
      catchUp: 'reload',
      head: 3,
      incarnation: 'inc-2',
    });
    for (const o of fx.send) carol.receive(o.msg as ToClient);
    expect(carol.confirmedSeq).toBe(3);
    expect(carol.incarnation).toBe('inc-2');
    expect(carol.recovered).toBeGreaterThan(0);
    expect(carol.confirmed!.eq(restored.document)).toBe(true);
  });

  it('reloads a client whose seq is beyond the head under the same incarnation', () => {
    const { room } = withCommits(2);
    expect(opened(room.open('c1', USERS.carol, resumeAt(5)), 'c1')).toMatchObject({
      catchUp: 'reload',
      head: 2,
      incarnation: 'inc-1',
    });
  });

  it('names the incarnation in every content read it sends', () => {
    const { room } = withCommits(1);
    expect(opened(room.open('c1', USERS.carol), 'c1').content).toMatchObject({
      seq: 1,
      incarnation: 'inc-1',
    });
  });
});
