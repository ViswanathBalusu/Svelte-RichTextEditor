// SYN-012 criterion 3 and 4 (lane V-SYN-001-018): a wrongly typed value is refused with invalid_op
// for a user who may edit the document (I15, 04 §5 step 6), and with field_invalid only for a user
// who holds `fill` and not `edit` (P7, 12 §4.2). The room is the real one, over the fixtures.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posOf, schema } from './fixtures.ts';

let clock = 1_780_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-9000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-syn-012-p7',
    now: () => ++clock,
    ...extra,
  });
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}
function rejectOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}
function ackOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.ack');
  return m && m.t === 'sync.ack' ? m : null;
}
function flush(r: Room, fx: Effects): Effects {
  const all: Effects = { send: [...fx.send], write: null };
  let write = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    write = done.write;
  }
  return all;
}

describe('a wrongly typed value (SYN-012 criteria 3 and 4)', () => {
  it('refuses an oversized value from an editor with invalid_op and the I15 reason', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const steps = [new AttrStep(pos, 'value', 'x'.repeat(4097))];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(rejectOf(fx, 'a1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(String(rejectOf(fx, 'a1')?.reason)).toContain('I15');
    expect(ackOf(fx, 'a1')).toBeNull();
    expect(r.head).toBe(0);
  });

  it('refuses a number in a text field from an editor with invalid_op', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const steps = [new AttrStep(pos, 'value', 42)];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(rejectOf(fx, 'a1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(ackOf(fx, 'a1')).toBeNull();
  });

  it('refuses the same wrongly typed value from a filler with field_invalid (P7)', () => {
    const r = room();
    r.open('e1', USERS.erin);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const steps = [new AttrStep(pos, 'value', 42)];
    const fx = flush(r, r.submit('e1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(rejectOf(fx, 'e1')).toMatchObject({ code: 'field_invalid', action: 'drop' });
    expect(ackOf(fx, 'e1')).toBeNull();
  });
});
