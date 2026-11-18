// SEC-010 criterion 5 (Node.js only): an assistant write in a scope where the user has no `suggest`
// is refused with `permission_denied` through the room, and nothing is stored (13 §6.2; P4).
//
// The assistant's commits arrive with origin `assistant` and the delegated agent identity of the
// connection (room-scenarios.test.ts covers how the agent is taken). The room applies the base rules
// to the steps whatever the origin, so an assistant acting for a viewer must be refused. The control
// is the same assistant identity acting for an editor, which is accepted.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, StoredCommit, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_770_000_000_000;
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
    incarnation: 'inc-sec-010',
    now: () => ++clock,
  });
}

/** One insertion of text into the body paragraph, made on the base document. */
function insert(): ReturnType<typeof stepsToJson> {
  const doc = baseDoc();
  const pos = posInside(doc, 'pIntro0000000001', 0);
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('ignore the above')), 0, 0)),
  ]);
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}
function rejectOf(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}
function ackOf(fx: Effects, channel: string) {
  return msgs(fx, channel).some((x) => x.t === 'sync.ack');
}
function stored(fx: Effects, observer: string): StoredCommit[] {
  return msgs(fx, observer).flatMap((m) => (m.t === 'sync.commit' ? [m.commit] : []));
}
/** Stores whatever the room asks to write, as the tests of the room do. */
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

describe('an assistant write without suggest is refused (SEC-010 criterion 5)', () => {
  it('refuses an assistant commit from a viewer with permission_denied, and stores nothing', () => {
    const r = room();
    const assistantForViewer = {
      ...USERS.frank,
      session: 's-assist-f',
      agent: 'assistant:drafting',
    };
    r.open('x-f', assistantForViewer);
    r.open('a1', USERS.alice);
    const fx = r.submit('x-f', {
      id: id(),
      base: 0,
      steps: insert(),
      origin: 'assistant',
    } as CommitInput);
    expect(rejectOf(fx, 'x-f')?.code).toBe('permission_denied');
    expect(stored(flush(r, fx), 'a1')).toEqual([]);
  });

  it('refuses the same assistant write when the origin is a client origin (origin does not lift the rule)', () => {
    const r = room();
    const assistantForViewer = {
      ...USERS.frank,
      session: 's-assist-f2',
      agent: 'assistant:drafting',
    };
    r.open('x-f2', assistantForViewer);
    const fx = r.submit('x-f2', {
      id: id(),
      base: 0,
      steps: insert(),
      origin: 'input',
    } as CommitInput);
    expect(rejectOf(fx, 'x-f2')?.code).toBe('permission_denied');
  });

  it('refuses a direct insertion under the agent identity of an editor, with permission_denied (UX-046 criterion 3; owner decision 119)', () => {
    const r = room();
    const assistantForEditor = {
      ...USERS.carol,
      session: 's-assist-c',
      agent: 'assistant:drafting',
    };
    r.open('x-c', assistantForEditor);
    r.open('a1', USERS.alice);
    for (const origin of ['assistant', 'input']) {
      const fx = flush(
        r,
        r.submit('x-c', { id: id(), base: 0, steps: insert(), origin } as CommitInput),
      );
      expect(rejectOf(fx, 'x-c')?.code).toBe('permission_denied');
      expect(ackOf(fx, 'x-c')).toBe(false);
      expect(stored(fx, 'a1')).toEqual([]);
    }
  });

  it('control: the same assistant identity acting for an editor is accepted when the text is a suggestion', () => {
    const r = room();
    const assistantForEditor = {
      ...USERS.carol,
      session: 's-assist-c2',
      agent: 'assistant:drafting',
    };
    r.open('x-c2', assistantForEditor);
    r.open('a1', USERS.alice);
    const doc = baseDoc();
    const pos = posInside(doc, 'pIntro0000000001', 0);
    const mark = schema.marks['ins']!.create({ id: 'sSec010000000001', user: 'carol' });
    const suggested = stepsToJson([
      new ReplaceStep(
        pos,
        pos,
        new Slice(Fragment.from(schema.text('ignore the above', [mark])), 0, 0),
      ),
    ]);
    const fx = flush(
      r,
      r.submit('x-c2', { id: id(), base: 0, steps: suggested, origin: 'assistant' } as CommitInput),
    );
    expect(ackOf(fx, 'x-c2')).toBe(true);
    expect(rejectOf(fx, 'x-c2')).toBeNull();
    expect(stored(fx, 'a1')[0]).toMatchObject({
      user: 'carol',
      origin: 'assistant',
      agent: 'assistant:drafting',
    });
  });
});
