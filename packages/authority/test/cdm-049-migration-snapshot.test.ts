// CDM-049 criterion 4, the room's side: the result of a migration is stored as a snapshot commit
// with origin `migration`, with the checkpoint of the state before it and the checkpoint that holds
// the new content (04 §3.2; 08 §3), and every subscriber gets `sync.reset` with the reason. The
// migration function itself (`migrate()` in `@docedit/model`) returns the envelope and the version
// stamps and writes nothing; the job that calls it and then `Room.snapshot` is the service's. The
// room here is a version 1 room, so the content is a version 1 document: the room stores content
// and does not read its version.
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit, type SnapshotRequest } from '../src/room/room.ts';
import type { Effects, WriteRequest } from '../src/room/types.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posOf, schema } from './fixtures.ts';

let clock = 1_790_000_000_000;
const room = (extra: Partial<RoomInit> = {}): Room =>
  new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...extra,
  });

const migrated = (): ReturnType<typeof baseDoc> => {
  const doc = baseDoc();
  const at = posOf(doc, 'pIntro0000000001');
  const node = doc.nodeAt(at)!;
  return new Transform(doc).replaceWith(at + 1, at + node.nodeSize - 1, schema.text('Migrated'))
    .doc;
};

function request(): SnapshotRequest {
  return {
    id: '0192f0c4-7b1e-7000-8000-000000000a49',
    reason: 'migration',
    content: migrated(),
    checkpoint: 'ckpt-migration',
    as: 'system',
  };
}

/** Completes the writes the room asks for, as the document service would. */
function flush(r: Room, fx: Effects): Effects {
  const all: Effects = {
    send: [...fx.send],
    write: null,
    checkpoints: [...(fx.checkpoints ?? [])],
  };
  let write: WriteRequest | null = fx.write;
  while (write) {
    const done = r.writeCompleted({ status: 'ok' });
    all.send.push(...done.send);
    all.checkpoints!.push(...(done.checkpoints ?? []));
    write = done.write;
  }
  return all;
}

describe('a migration result is stored as a snapshot commit (CDM-049 criterion 4)', () => {
  it('writes one snapshot commit with origin migration, a checkpoint before it and the one it references', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const before = r.document;
    const fx = r.snapshot('control', request());
    expect(fx.write?.commits).toEqual([]);
    expect(fx.write?.snapshot).toMatchObject({
      seq: 1,
      kind: 'snapshot',
      steps: [],
      snapshot: { checkpoint: 'ckpt-migration', reason: 'migration' },
      user: 'system',
      origin: 'migration',
    });
    // The state before the commit is asked for as a checkpoint, and the commit references the
    // checkpoint that holds the migrated content.
    expect(fx.checkpoints).toEqual([{ seq: 0, doc: before, reason: 'snapshot' }]);
    const done = flush(r, fx);
    expect(done.send.some((o) => o.msg.t === 'sync.reset' && o.msg.reason === 'migration')).toBe(
      true,
    );
    expect(r.document.textContent).toContain('Migrated');
  });
});
