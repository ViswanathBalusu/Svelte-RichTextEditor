// SYN-039 criterion 4: steps 2 to 7 of the authority algorithm stay on the room's loop. The room
// is a synchronous state machine: no method is async and a commit is validated, rebased, applied
// and checked in the call that submits it, so nothing can be pre-empted between those steps.
// SYN-037 bounds the work of those steps (its tests are in room-commits.test.ts).
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import { type CommitInput } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_790_300_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-b000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-sync',
    now: () => ++clock,
    ...extra,
  });
}

const typed = (r: Room, text: string): CommitInput => {
  const pos = posInside(r.document, 'pIntro0000000001');
  return {
    id: id(),
    base: r.head,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
    ]),
  };
};

const isAsync = (fn: unknown): boolean =>
  typeof fn === 'function' && fn.constructor.name === 'AsyncFunction';

describe("the room's loop (SYN-039 criterion 4)", () => {
  it('has no async method: every step of the algorithm runs to completion in the calling tick', () => {
    const proto = Room.prototype as unknown as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(Room.prototype).filter((n) => n !== 'constructor');
    expect(methods.length).toBeGreaterThan(10);
    for (const name of methods) {
      const desc = Object.getOwnPropertyDescriptor(Room.prototype, name);
      if (typeof desc?.value === 'function') expect(isAsync(proto[name]), name).toBe(false);
    }
  });

  it('validates, rebases, applies and checks a commit within the call that submits it', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const fx = r.submit('c1', typed(r, 'Q'));
    // Nothing is awaited: the decision and the write request are already in the returned effects.
    expect(fx).not.toBeInstanceOf(Promise);
    expect(fx.write?.commits[0]).toMatchObject({ seq: 1, user: 'carol' });
    expect(r.head).toBe(0);
    const done = r.writeCompleted({ status: 'ok' });
    expect(done).not.toBeInstanceOf(Promise);
    expect(r.head).toBe(1);
    expect(done.send.find((o) => o.msg.t === 'sync.ack')).toMatchObject({
      msg: { t: 'sync.ack', seq: 1 },
    });
  });

  it('refuses a commit that would be too expensive within the same call (SYN-037 bound, synchronous)', () => {
    const r = room({
      limits: { ...DEFAULT_LIMITS, maxStepsPerCommit: 1 },
    });
    r.open('c1', USERS.carol);
    const pos = posInside(r.document, 'pIntro0000000001');
    const two = [
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('a')), 0, 0)),
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('b')), 0, 0)),
    ];
    const fx = r.submit('c1', { id: id(), base: 0, steps: stepsToJson(two) });
    expect(fx).not.toBeInstanceOf(Promise);
    expect(fx.write).toBeNull();
    expect(fx.send.find((o) => o.msg.t === 'sync.reject')).toBeDefined();
  });
});
