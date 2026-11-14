// Step 1 of the authority algorithm (SYN-007 criterion 5): the size limits (SYN-003) and admission
// control (SYN-037) run before any deduplication, rebase or apply work. A resubmission of a commit
// the room has already stored is therefore still limited: an oversized or over-budget retry is
// refused with its own code, and only a retry within the limits is answered as a duplicate.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/codes.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const ID = '0192f0c4-7b1e-7000-8000-0000000c0de1';

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-order',
    now: () => 1_790_000_000_000,
    ...extra,
  });
}

/** `count` single-character inserts into the introduction. */
const insert = (doc = baseDoc(), count = 1) => {
  const pos = posInside(doc, 'pIntro0000000001');
  const steps = Array.from({ length: count }, (_, i) => {
    const at = pos + i;
    return new ReplaceStep(at, at, new Slice(Fragment.from(schema.text('x')), 0, 0));
  });
  return stepsToJson(steps);
};

const first = <T extends ToClient['t']>(fx: Effects, channel: string, t: T) =>
  fx.send
    .filter((o) => o.channel === channel)
    .map((o) => o.msg)
    .find((m) => m.t === t) as Extract<ToClient, { t: T }> | undefined;

/** Submits, then stores the commit and returns the effects of the stored write. */
function submitAndStore(r: Room, steps: ReturnType<typeof insert>): Effects {
  const sub = r.submit('c1', { id: ID, base: 0, steps });
  expect(sub.write).not.toBeNull();
  return r.writeCompleted({ status: 'ok' });
}

describe('submission order (SYN-007 criterion 5)', () => {
  it('still refuses an oversized retry of a stored commit as too_large, before the duplicate check', () => {
    const r = room({ limits: { ...DEFAULT_LIMITS, maxStepsPerCommit: 1 } });
    r.open('c1', USERS.carol);
    const stored = submitAndStore(r, insert());
    expect(first(stored, 'c1', 'sync.ack')).toBeDefined();
    // Same identifier, two steps: the limit is checked first, so this is not a duplicate ack.
    const retry = r.submit('c1', { id: ID, base: 0, steps: insert(r.document, 2) });
    expect(first(retry, 'c1', 'sync.reject')).toMatchObject({ code: 'too_large' });
    expect(first(retry, 'c1', 'sync.ack')).toBeUndefined();
    expect(retry.write).toBeNull();
  });

  it('refuses an over-budget retry of a stored commit with rate_limited before the duplicate check', () => {
    // Capacity for exactly one commit of this size (defaultCost is 2 for one step of 100 bytes),
    // and no refill while the clock stands still.
    const r = room({ admission: { connection: { capacity: 2, refillPerSecond: 1 } } });
    r.open('c1', USERS.carol);
    const stored = submitAndStore(r, insert());
    expect(first(stored, 'c1', 'sync.ack')).toBeDefined();
    const retry = r.submit('c1', { id: ID, base: 0, steps: insert() });
    expect(first(retry, 'c1', 'sync.reject')).toMatchObject({ code: 'rate_limited' });
    expect(first(retry, 'c1', 'sync.ack')).toBeUndefined();
    expect(retry.write).toBeNull();
  });

  it('answers a retry within the limits and budget as a duplicate (SYN-008 still holds)', () => {
    const r = room({ limits: { ...DEFAULT_LIMITS, maxStepsPerCommit: 1 } });
    r.open('c1', USERS.carol);
    const steps = insert();
    expect(first(submitAndStore(r, steps), 'c1', 'sync.ack')).toBeDefined();
    const retry = r.submit('c1', { id: ID, base: 0, steps });
    expect(first(retry, 'c1', 'sync.reject')).toBeUndefined();
    expect(first(retry, 'c1', 'sync.ack')).toBeDefined();
    expect(retry.write).toBeNull();
  });
});
