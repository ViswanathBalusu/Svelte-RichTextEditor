// SYN-027 criteria 1 and 3 on the room: a channel that resumes with `catchUp: "stream"` receives
// the missing commits, then `sync.caughtUp`, then the live commits, each seq once and in order,
// even when commits are stored while the stream is being sent; and an acknowledgement is never
// sent before a lower commit on the same channel (SYN-015). The room is synchronous, so "while
// being sent" is modelled as the host holding the effects it has not yet delivered: every effect
// the room returns for the channel, in order, is what the channel receives. The wire queue is BE's.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { CommitInput, Effects, Resume, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const T0 = 1_790_400_000_000;
const id = (n: number): string => `0192f0c4-9200-7000-8000-${n.toString(16).padStart(12, '0')}`;

function room(init: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-stream',
    now: () => T0,
    ...init,
  });
}

function insertCommit(doc: Node, paragraph: string, n: number, base: number): CommitInput {
  const pos = posInside(doc, paragraph);
  return {
    id: id(n),
    base,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(`e${n}`)), 0, 0)),
    ]),
  };
}

/** Completes the write the room asked for, as a storage would; returns the effects of the store. */
function store(r: Room): Effects {
  return r.writeCompleted({ status: 'ok' });
}

/** The messages a channel receives from one effects value, in order. */
function forChannel(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((s) => s.channel === channel).map((s) => s.msg);
}

const seqsOf = (msgs: ToClient[]): number[] =>
  msgs.flatMap((m) => (m.t === 'sync.commit' ? [m.commit.seq] : []));

describe('a stream catch-up joins the missing and live commits (SYN-027 criteria 1 and 3)', () => {
  it('delivers each commit once and in order when commits are stored during the stream', () => {
    const r = room();
    r.open('w', USERS.carol);
    // Commits 1 to 3 are stored before the reader resumes at seq 1.
    for (let n = 1; n <= 3; n++) {
      r.submit('w', insertCommit(r.document, 'pIntro0000000001', n, r.head));
      store(r);
    }
    expect(r.head).toBe(3);

    const resume: Resume = { seq: 1, incarnation: r.incarnation, inflight: null };
    const opened = r.open('late', USERS.alice, resume);
    const delivered: ToClient[] = [...forChannel(opened, 'late')];
    expect(delivered[0]?.t).toBe('ch.opened');

    // Commits 4 and 5 are stored while the missing commits 2 and 3 are still being sent.
    delivered.push(
      ...forChannel(r.submit('w', insertCommit(r.document, 'pMiddle000000001', 4, r.head)), 'late'),
    );
    delivered.push(...forChannel(store(r), 'late'));
    delivered.push(
      ...forChannel(r.submit('w', insertCommit(r.document, 'pTerms000000001A', 5, r.head)), 'late'),
    );
    delivered.push(...forChannel(store(r), 'late'));

    const seqs = seqsOf(delivered);
    expect(seqs).toEqual([2, 3, 4, 5]);
    expect(new Set(seqs).size).toBe(seqs.length);

    const caught = delivered.findIndex((m) => m.t === 'sync.caughtUp');
    const commitIndex = (seq: number) =>
      delivered.findIndex((m) => m.t === 'sync.commit' && m.commit.seq === seq);
    expect(caught).toBeGreaterThan(commitIndex(3));
    expect(caught).toBeLessThan(commitIndex(4));
  });

  it('never sends an acknowledgement before a lower commit on the same channel', () => {
    const r = room();
    r.open('w', USERS.carol);
    r.open('late', USERS.alice);
    // Commit 1 is stored. Commit 2 by `w` is in its write when `late` submits commit 3 based on 1.
    r.submit('w', insertCommit(r.document, 'pIntro0000000001', 1, r.head));
    store(r);
    const fxW = r.submit('w', insertCommit(r.document, 'pMiddle000000001', 2, r.head));
    expect(fxW.write?.commits[0]?.seq).toBe(2);
    const doc1 = r.document;
    const fxL = r.submit('late', insertCommit(doc1, 'pTerms000000001A', 3, 1));
    expect(forChannel(fxL, 'late'), 'nothing for the author before its write').toEqual([]);

    // Storing commit 2 broadcasts it to `late`; storing commit 3 then acknowledges `late`.
    const toLate = [...forChannel(store(r), 'late'), ...forChannel(store(r), 'late')];

    const commitIndex = toLate.findIndex((m) => m.t === 'sync.commit' && m.commit.seq === 2);
    const ackIndex = toLate.findIndex((m) => m.t === 'sync.ack' && m.id === id(3));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeGreaterThan(commitIndex);
  });
});
