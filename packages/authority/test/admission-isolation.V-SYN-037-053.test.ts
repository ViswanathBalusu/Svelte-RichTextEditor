// SYN-037 criterion 5 (isolation part): one connection that floods a room with expensive commits
// is refused with `rate_limited` while another connection in the same room keeps being
// acknowledged. This tests the isolation only. The latency target of SYN-015 is measured on the
// reference deployment and is not claimed here.
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { Effects, ToClient, WriteRequest } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

type Sent = Effects['send'][number];

// UUID version 7 identifiers, as the room requires for every commit.
let counter = 0;
const uuid7 = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

const insert = (doc: ReturnType<typeof baseDoc>, text: string) => {
  const pos = posInside(doc, 'pIntro0000000001');
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
};

const find = <T extends ToClient['t']>(sent: Sent[], channel: string, t: T) =>
  sent.find((o) => o.channel === channel && o.msg.t === t)?.msg as
    Extract<ToClient, { t: T }> | undefined;

/** Stores each write the room asks for, as a successful storage would, and returns all sends. */
function settle(r: Room, fx: Effects): Sent[] {
  const out: Sent[] = [...fx.send];
  let write: WriteRequest | null = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    out.push(...done.send);
    write = done.write;
  }
  return out;
}

function room(): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => 1_000_000,
    // Each session has its own bucket. The flood spends its bucket on a few 4 KB commits; the
    // editor's commits cost 2 units each, so its bucket covers the ten edits below.
    admission: { connection: { capacity: 30, refillPerSecond: 1 } },
  });
}

describe('admission isolation (SYN-037 criterion 5, isolation part)', () => {
  it('refuses a flooding connection and keeps acknowledging another connection in the room', () => {
    const r = room();
    const flood = { ...USERS.carol, session: 's-flood-V-SYN-037-053' };
    const editor = { ...USERS.carol, session: 's-editor-V-SYN-037-053' };
    r.open('flood', flood);
    r.open('editor', editor);

    const big = 'x'.repeat(4096);
    let rejected = 0;
    const editorSeqs: number[] = [];
    for (let i = 0; i < 10; i++) {
      const headBefore = r.head;
      const floodSent = settle(
        r,
        r.submit('flood', { id: uuid7(), base: r.head, steps: insert(r.document, big) }),
      );
      const rej = find(floodSent, 'flood', 'sync.reject');
      if (rej) {
        rejected++;
        expect(rej.code).toBe('rate_limited');
        expect(rej.action).toBe('retry');
        expect(rej.retryAfterMs).toBeGreaterThan(0);
        // A refused commit changes nothing in the room.
        expect(r.head).toBe(headBefore);
      }

      const editorSent = settle(
        r,
        r.submit('editor', { id: uuid7(), base: r.head, steps: insert(r.document, 'y') }),
      );
      // The editor's budget is its own: the flood never reaches it as a rejection.
      expect(find(editorSent, 'editor', 'sync.reject')).toBeUndefined();
      const ack = find(editorSent, 'editor', 'sync.ack');
      expect(ack).toBeDefined();
      editorSeqs.push(ack!.seq);
    }

    expect(rejected).toBeGreaterThan(0);
    expect(editorSeqs).toHaveLength(10);
    for (let i = 1; i < editorSeqs.length; i++) {
      expect(editorSeqs[i]!).toBeGreaterThan(editorSeqs[i - 1]!);
    }
  });
});
