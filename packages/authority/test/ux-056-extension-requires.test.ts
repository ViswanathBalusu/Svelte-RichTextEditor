// UX-056 criterion 4 (Node.js), the two halves the room already decides (03 §11.1; CDM-047; ADR 0050
// item 5). The first block inserted into a document whose `requires` lacks `extensions` adds it,
// when every connected client announced the feature. A client without it blocks the commit.
// Not claimed: the story asks for `unsupported_feature` on that refusal, and the room answers
// `conflict` with `drop` (the same as features.test.ts). That difference is an open question
// (docs/adr/0328-lane-U-UX-046-060.md, decision 2), so the criterion stays unticked.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { USERS, baseDoc, basePermissions, posOf, schema } from './fixtures.ts';

let clock = 1_772_100_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: ['fields'],
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-ux-056',
    now: () => ++clock,
    requiresGrowth: true,
  });
}

/** One extension block, after the last paragraph of the body, with its fallback text. */
function insertBlock(doc: ReturnType<typeof baseDoc>) {
  const at = posOf(doc, 'pEnd00000000001Z');
  const block = schema.nodes['extension_block']!.create({
    id: 'xBlock0000000002',
    extension: 'com.example.chart',
    payload: { kind: 'chart', series: [1, 2] },
    fallbackText: 'Chart',
  });
  return stepsToJson([new ReplaceStep(at, at, new Slice(Fragment.from(block), 0, 0))]);
}

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
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

describe('the first extension block adds `extensions` to requires (UX-056 criterion 4, accept half)', () => {
  it('stores the commit with requires grown to include extensions when every client announced it', () => {
    const r = room();
    r.open('c1', { ...USERS.carol, features: ['fields', 'extensions'] });
    r.open('a1', { ...USERS.alice, features: ['fields', 'extensions', 'preserve'] });
    const fx = r.submit('c1', {
      id: id(),
      base: 0,
      steps: insertBlock(r.document),
    } as CommitInput);
    expect(msgs(fx, 'c1').some((m) => m.t === 'sync.reject')).toBe(false);
    expect(fx.write?.commits[0]).toMatchObject({ requires: ['extensions', 'fields'] });
    flush(r, fx);
    expect(r.requiresList).toEqual(['extensions', 'fields']);
  });

  it('a client without the feature is refused the commit and requires does not grow', () => {
    const r = room();
    r.open('c1', { ...USERS.carol, features: ['fields', 'extensions'] });
    r.open('f1', { ...USERS.frank, features: ['fields'] });
    const fx = r.submit('c1', { id: id(), base: 0, steps: insertBlock(r.document) } as CommitInput);
    const reject = msgs(fx, 'c1').find((m) => m.t === 'sync.reject');
    expect(reject).toMatchObject({ t: 'sync.reject', code: 'conflict', action: 'drop' });
    expect(r.requiresList).toEqual(['fields']);
  });
});
