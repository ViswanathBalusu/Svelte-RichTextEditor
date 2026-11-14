// SEC-028 criterion 4 (lane V-SEC-017-032): a commit whose processing throws is rejected with
// `invalid_op`, the exception is counted, and the room keeps serving: the other channel still
// receives commits, and the next valid commit from the same channel is acknowledged. The throw is
// injected by replacing the room's private `process` step for one call, since no fixture input
// is known to throw inside the room; the rejection and the counter are the room's own.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it, vi } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { CommitInput, Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const T0 = 1_790_400_000_000;
const id = (n: number): string => `0192f0c4-9300-7000-8000-${n.toString(16).padStart(12, '0')}`;

function room(init: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sec-028',
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
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(`x${n}`)), 0, 0)),
    ]),
  };
}

const forChannel = (fx: Effects, channel: string): ToClient[] =>
  fx.send.filter((s) => s.channel === channel).map((s) => s.msg);

describe('a commit whose validation throws is rejected and counted (SEC-028 criterion 4)', () => {
  it('rejects the throwing commit, counts it, and keeps serving the rooms channels', () => {
    const r = room();
    r.open('w', USERS.carol);
    r.open('other', USERS.alice);
    expect(r.validationExceptions).toBe(0);

    // The next processing call throws, as a validator would on an unexpected input.
    const spy = vi.spyOn(r as unknown as { process: (...a: unknown[]) => Effects }, 'process');
    spy.mockImplementationOnce(() => {
      throw new Error('validator failure');
    });
    const fxBad = r.submit('w', insertCommit(r.document, 'pIntro0000000001', 1, r.head));
    spy.mockRestore();

    const rejects = forChannel(fxBad, 'w').filter((m) => m.t === 'sync.reject');
    expect(rejects).toHaveLength(1);
    expect(rejects[0]).toMatchObject({ t: 'sync.reject', id: id(1), code: 'invalid_op' });
    expect(r.validationExceptions).toBe(1);
    expect(r.head).toBe(0);

    // The room is still serving: the same channel's next valid commit is written and acknowledged,
    // and the other channel is still open and receives the stored commit.
    const fxOk = r.submit('w', insertCommit(r.document, 'pIntro0000000001', 2, r.head));
    expect(fxOk.write?.commits[0]?.seq).toBe(1);
    const stored = r.writeCompleted({ status: 'ok' });
    expect(forChannel(stored, 'w').some((m) => m.t === 'sync.ack' && m.id === id(2))).toBe(true);
    expect(forChannel(stored, 'other').some((m) => m.t === 'sync.commit')).toBe(true);
    expect(r.validationExceptions).toBe(1);
  });
});
