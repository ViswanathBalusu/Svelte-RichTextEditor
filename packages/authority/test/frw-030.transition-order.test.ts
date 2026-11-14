// Workflow transitions in the commit log (FRW-030 criterion 1, the ordering part). A transition
// that changes the lock is a grants revision, and the room writes it as a control commit with no
// steps (room.ts ensureControlCommit). This file pins that a send, a fill and a stop land in one
// total order, with contiguous seq values, and that the control commits carry no steps.
// The audit trail, the webhook seq and the crash-safety parts of FRW-030 are not covered here.
import { AttrStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import type { Room } from '../src/room/room.ts';
import type { Effects } from '../src/room/types.ts';
import { lockFor } from '../src/workflow/lock.ts';
import { stepsToJson } from '../src/steps.ts';
import {
  FIELDS,
  USERS,
  commitId,
  fieldsDoc,
  morePermissions,
  roomWith,
} from './permission-fixtures.ts';
import { posOf } from './fixtures.ts';

/** Completes every write the room asks for, and returns the commits it wrote, in order. */
function drain(room: Room, first: Effects) {
  const written = [...(first.write?.commits ?? [])];
  let next = room.writeCompleted({ status: 'ok' });
  while (next.write) {
    written.push(...next.write.commits);
    next = room.writeCompleted({ status: 'ok' });
  }
  return written;
}

describe('transitions in the commit log (FRW-030 criterion 1)', () => {
  it('writes a send, a fill and a stop as control and step commits in one order', () => {
    const doc = fieldsDoc();
    const base = morePermissions({ revision: 1 });
    const room = roomWith(doc, base);
    room.open('e1', USERS.erin);

    const sent = lockFor('sent');
    expect(sent).not.toBeNull();
    const sendCommits = drain(room, room.permissionsChanged({ ...base, revision: 2, ...sent! }));
    expect(sendCommits.map((c) => c.kind)).toEqual(['control']);
    expect(sendCommits[0]?.steps).toEqual([]);

    const fillCommits = drain(
      room,
      room.submit('e1', {
        id: commitId(),
        base: room.head,
        steps: stepsToJson([new AttrStep(posOf(doc, FIELDS.number), 'value', '12.50')]),
      }),
    );
    expect(fillCommits.map((c) => c.kind)).toEqual(['steps']);

    const stopped = lockFor('declined');
    expect(stopped).not.toBeNull();
    const stopCommits = drain(room, room.permissionsChanged({ ...base, revision: 3, ...stopped! }));
    expect(stopCommits.map((c) => c.kind)).toEqual(['control']);
    expect(stopCommits[0]?.steps).toEqual([]);

    const seqs = [...sendCommits, ...fillCommits, ...stopCommits].map((c) => c.seq);
    expect(seqs.length).toBe(3);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    expect(room.head).toBe(seqs[seqs.length - 1]);
  });
});
