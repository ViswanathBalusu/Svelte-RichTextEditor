// SYN-041 criterion 4: with few subscribers, a stored commit is sent without added delay. The room
// has no coalescing window (SYN-041 criteria 1 to 3 are not built): every fan-out happens in the
// same synchronous call that completes the write, and nothing waits for a timer.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import { type CommitInput, type Effects, type ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_790_200_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-a000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-timing',
    now: () => ++clock,
    ...extra,
  });
}

const typed = (r: Room, text: string, base = r.head): CommitInput => {
  const pos = posInside(r.document, 'pIntro0000000001');
  return {
    id: id(),
    base,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
    ]),
  };
};

const msgs = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((o) => o.channel === channel).map((o) => o.msg);

describe('fan-out without added delay (SYN-041 criterion 4)', () => {
  it('sends a stored commit to every other subscriber in the call that completes its write', () => {
    const r = room();
    r.open('a1', USERS.alice);
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);

    const submitted = r.submit('a1', typed(r, 'X'));
    // Synchronous: a returned promise or a timer would make the fan-out later than this call.
    expect(submitted).not.toBeInstanceOf(Promise);
    expect(submitted.write).not.toBeNull();
    expect(submitted.send).toEqual([]);

    const done = r.writeCompleted({ status: 'ok' });
    expect(done).not.toBeInstanceOf(Promise);
    expect(msgs(done, 'a1').map((m) => m.t)).toEqual(['sync.ack']);
    for (const ch of ['c1', 'b1']) {
      expect(
        msgs(done, ch).map((m) => m.t),
        ch,
      ).toEqual(['sync.commit']);
      expect(msgs(done, ch)[0], ch).toMatchObject({ t: 'sync.commit', commit: { seq: 1 } });
    }
  });

  it('keeps one message per commit and in ascending seq when two commits are stored in turn', () => {
    const r = room();
    r.open('a1', USERS.alice);
    r.open('c1', USERS.carol);
    for (let i = 1; i <= 2; i++) {
      r.submit('a1', typed(r, String(i)));
      const done = r.writeCompleted({ status: 'ok' });
      const commits = msgs(done, 'c1').filter((m) => m.t === 'sync.commit');
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ commit: { seq: i } });
    }
  });
});
