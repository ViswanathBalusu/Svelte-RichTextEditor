// Comments are not a change to the document, so they stay open while a workflow runs (FRW-029
// criterion 3). Creating a thread on a locked document is tested in threads.test.ts; this file pins
// the reply and the resolution of a thread under the workflow lock, with the lock taken from
// lockFor (workflow/lock.ts), not typed by hand.
import { describe, expect, it } from 'vitest';
import { lockFor } from '../src/workflow/lock.ts';
import { MORE, USERS, fieldsDoc, morePermissions, roomWith } from './permission-fixtures.ts';

let counter = 0;
const uid = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

describe('comments while a workflow runs (FRW-029 criterion 3)', () => {
  for (const state of ['sent', 'in_progress'] as const) {
    it(`lets a commenter create a thread and reply while the workflow is ${state}`, () => {
      const lock = lockFor(state);
      expect(lock).not.toBeNull();
      const room = roomWith(fieldsDoc(), morePermissions({ revision: 2, ...lock! }));
      const created = room.createThread({
        id: uid(),
        as: MORE.cora,
        target: { block: 'pIntro0000000001' },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;
      expect(room.threadAccess(created.thread.id, MORE.cora, 'reply').ok).toBe(true);
      expect(room.threadAccess(created.thread.id, MORE.cora, 'resolve').ok).toBe(true);
      // A user with view only may not reply: the lock does not widen the right to comment.
      expect(room.threadAccess(created.thread.id, USERS.frank, 'reply').ok).toBe(false);
    });
  }
});
