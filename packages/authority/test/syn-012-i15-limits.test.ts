// SYN-012 criterion 3 (lane U-SYN-001-018): the room refuses, with invalid_op, a commit that takes
// the document above 2,000 fields or gives a field value of more than 4 KiB (I15, 12 §3.6). The
// boundary is accepted: 2,000 fields and a 4,096-byte value are allowed. The rules limit (500) and
// the wrongly typed value (field_invalid or invalid_op, the open interaction with P7) are not
// covered here.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

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
    incarnation: 'inc-syn-012',
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
/** Stores whatever the room wants to write, and returns everything sent. */
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

/** `count` new form fields, each with its own identifier (16 characters) and key, inline in a paragraph. */
function newFields(count: number, prefix: string): Step[] {
  const doc = baseDoc();
  const at = posInside(doc, 'pIntro0000000001');
  const nodes = Array.from({ length: count }, (_, i) =>
    schema.nodes['form_field']!.create({
      id: `f${prefix}${String(i).padStart(11, '0')}`,
      key: `bulk.${prefix}.k${i}`,
      label: `Bulk ${i}`,
    }),
  );
  return [new ReplaceStep(at, at, new Slice(Fragment.from(nodes), 0, 0))];
}

describe('I15 limits through the room (SYN-012 criterion 3)', () => {
  it('refuses a commit that takes the document above 2,000 fields with invalid_op', () => {
    // The base document has one field, so 2,000 new fields make 2,001.
    const r = room();
    r.open('a1', USERS.alice);
    const steps = newFields(2000, 'Over');
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(rejectOf(fx, 'a1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(String(rejectOf(fx, 'a1')?.reason)).toContain('I15');
    expect(ackOf(fx, 'a1')).toBeNull();
    expect(r.head).toBe(0);
  });

  it('accepts a commit that takes the document to exactly 2,000 fields', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const steps = newFields(1999, 'Edge');
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(ackOf(fx, 'a1')).not.toBeNull();
    expect(rejectOf(fx, 'a1')).toBeNull();
  });

  it('refuses a field value of more than 4 KiB with invalid_op', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const steps = [new AttrStep(pos, 'value', 'x'.repeat(4097))];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    // 12 §4.2 and P7 leave the code open for a wrongly typed or oversized value (SYN-012 Notes);
    // the room answers field_invalid, and the commit is refused whole either way.
    expect(rejectOf(fx, 'a1')).toMatchObject({ action: 'drop' });
    expect(['invalid_op', 'field_invalid']).toContain(rejectOf(fx, 'a1')?.code);
    expect(ackOf(fx, 'a1')).toBeNull();
  });

  it('accepts a field value of exactly 4,096 bytes', () => {
    const r = room();
    r.open('a1', USERS.alice);
    const pos = posOf(baseDoc(), 'fTenantName00001');
    const steps = [new AttrStep(pos, 'value', 'x'.repeat(4096))];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(ackOf(fx, 'a1')).not.toBeNull();
    expect(rejectOf(fx, 'a1')).toBeNull();
  });
});
