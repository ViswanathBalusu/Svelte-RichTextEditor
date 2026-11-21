// Comment threads on a block over real HTTP, with in-memory storage and with PostgreSQL (PRO-059
// criterion 1 for a block target and criterion 5; PRO-060 criteria 1 and 3; 05 section 6.2; 07
// section 12; ADR 0015). Test values only. The thread rows are the `threads` and `comments`
// tables of migration 0050, so the PostgreSQL run writes and reads them under the tenant's row-level
// security.
//
// Not claimed here: a range target (PRO-059 criterion 2, the room's mapping is not wired), the
// channel notice's delivery to a connected user (the stub data plane records it only), the
// listing of threads with `?seq` (PRO-059 criterion 4), and PATCH of a thread (PRO-060 criterion 2).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const COMMENTER_BLOCK = 'pOpen00000000001'; // in the region `rOpen00000000001`
const BODY_BLOCK = 'pEnd000000000001'; // in the body, outside every region
const MISSING_BLOCK = 'pNone00000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`comment threads on a block over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A user token for `sub` with `role` on `doc`; a fresh one each call, as tokens expire. */
    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const threads = (doc: string) => `/v1/documents/${doc}/threads`;
    const comment = { body: [{ type: 'text', text: 'Is this still right?' }] };

    it.skipIf(skip)(
      'starts a thread on a block, reads it, refuses a non-author and lets the author delete it (PRO-059 criterion 1 block branch; PRO-060 criteria 1 and 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = h.events.of('dep.thread.created.v1').length;

        const created = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-1'),
          body: { target: { block: COMMENTER_BLOCK }, comment },
        });
        expect(created.status).toBe(201);
        expect(created.json).toMatchObject({ state: 'open', target: { block: COMMENTER_BLOCK } });
        const tid: string = created.json.id;
        expect(created.headers.get('etag')).toBe(`"${tid}:open:"`);
        expect(h.events.of('dep.thread.created.v1').length).toBe(before + 1);
        const notice = h.stub.notices.find(
          (n) => n.kind === 'notify' && n.notification?.type === 'thread.created',
        );
        expect(notice?.notification?.resource).toBe(`/threads/${tid}`);

        // A bare identifier resolves to its document; the editor may read it (PRO-060 criterion 1).
        const read = await h.call('GET', `/v1/threads/${tid}`, {
          token: as(doc, 'viewer', 'vw-1'),
        });
        expect(read.status).toBe(200);
        expect(read.json.id).toBe(tid);

        // Another editor is not the author and holds no `manage`: refused, nothing removed.
        const other = await h.call('DELETE', `/v1/threads/${tid}`, {
          token: as(doc, 'editor', 'ed-2'),
        });
        expect(other.status).toBe(403);
        expect(
          (await h.call('GET', `/v1/threads/${tid}`, { token: as(doc, 'viewer', 'vw-1') })).status,
        ).toBe(200);

        // The refused DELETE above announced nothing.
        const deletedBefore = h.events.of('dep.thread.deleted.v1').length;
        const deletedNotice = (n: (typeof h.stub.notices)[number]) =>
          n.kind === 'notify' &&
          n.notification?.type === 'thread.deleted' &&
          n.notification.resource === `/threads/${tid}`;
        expect(h.stub.notices.some(deletedNotice)).toBe(false);

        // The author deletes it; the deletion is announced once as a webhook event and once as a
        // `thread.deleted` notice on the document's channel (05 §5.6), and the thread is then not found.
        const removed = await h.call('DELETE', `/v1/threads/${tid}`, {
          token: as(doc, 'editor', 'ed-1'),
        });
        expect(removed.status, removed.text).toBe(204);
        const deletedEvents = h.events.of('dep.thread.deleted.v1');
        expect(deletedEvents.length).toBe(deletedBefore + 1);
        expect(deletedEvents.at(-1)).toMatchObject({ subject: doc, data: { thread: tid } });
        const deletedNotices = h.stub.notices.filter(deletedNotice);
        expect(deletedNotices).toHaveLength(1);
        expect(deletedNotices[0]?.ref).toMatchObject({ doc });
        const gone = await h.call('GET', `/v1/threads/${tid}`, {
          token: as(doc, 'viewer', 'vw-1'),
        });
        expect(gone.status).toBe(404);
      },
    );

    it.skipIf(skip)(
      'lets an owner (manage) delete a thread it did not start (PRO-060 criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const created = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-3'),
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(created.status).toBe(201);
        const removed = await h.call('DELETE', `/v1/threads/${created.json.id}`, {
          token: as(doc, 'owner', 'ow-3'),
        });
        expect(removed.status).toBe(204);
      },
    );

    it.skipIf(skip)(
      'refuses a viewer, an unknown block, a service credential and a foreign token',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const other = await h.createDocument({ content: documentWithRegions() });

        // A viewer has no `comment` in the block's scope.
        const viewer = await h.call('POST', threads(doc), {
          token: as(doc, 'viewer', 'vw-4'),
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(viewer.status).toBe(403);

        const missing = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-4'),
          body: { target: { block: MISSING_BLOCK }, comment },
        });
        expect(missing.status).toBe(404);

        // A service credential has no author for the thread.
        const service = await h.call('POST', threads(doc), {
          token: h.serviceJwt(),
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(service.status).toBe(403);

        // A token for another document does not learn that a thread exists here.
        const created = await h.call('POST', threads(doc), {
          token: as(doc, 'editor', 'ed-4'),
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(created.status).toBe(201);
        const foreign = await h.call('GET', `/v1/threads/${created.json.id}`, {
          token: as(other, 'owner', 'ow-4'),
        });
        expect(foreign.status).toBe(404);
      },
    );

    it.skipIf(skip)(
      'creates one thread for a repeated POST with the same Idempotency-Key (PRO-059 criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const key = randomUUID();
        const send = () =>
          h.call('POST', threads(doc), {
            token: as(doc, 'editor', 'ed-5'),
            headers: { 'Idempotency-Key': key },
            body: { target: { block: BODY_BLOCK }, comment },
          });
        const first = await send();
        const second = await send();
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.json.id).toBe(first.json.id);
      },
    );
  });
}
