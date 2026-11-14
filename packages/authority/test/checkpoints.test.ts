// SYN-006: a checkpoint is taken from the durable state only, never from the tentative state.
// The snapshot is requested while two commits are still waiting for storage; the checkpoint written
// for it must hold the two stored commits and nothing of the snapshot's content.
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit, type SnapshotRequest } from '../src/room/room.ts';
import type { Effects, ToClient, WriteRequest } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

let clock = 1_790_100_000_000;
let counter = 0;
const id = () => `0192f0c4-7c2b-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(extra: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-ckpt',
    now: () => ++clock,
    ...extra,
  });
}

const first = (fx: Effects, channel: string, t: ToClient['t']) =>
  fx.send.find((o) => o.channel === channel && o.msg.t === t)?.msg;

const insert = (doc = baseDoc(), at = 'pIntro0000000001', text = 'x') => {
  const pos = posInside(doc, at);
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
};

/** The base document with one paragraph's text replaced, as an import would bring it. */
function imported(text = 'Imported text'): ReturnType<typeof baseDoc> {
  const doc = baseDoc();
  const at = posOf(doc, 'pIntro0000000001');
  const node = doc.nodeAt(at)!;
  return new Transform(doc).replaceWith(at + 1, at + node.nodeSize - 1, schema.text(text)).doc;
}

function snapshotRequest(content = imported()): SnapshotRequest {
  return { id: id(), reason: 'import', content, checkpoint: 'ckpt-import', as: 'system' };
}

describe('checkpoints come from durable state (SYN-006, 08 §3)', () => {
  it('writes the snapshot checkpoint from the stored commits only, while later commits are tentative', () => {
    // One commit in flight per channel (SYN-007), so the second commit comes on a second channel.
    const r = room();
    r.open('c1', USERS.carol);
    r.open('c2', USERS.carol);
    const baseText = baseDoc().textContent.length;

    // Commit 1 is in flight; commit 2 waits behind it in the tentative state.
    const fx1 = r.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(fx1.write).not.toBeNull();
    const fx2 = r.submit('c2', { id: id(), base: 0, steps: insert() });
    expect(first(fx2, 'c2', 'sync.ack')).toBeUndefined();
    expect(fx2.write).toBeNull();

    // The snapshot waits behind both. Its content is tentative until it is stored.
    const content = imported();
    const fx3 = r.snapshot('control', snapshotRequest(content));
    expect(fx3.write).toBeNull();
    expect(fx3.checkpoints ?? []).toEqual([]);
    // Nothing of the snapshot is durable yet.
    expect(r.document.eq(baseDoc())).toBe(true);

    // Commit 1 is stored; commit 2 is written next, not the snapshot.
    const done1 = r.writeCompleted({ status: 'ok' });
    expect(done1.write).toMatchObject({ fromSeq: 2 });
    expect(done1.write?.commits).toHaveLength(1);
    expect(done1.write?.snapshot).toBeUndefined();
    expect(done1.checkpoints ?? []).toEqual([]);

    // Commit 2 is stored; the snapshot is written alone, and its checkpoint is taken now.
    const done2 = r.writeCompleted({ status: 'ok' });
    const write: WriteRequest | null = done2.write;
    expect(write?.snapshot).toMatchObject({ seq: 3, kind: 'snapshot' });
    expect(done2.checkpoints).toHaveLength(1);
    const cp = done2.checkpoints![0]!;
    expect(cp.seq).toBe(2);
    expect(cp.reason).toBe('snapshot');
    const doc = cp.doc as Node;

    // The checkpoint holds the two stored insertions, which is the durable state at seq 2 ...
    expect(doc.eq(r.document)).toBe(true);
    expect(doc.textContent.length).toBe(baseText + 2);
    // ... and not the tentative content of the snapshot, nor the base document.
    expect(doc.eq(content)).toBe(false);
    expect(doc.eq(baseDoc())).toBe(false);
  });

  it('writes no checkpoint for a snapshot that is still waiting behind a write in flight', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const fx1 = r.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(fx1.write).not.toBeNull();
    const fx2 = r.snapshot('control', snapshotRequest());
    expect(fx2.checkpoints ?? []).toEqual([]);
    expect(fx2.write).toBeNull();
  });
});
