/**
 * BE-039 criteria 3 and 4 (lane BE-027-039, round 2 fix): the room runs step 2 (deduplication)
 * before it re-checks the preconditions the control plane relied on (04 §5, step 2 and the closing
 * paragraph). A redelivered server-authored commit that is already stored moved the head itself, so
 * a head precondition no longer holds for it; it must still be acknowledged at its stored seq, not
 * refused with `conflict`. A new commit whose precondition no longer holds is still refused.
 */
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { Effects, LogCommit } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';
import { commitId, messages, roomWith } from './permission-fixtures.ts';

const NOW = 1_770_700_000_000;

const prefill = (room: Room, id: string, head: number) => {
  const pos = posInside(room.document, 'pIntro0000000001');
  return room.author('control', {
    id,
    base: 0,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('x')), 0, 0)),
    ]),
    origin: 'prefill',
    as: 'system',
    preconditions: { head },
  });
};

const importSnapshot = (room: Room, id: string, head: number) =>
  room.snapshot('control', {
    id,
    reason: 'import',
    content: baseDoc(),
    checkpoint: 'c',
    as: 'system',
    preconditions: { head },
  });

/** Completes every write the room asks for, and keeps what was written. */
const storeAll = (room: Room, first: Effects): LogCommit[] => {
  const written: LogCommit[] = [];
  let fx = first;
  while (fx.write) {
    written.push(...fx.write.commits);
    if (fx.write.snapshot) written.push(fx.write.snapshot);
    fx = room.writeCompleted({ status: 'ok' });
  }
  return written;
};

describe('deduplication before the preconditions (BE-039)', () => {
  it('acknowledges a redelivered step commit at its stored seq although its head precondition moved', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    storeAll(room, prefill(room, id, 0));
    expect(room.head).toBe(1);

    const again = prefill(room, id, 0);
    expect(messages(again, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.ack', id, seq: 1 }),
    ]);
    expect(again.write).toBeNull();
    expect(room.head).toBe(1);
  });

  it('attaches a redelivery that arrives while the commit waits to be stored', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    const first = prefill(room, id, 0);
    // Not yet stored: the tentative head is 1, so the precondition head 0 no longer holds.
    const again = prefill(room, id, 0);
    expect(messages(again, 'control')).toEqual([]);
    const done = room.writeCompleted({ status: 'ok' });
    expect(first.write).not.toBeNull();
    expect(messages(done, 'control')).toEqual(
      expect.arrayContaining([expect.objectContaining({ t: 'sync.ack', id, seq: 1 })]),
    );
  });

  it('acknowledges a redelivered snapshot commit at its stored seq although its head precondition moved', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    storeAll(room, importSnapshot(room, id, 0));
    expect(room.head).toBe(1);

    const again = importSnapshot(room, id, 0);
    expect(messages(again, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.ack', id, seq: 1 }),
    ]);
    expect(again.write).toBeNull();
  });

  it('still refuses a new commit whose precondition no longer holds', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    storeAll(room, prefill(room, commitId(), 0));
    const stale = prefill(room, commitId(), 0);
    expect(messages(stale, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.reject', code: 'conflict', action: 'drop' }),
    ]);
    const staleSnapshot = importSnapshot(room, commitId(), 0);
    expect(messages(staleSnapshot, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.reject', code: 'conflict', action: 'drop' }),
    ]);
  });

  it('answers from a stored commit the host found in the log, when the room starts after it', () => {
    // The first room stores a snapshot at seq 1; a second room starts from the checkpoint at 1, as a
    // room reloaded after a crash does, so the commit is not among those it holds.
    const first = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    const [stored] = storeAll(first, importSnapshot(first, id, 0));
    const reloaded = () =>
      new Room({
        schema,
        initial: first.document,
        initialSeq: 1,
        requires: REQUIRES,
        log: [],
        perms: basePermissions(),
        initialRevision: basePermissions().revision,
        epoch: 2,
        incarnation: 'inc-1',
        now: () => NOW,
      });

    // Without the log lookup the room cannot tell the redelivery from a new commit.
    const blind = reloaded();
    expect(messages(importSnapshot(blind, id, 0), 'control')).toEqual([
      expect.objectContaining({ t: 'sync.reject', code: 'conflict' }),
    ]);

    const told = reloaded();
    told.rememberStored(stored!);
    const answer = importSnapshot(told, id, 0);
    expect(messages(answer, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.ack', id, seq: 1 }),
    ]);
    expect(answer.write).toBeNull();
  });
});
