// A follower node that never submits (SYN-042): fan-out in order, refused submissions, resumes
// from the held commits, no gap or duplicate after the upstream subscription is lost, and each
// viewer served under its own access, for readers of the whole document only (ADR 0019).
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
// The package entry, so that the test also proves the follower is exported.
import { FOLLOWER_REFUSAL, Follower, type FollowerViewer } from '../src/index.ts';
import { computeAccess } from '../src/permissions/access.ts';
import type { Connection, PermissionState } from '../src/permissions/model.ts';
import { Room, regionsOf } from '../src/room/room.ts';
import type { Effects, Outbound, Resume, StoredCommit, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_790_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(): Room {
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
  });
}

/** Completes every storage write the room asks for, as a store that always succeeds. */
function complete(r: Room, fx: Effects): Outbound[] {
  const out = [...fx.send];
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    out.push(...done.send);
    write = done.write;
  }
  return out;
}

/** The messages on one channel, in order. */
const on = (out: Outbound[], channel: string): ToClient[] =>
  out.filter((o) => o.channel === channel).map((o) => o.msg);

/** Feeds the upstream channel's messages to the follower; returns what the viewers receive. */
function feed(f: Follower, out: Outbound[], upstream: string): Outbound[] {
  const fanned: Outbound[] = [];
  for (const msg of on(out, upstream)) fanned.push(...f.upstream(msg));
  return fanned;
}

const seqsOn = (out: Outbound[], channel: string): number[] =>
  on(out, channel).flatMap((m) => (m.t === 'sync.commit' ? [m.commit.seq] : []));

/** A one-character insert in the first paragraph of the document, as steps JSON. */
function typing(r: Room, text: string) {
  const pos = posInside(r.document, 'pIntro0000000001');
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
}

/** A room, a follower on its channel `up` and a writer on `c1`. */
function setUp(init?: { catchUpCommits?: number }) {
  const r = room();
  const f = new Follower(init);
  feed(f, r.open('up', USERS.alice).send, 'up');
  r.open('c1', USERS.carol);
  return { r, f };
}

/** A viewer as the host would pass it: the user's own access, computed as the room computes it. */
function viewer(
  r: Room,
  user: Connection = USERS.frank,
  perms: PermissionState = basePermissions(),
  minVisibleSeq?: number,
): FollowerViewer {
  const access = computeAccess(user, regionsOf(r.document), perms, clock);
  return minVisibleSeq === undefined ? { access } : { access, minVisibleSeq };
}

function commit(r: Room, text: string): { stored: StoredCommit[]; fx: Outbound[] } {
  const fx = complete(r, r.submit('c1', { id: id(), base: r.head, steps: typing(r, text) }));
  const stored = on(fx, 'up').flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
  return { stored, fx };
}

describe('the follower fans out the room stream (SYN-042 criterion 1)', () => {
  it('gives each viewer the room commits, once and in ascending seq', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    f.open('v2', viewer(r, USERS.dave), f.resume());
    const toViewers: Outbound[] = [];
    const roomCommits: StoredCommit[] = [];
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      const { stored, fx } = commit(r, text);
      roomCommits.push(...stored);
      toViewers.push(...feed(f, fx, 'up'));
    }
    expect(roomCommits.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(seqsOn(toViewers, 'v1')).toEqual([1, 2, 3, 4, 5]);
    expect(seqsOn(toViewers, 'v2')).toEqual([1, 2, 3, 4, 5]);
    // The same commit objects, not copies with other content.
    const v1 = on(toViewers, 'v1').flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
    expect(v1).toEqual(roomCommits);
    expect(f.seq).toBe(5);
  });

  it('drops a repeat of a commit already held, and fans nothing out for it', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    const { stored, fx } = commit(r, 'a');
    feed(f, fx, 'up');
    expect(f.upstream({ t: 'sync.commit', commit: stored[0]! })).toEqual([]);
    expect(f.seq).toBe(1);
  });
});

describe('the follower refuses a viewer submission (SYN-042 criterion 2)', () => {
  it('answers read_only and never hands the commit to the room', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    const before = { head: r.head, doc: r.document.toString() };
    const out = f.submit('v1', { id: 'viewer-1', base: 0, steps: typing(r, 'x') });
    expect(out).toEqual([
      {
        channel: 'v1',
        msg: {
          t: 'sync.reject',
          id: 'viewer-1',
          code: 'read_only',
          action: 'drop',
          head: 0,
          reason: FOLLOWER_REFUSAL,
        },
      },
    ]);
    expect(r.head).toBe(before.head);
    expect(r.document.toString()).toBe(before.doc);
  });
});

describe('a resuming viewer is served from the held commits (SYN-042 criterion 3, part)', () => {
  it('streams the commits after its seq, then sync.caughtUp', () => {
    const { r, f } = setUp();
    for (const text of ['a', 'b', 'c', 'd', 'e']) feed(f, commit(r, text).fx, 'up');
    // A gate at 0, as for an editor or under `all` (07 §8).
    const out = f.open('late', viewer(r, USERS.frank, basePermissions(), 0), {
      seq: 2,
      incarnation: 'inc-1',
      inflight: null,
    } satisfies Resume);
    expect(on(out, 'late').map((m) => m.t)).toEqual([
      'ch.opened',
      'sync.commit',
      'sync.commit',
      'sync.commit',
      'sync.caughtUp',
    ]);
    expect(seqsOn(out, 'late')).toEqual([3, 4, 5]);
  });

  it('closes a viewer it cannot serve: another incarnation, a seq ahead, or beyond the window', () => {
    const { r, f } = setUp({ catchUpCommits: 2 });
    for (const text of ['a', 'b', 'c', 'd']) feed(f, commit(r, text).fx, 'up');
    const v = viewer(r, USERS.frank, basePermissions(), 0);
    const closed = { t: 'ch.closed', code: 'unavailable' };
    expect(on(f.open('x1', v, { seq: 3, incarnation: 'other', inflight: null }), 'x1')).toEqual([
      closed,
    ]);
    expect(on(f.open('x2', v, { seq: 9, incarnation: 'inc-1', inflight: null }), 'x2')).toEqual([
      closed,
    ]);
    expect(on(f.open('x3', v, { seq: 0, incarnation: 'inc-1', inflight: null }), 'x3')).toEqual([
      closed,
    ]);
    expect(on(f.open('x4', v, undefined), 'x4')).toEqual([closed]);
  });

  it('closes a resume from below the viewer history gate; without a gate only the head resumes', () => {
    const { r, f } = setUp();
    for (const text of ['a', 'b', 'c']) feed(f, commit(r, text).fx, 'up');
    const closed = { t: 'ch.closed', code: 'unavailable' };
    const at = (seq: number): Resume => ({ seq, incarnation: 'inc-1', inflight: null });
    expect(on(f.open('g1', viewer(r, USERS.frank, basePermissions(), 2), at(1)), 'g1')).toEqual([
      closed,
    ]);
    expect(on(f.open('g2', viewer(r), at(2)), 'g2')).toEqual([closed]);
    expect(seqsOn(f.open('g3', viewer(r, USERS.frank, basePermissions(), 2), at(2)), 'g3')).toEqual(
      [3],
    );
    expect(on(f.open('g4', viewer(r), at(3)), 'g4').map((m) => m.t)).toEqual([
      'ch.opened',
      'sync.caughtUp',
    ]);
  });
});

describe('the follower recovers after losing its subscription (SYN-042 criterion 4)', () => {
  it('neither skips nor repeats a commit: the viewer sees 1 to 5 once each', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    const seen: number[] = [];
    const all: Outbound[] = [];
    const roomStream: StoredCommit[] = [];
    for (const text of ['a', 'b']) {
      const { stored, fx } = commit(r, text);
      roomStream.push(...stored);
      all.push(...feed(f, fx, 'up'));
    }
    // Commit 3 is lost in transit: the follower sees 4 and 5 without it.
    const lost = commit(r, 'c');
    roomStream.push(...lost.stored);
    const fourFive = [commit(r, 'd'), commit(r, 'e')];
    for (const c of fourFive) {
      roomStream.push(...c.stored);
      all.push(...feed(f, c.fx, 'up'));
    }
    expect(f.stalled).toBe(true);
    seen.push(...seqsOn(all, 'v1'));
    expect(seen).toEqual([1, 2]);

    // Recovery: the upstream channel is reopened from the held head; the room sends what follows.
    const reopened = r.open('up', USERS.alice, f.resume());
    const recovered = feed(f, reopened.send, 'up');
    expect(f.stalled).toBe(false);
    // The re-sent stream repeats commits 1 to 5: none reaches the viewer twice.
    for (const c of roomStream) all.push(...f.upstream({ t: 'sync.commit', commit: c }));
    all.push(...recovered);
    expect(seqsOn(all, 'v1')).toEqual([1, 2, 3, 4, 5]);
    expect(f.seq).toBe(5);
  });
});

describe('each viewer is served under its own access (ADR 0019; ADR 0147 section 7)', () => {
  it("sends a viewer its own access in ch.opened, never the upstream channel's", () => {
    const { r, f } = setUp();
    const v = viewer(r);
    const opened = on(f.open('v1', v, f.resume()), 'v1')[0]!;
    expect(opened.t).toBe('ch.opened');
    if (opened.t !== 'ch.opened') return;
    expect(opened.access).toBe(v.access);
    expect(opened.access.docRole.has('manage')).toBe(false);
  });

  it('does not forward the upstream perm.changed; holds a viewer back until its own access is passed', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    feed(f, commit(r, 'a').fx, 'up');
    const next: PermissionState = { ...basePermissions(), revision: 2 };
    const changed = complete(r, r.permissionsChanged(next));
    expect(on(changed, 'up').some((m) => m.t === 'perm.changed')).toBe(true);
    const toViewers = feed(f, changed, 'up');
    toViewers.push(...feed(f, commit(r, 'b').fx, 'up'));
    // Nothing reaches the viewer: neither the upstream user's perm.changed nor the later commits.
    expect(on(toViewers, 'v1')).toEqual([]);
    // A stale access cannot open a new viewer either.
    expect(on(f.open('v2', viewer(r), f.resume()), 'v2')).toEqual([
      { t: 'ch.closed', code: 'unavailable' },
    ]);
    // The host passes the viewer's own recomputed access: perm.changed, then what was held back.
    const own = viewer(r, USERS.frank, next).access;
    const out = on(f.permissions('v1', own), 'v1');
    expect(out[0]).toEqual({ t: 'perm.changed', revision: 2, access: own });
    expect(seqsOn(f.permissions('v1', own), 'v1')).toEqual([]);
    expect(out.slice(1).map((m) => (m.t === 'sync.commit' ? m.commit.seq : -1))).toEqual(
      Array.from({ length: f.seq - 1 }, (_, i) => i + 2),
    );
    // Live commits flow again.
    expect(seqsOn(feed(f, commit(r, 'c').fx, 'up'), 'v1')).toEqual([f.seq]);
  });

  it('closes a viewer whose recomputed access is older than the newest revision', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    feed(f, complete(r, r.permissionsChanged({ ...basePermissions(), revision: 2 })), 'up');
    expect(on(f.permissions('v1', viewer(r).access), 'v1')).toEqual([
      { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
    ]);
    expect(f.viewerCount).toBe(0);
  });

  it('closes a non-owner viewer before a commit that adds a confidential region reaches it', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r), f.resume());
    f.open('owner', viewer(r, USERS.alice), f.resume());
    const { stored } = commit(r, 'a');
    const confidential: StoredCommit = {
      ...stored[0]!,
      steps: [{ stepType: 'attr', pos: 1, attr: 'policy', value: 'confidential' }],
    };
    const out = f.upstream({ t: 'sync.commit', commit: confidential });
    expect(on(out, 'v1')).toEqual([
      { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
    ]);
    expect(on(out, 'owner')).toEqual([{ t: 'sync.commit', commit: confidential }]);
    // A reader without `manage` is now sent to the room.
    expect(on(f.open('v2', viewer(r), f.resume()), 'v2')).toEqual([
      { t: 'ch.closed', code: 'unavailable' },
    ]);
  });

  it('closes a non-owner viewer before a commit that marks a field sensitive', () => {
    const { r, f } = setUp();
    f.open('v1', viewer(r, USERS.carol), f.resume());
    const { stored } = commit(r, 'a');
    const sensitive: StoredCommit = {
      ...stored[0]!,
      steps: [{ stepType: 'attr', pos: 1, attr: 'sensitive', value: true }],
    };
    expect(on(f.upstream({ t: 'sync.commit', commit: sensitive }), 'v1')).toEqual([
      { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
    ]);
  });

  it('serves nobody without manage until it has seen the content, and nobody over a restricted upstream', () => {
    const r = room();
    const f = new Follower();
    // The upstream channel resumes at the head, so the room sends no content.
    feed(f, r.open('up', USERS.alice, { seq: 0, incarnation: 'inc-1', inflight: null }).send, 'up');
    expect(on(f.open('v1', viewer(r), f.resume()), 'v1')).toEqual([
      { t: 'ch.closed', code: 'unavailable' },
    ]);
    expect(on(f.open('o1', viewer(r, USERS.alice), f.resume()), 'o1')[0]?.t).toBe('ch.opened');

    // An upstream channel without `manage` once the content may hide something: nobody is served.
    const g = new Follower();
    feed(g, r.open('up2', USERS.frank).send, 'up2');
    g.open('o2', viewer(r, USERS.alice), g.resume());
    r.open('c1', USERS.carol);
    const { stored } = commit(r, 'a');
    expect(stored).toHaveLength(1);
    const confidential: StoredCommit = {
      ...stored[0]!,
      steps: [{ stepType: 'attr', pos: 1, attr: 'policy', value: 'confidential' }],
    };
    expect(on(g.upstream({ t: 'sync.commit', commit: confidential }), 'o2')).toEqual([
      { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
    ]);
  });
});
