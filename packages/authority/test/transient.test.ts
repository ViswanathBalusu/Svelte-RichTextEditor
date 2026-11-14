// SYN-031 criteria 3 and 4: a room started from a checkpoint and the log tail (the transient
// authority of a document that is not open, BE-020 for the storage) applies a commit through the
// same algorithm as a room that has the whole history, and a retry with the same deterministic
// identifier is applied once. Loading from storage and the exit of the process are the host's (BE).
import { type JsonNode, canonicalNodeText, sha256Hex } from '@docedit/model';
import { Fragment, type Node, Slice } from 'prosemirror-model';
import { ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room, type RoomInit } from '../src/room/room.ts';
import type { CommitInput, Effects, StoredCommit } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, schema } from './fixtures.ts';

const T0 = 1_790_300_000_000;
const ID_1 = '0192f0c4-9000-7000-8000-000000000001';
const ID_2 = '0192f0c4-9000-7000-8000-000000000002';
const ID_3 = '0192f0c4-9000-7000-8000-000000000003';

const hashOf = async (doc: Node): Promise<string> =>
  sha256Hex(canonicalNodeText(doc.toJSON() as JsonNode));

function room(init: Partial<RoomInit> = {}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-transient',
    now: () => T0,
    ...init,
  });
}

/** The commit a fixed edit makes at `base`: a short text inserted into a named paragraph. */
function insertCommit(doc: Node, paragraph: string, id: string, base: number): CommitInput {
  const pos = posInside(doc, paragraph);
  return {
    id,
    base,
    steps: stepsToJson([
      new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text('edit')), 0, 0)),
    ]),
  };
}

/** The commit the room wrote for a submission, or null when it wrote none. */
function writtenBy(fx: Effects): StoredCommit | null {
  return fx.write?.commits[0] ?? null;
}

/** Stores what the room wrote, as a storage would, and returns the document it then holds. */
function storeAll(r: Room, fx: Effects): void {
  if (fx.write) r.writeCompleted({ status: 'ok' });
}

describe('a transient authority applies a commit as a room does (SYN-031 criteria 3 and 4)', () => {
  it('stores the same commit, with the same hash, as a room that holds the whole history', async () => {
    // A room with the full history: two commits stored, then the one under test.
    const full = room();
    full.open('ch', USERS.alice);
    full.open('ed', USERS.carol);
    const c1 = insertCommit(full.document, 'pIntro0000000001', ID_1, 0);
    storeAll(full, full.submit('ch', c1));
    const c2 = insertCommit(full.document, 'pTerms000000001A', ID_2, 1);
    storeAll(full, full.submit('ch', c2));
    // The checkpoint the transient authority loads: the durable content at seq 2.
    const checkpoint = full.document;
    expect(full.head).toBe(2);

    const under = insertCommit(checkpoint, 'pMiddle000000001', ID_3, 2);
    const fromRoom = full.submit('ed', under);
    const roomCommit = writtenBy(fromRoom);
    expect(roomCommit).not.toBeNull();
    storeAll(full, fromRoom);

    // The transient authority: the checkpoint at seq 2 and an empty tail, one commit, then it exits.
    const transient = room({ initial: checkpoint, initialSeq: 2 });
    transient.open('ed', USERS.carol);
    const fromTransient = transient.submit('ed', under);
    const transientCommit = writtenBy(fromTransient);
    storeAll(transient, fromTransient);

    expect(transientCommit).toEqual(roomCommit);
    expect(transientCommit?.seq).toBe(3);
    expect(transientCommit?.steps).toEqual(roomCommit?.steps);
    expect(transientCommit?.scopes).toEqual(roomCommit?.scopes);
    expect(await hashOf(transient.document)).toBe(await hashOf(full.document));
  });

  it('applies a retry with the same deterministic identifier once', async () => {
    const full = room();
    full.open('ed', USERS.carol);
    const checkpoint = full.document;
    const under = insertCommit(checkpoint, 'pMiddle000000001', ID_1, 0);
    const first = full.submit('ed', under);
    const stored = writtenBy(first);
    expect(stored).not.toBeNull();
    storeAll(full, first);
    const hashAfterFirst = await hashOf(full.document);

    // A second run loads the checkpoint and the tail that already holds the commit, then sees the retry.
    const again = room({ initial: checkpoint, initialSeq: 0, log: [stored!] });
    again.open('ed', USERS.carol);
    const retry = again.submit('ed', under);
    expect(writtenBy(retry), 'a retry writes nothing').toBeNull();
    expect(again.head).toBe(1);
    expect(await hashOf(again.document)).toBe(hashAfterFirst);

    // A run that loads the checkpoint without the stored tail applies the commit exactly once.
    const fresh = room({ initial: checkpoint, initialSeq: 0 });
    fresh.open('ed', USERS.carol);
    const applied = fresh.submit('ed', under);
    expect(writtenBy(applied)?.id).toBe(ID_1);
    storeAll(fresh, applied);
    const retried = fresh.submit('ed', under);
    expect(writtenBy(retried), 'the second retry writes nothing').toBeNull();
    expect(fresh.head).toBe(1);
    expect(await hashOf(fresh.document)).toBe(hashAfterFirst);
  });
});
