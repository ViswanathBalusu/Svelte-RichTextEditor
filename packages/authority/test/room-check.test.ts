// SYN-043 criterion 1, the message part: the `sync.check` the room's durable state yields carries
// the durable `seq` and the SHA-256 of the canonical form of the durable document at that `seq`.
// The room's decision to send it and the client's reaction are not built here (SYN-043 Notes).
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { documentCanonicalHash, syncCheck } from '../src/room/check.ts';
import { Room, type RoomInit } from '../src/room/room.ts';
import { type CommitInput, type Effects, type WriteRequest } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

let clock = 1_790_100_000_000;
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
    incarnation: 'inc-check',
    now: () => ++clock,
    ...extra,
  });
}

/** One character typed into a paragraph, as a commit input. */
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

/** Stores every write the room asks for, as a host does, and returns the effects of the last one. */
function store(r: Room, fx: Effects): Effects {
  let last = fx;
  let write: WriteRequest | null = fx.write;
  while (write) {
    last = r.writeCompleted({ status: 'ok' });
    write = last.write;
  }
  return last;
}

describe('the divergence check message (SYN-043 criterion 1)', () => {
  it('carries the durable seq and the SHA-256 of the canonical durable document at that seq', async () => {
    const r = room();
    r.open('c1', USERS.carol);
    store(r, r.submit('c1', typed(r, 'A')));
    expect(r.head).toBe(1);

    const check = await syncCheck(r.head, r.document);
    expect(check).toEqual({ t: 'sync.check', seq: 1, hash: expect.any(String) });
    expect(check.hash).toMatch(/^[0-9a-f]{64}$/);

    // The hash is of the canonical form: an equal document rebuilt from its JSON hashes the same.
    const rebuilt = schema.nodeFromJSON(JSON.parse(JSON.stringify(r.document.toJSON())));
    expect(await documentCanonicalHash(rebuilt)).toBe(check.hash);
  });

  it('hashes the durable document, not the tentative one: a commit still waiting to be stored changes nothing', async () => {
    const r = room();
    r.open('c1', USERS.carol);
    const before = await syncCheck(r.head, r.document);
    // Submit without storing: the room holds the commit as tentative and the head does not move.
    r.submit('c1', typed(r, 'B'));
    expect(r.head).toBe(0);
    expect(await syncCheck(r.head, r.document)).toEqual(before);
  });

  it('gives a different hash and seq once a commit is stored, so a stale check cannot match', async () => {
    const r = room();
    r.open('c1', USERS.carol);
    const seq0 = await syncCheck(r.head, r.document);
    store(r, r.submit('c1', typed(r, 'C')));
    const seq1 = await syncCheck(r.head, r.document);
    expect(seq1.seq).toBe(seq0.seq + 1);
    expect(seq1.hash).not.toBe(seq0.hash);
  });
});
