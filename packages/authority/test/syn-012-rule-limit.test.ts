// SYN-012 criterion 3 (lane U-SYN-001-018): the room refuses, with invalid_op, a commit that takes
// the document above 500 rules (I15, 12 §3.6), and accepts one that reaches exactly 500. The field
// limit and the 4 KiB value are in syn-012-i15-limits.test.ts. The wrongly typed value stays open
// (P7 interaction, FRW), so criterion 3 is not ticked by this file alone.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { BASE_JSON, REQUIRES, USERS, basePermissions, schema } from './fixtures.ts';

const RULE_LIMIT = 500;

let clock = 1_780_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-a000-${(++counter).toString(16).padStart(12, '0')}`;

type J = Record<string, unknown>;

/** The base document with `count` rule_def nodes in its definitions. */
function withRules(count: number): Node {
  const json = structuredClone(BASE_JSON) as unknown as { content: Array<{ content: J[] }> };
  const rules: J[] = [];
  for (let i = 0; i < count; i++)
    rules.push({ type: 'rule_def', attrs: { id: `rl${i}`, when: true, then: [] } });
  json.content[0]!.content.push(...rules);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

function room(initial: Node, extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial,
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-syn-012-rules',
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

/** One more rule_def at the end of `defs`. */
function addRule(): Slice {
  return new Slice(
    Fragment.from(schema.nodes['rule_def']!.create({ id: 'rExtra', when: true, then: [] })),
    0,
    0,
  );
}

describe('I15 rule limit through the room (SYN-012 criterion 3)', () => {
  it('refuses a commit that takes the document above 500 rules with invalid_op', () => {
    const doc = withRules(RULE_LIMIT);
    const r = room(doc);
    r.open('a1', USERS.alice);
    const at = 1 + doc.child(0).content.size;
    const steps = [new ReplaceStep(at, at, addRule())];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(rejectOf(fx, 'a1')).toMatchObject({ code: 'invalid_op', action: 'drop' });
    expect(String(rejectOf(fx, 'a1')?.reason)).toContain('I15');
    expect(ackOf(fx, 'a1')).toBeNull();
    expect(r.head).toBe(0);
  });

  it('accepts a commit that takes the document to exactly 500 rules', () => {
    const doc = withRules(RULE_LIMIT - 1);
    const r = room(doc);
    r.open('a1', USERS.alice);
    const at = 1 + doc.child(0).content.size;
    const steps = [new ReplaceStep(at, at, addRule())];
    const fx = flush(r, r.submit('a1', { id: id(), base: 0, steps: stepsToJson(steps) }));
    expect(ackOf(fx, 'a1')).not.toBeNull();
    expect(rejectOf(fx, 'a1')).toBeNull();
  });
});
