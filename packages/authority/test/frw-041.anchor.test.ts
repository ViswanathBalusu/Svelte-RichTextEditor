/**
 * FRW-041 criterion 2 at the room: a control commit that anchors workflow evidence carries the
 * origin and the salted hash and nothing else, takes the next seq, is acknowledged to the requester,
 * is applied once however often it is requested, and does not stand in for the control commit of a
 * grants revision (the revision still gets its own). The commit identifier is the caller's.
 */
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room/room.ts';
import type { Effects, LogCommit } from '../src/room/types.ts';
import { baseDoc, basePermissions } from './fixtures.ts';
import { commitId, messages, roomWith } from './permission-fixtures.ts';

const NOW = 1_770_700_000_000;
const HASH = 'ab'.repeat(32);

const storeAll = (room: Room, first: Effects): LogCommit[] => {
  const written: LogCommit[] = [];
  let fx = first;
  while (fx.write) {
    written.push(...fx.write.commits);
    fx = room.writeCompleted({ status: 'ok' });
  }
  return written;
};

describe('a control commit that anchors evidence (FRW-041)', () => {
  it('stores the origin and the hash and nothing else, and acknowledges the requester', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    const fx = room.anchor('control', { id, evidence: { origin: 'sign', evidenceHash: HASH } });
    const written = storeAll(room, fx);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      seq: 1,
      id,
      kind: 'control',
      steps: [],
      origin: 'control',
      evidence: { origin: 'sign', evidenceHash: HASH },
    });
    expect(Object.keys(written[0]!.evidence!).sort()).toEqual(['evidenceHash', 'origin']);
    expect(room.head).toBe(1);
  });

  it('anchors the evidence of a decline with the origin decline (FRW-033 criterion 1)', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    const written = storeAll(
      room,
      room.anchor('control', { id, evidence: { origin: 'decline', evidenceHash: HASH } }),
    );
    expect(written).toHaveLength(1);
    expect(written[0]!.evidence).toEqual({ origin: 'decline', evidenceHash: HASH });
  });

  it('applies a repeat of the same identifier once, stored or waiting', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    const first = room.anchor('control', { id, evidence: { origin: 'rules', evidenceHash: HASH } });
    const waiting = room.anchor('control', {
      id,
      evidence: { origin: 'rules', evidenceHash: HASH },
    });
    expect(messages(waiting, 'control')).toEqual([]);
    const done = room.writeCompleted({ status: 'ok' });
    expect(first.write).not.toBeNull();
    expect(messages(done, 'control')).toEqual(
      expect.arrayContaining([expect.objectContaining({ t: 'sync.ack', id, seq: 1 })]),
    );
    const again = room.anchor('control', { id, evidence: { origin: 'rules', evidenceHash: HASH } });
    expect(messages(again, 'control')).toEqual([
      expect.objectContaining({ t: 'sync.ack', id, seq: 1 }),
    ]);
    expect(again.write).toBeNull();
    expect(room.head).toBe(1);
  });

  it('refuses an identifier that is not a UUID version 7, another origin and a hash that is not SHA-256', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const bad = (id: string, origin: string, hash: string) =>
      messages(
        room.anchor('control', {
          id,
          evidence: { origin, evidenceHash: hash } as never,
        }),
        'control',
      );
    for (const m of [
      bad('not-an-id', 'sign', HASH),
      bad(commitId(), 'input', HASH),
      bad(commitId(), 'sign', 'abc'),
      bad(commitId(), 'sign', HASH.toUpperCase()),
    ])
      expect(m).toEqual([expect.objectContaining({ t: 'sync.reject', code: 'invalid_op' })]);
    expect(room.head).toBe(0);
  });

  it('leaves the control commit of a grants revision to be written', () => {
    const room = roomWith(baseDoc(), basePermissions(), () => NOW);
    const id = commitId();
    // A revision the log does not hold, then an anchor: the anchor is not that revision's commit.
    const perms = basePermissions();
    perms.revision += 1;
    const changed = room.permissionsChanged(perms);
    const anchored = room.anchor('control', {
      id,
      evidence: { origin: 'sign', evidenceHash: HASH },
    });
    const written = [...storeAll(room, changed), ...storeAll(room, anchored)];
    const controls = written.filter((c) => c.kind === 'control');
    expect(controls.filter((c) => c.evidence === undefined)).toHaveLength(1);
    expect(controls.filter((c) => c.evidence !== undefined)).toHaveLength(1);
    expect(controls.find((c) => c.evidence === undefined)!.revision).toBe(perms.revision);
  });
});
