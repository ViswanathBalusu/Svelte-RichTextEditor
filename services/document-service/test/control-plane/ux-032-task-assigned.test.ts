// A thread given to a person raises `dep.task.assigned` (UX-032 criterion 1; 05 section 7), with
// in-memory storage and with PostgreSQL. Setting the assignee raises one event naming the thread and
// the assignee; naming the same assignee again, and clearing it, raise none. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY_BLOCK = 'pEnd000000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`assigning a thread as a task (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'raises dep.task.assigned once when a person is named, and not otherwise',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const as = (sub: string) => h.userToken({ [doc]: 'editor' }, { sub });
        const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as('ed-1'),
          body: { target: { block: BODY_BLOCK }, comment: { text: 'Please check.' } },
        });
        expect(made.status).toBe(201);
        const url = `/v1/threads/${made.json.id as string}`;
        const before = h.events.of('dep.task.assigned.v1').length;

        // Naming a person: the thread has the assignee and one event is raised.
        const assigned = await h.call('PATCH', url, {
          token: as('ed-2'),
          headers: { 'If-Match': made.headers.get('etag') as string },
          body: { assignee: 'user:ed-3' },
        });
        expect(assigned.status, assigned.text).toBe(200);
        expect(assigned.json).toMatchObject({ assignee: 'user:ed-3' });
        const events = h.events.of('dep.task.assigned.v1');
        expect(events.length).toBe(before + 1);
        expect(JSON.stringify(events[events.length - 1])).toContain('user:ed-3');

        // The same assignee again changes nothing and raises nothing.
        const same = await h.call('PATCH', url, {
          token: as('ed-2'),
          headers: { 'If-Match': assigned.headers.get('etag') as string },
          body: { assignee: 'user:ed-3' },
        });
        expect(same.status).toBe(200);
        expect(h.events.of('dep.task.assigned.v1').length).toBe(before + 1);

        // Reassigning raises one more; clearing raises none (05 names no event for it).
        const reassigned = await h.call('PATCH', url, {
          token: as('ed-2'),
          headers: { 'If-Match': same.headers.get('etag') as string },
          body: { assignee: 'user:ed-4' },
        });
        expect(reassigned.status).toBe(200);
        expect(h.events.of('dep.task.assigned.v1').length).toBe(before + 2);
        const cleared = await h.call('PATCH', url, {
          token: as('ed-2'),
          headers: { 'If-Match': reassigned.headers.get('etag') as string },
          body: { assignee: null },
        });
        expect(cleared.status).toBe(200);
        expect(cleared.json).toMatchObject({ assignee: null });
        expect(h.events.of('dep.task.assigned.v1').length).toBe(before + 2);
      },
    );
  });
}
