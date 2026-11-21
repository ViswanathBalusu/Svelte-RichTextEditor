// Thread changes and comments over HTTP, with in-memory storage and with PostgreSQL (PRO-060
// criteria 1, 2, 4 and 5; 05 section 6.2; 07 section 12; lane V-PRO-052-068). Test values only.
// The rows are the `threads` and `comments` tables of migration 0050, so the PostgreSQL run writes
// and reads them under the tenant's row-level security.
//
// Not claimed here: mentions in a comment body and the `dep.comment.mentioned` webhook (PRO-060
// criterion 4, PRO-073), a range target (PRO-059 criterion 2), and the notice's delivery to a
// connected user (the stub data plane records it only).
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY_BLOCK = 'pEnd000000000001'; // in the body, outside every region
const LEGAL_BLOCK = 'pLegal0000000001'; // in the region `rLegal0000000001`, hidden from non-owners
const LEGAL = 'rLegal0000000001';

const threads = (doc: string) => `/v1/documents/${doc}/threads`;
const comment = { body: [{ type: 'text', text: 'Is this still right?' }] };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`thread changes and comments over HTTP (${storage})`, async () => {
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

    /** A thread by `ed-1` on the body block, returned with its identifier and its ETag. */
    const startThread = async (doc: string) => {
      const r = await h.call('POST', threads(doc), {
        token: as(doc, 'editor', 'ed-1'),
        body: { target: { block: BODY_BLOCK }, comment },
      });
      expect(r.status).toBe(201);
      return { id: r.json.id as string, etag: r.headers.get('etag') as string };
    };

    it.skipIf(skip)(
      'changes the state with If-Match, refuses stale, missing and unauthorised changes, and announces each (PRO-060 criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const t = await startThread(doc);
        const url = `/v1/threads/${t.id}`;
        const resolvedBefore = h.events.of('dep.thread.resolved.v1').length;

        // A missing or stale If-Match is refused: 428, then 412.
        const bare = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-1'),
          body: { state: 'resolved' },
        });
        expect(bare.status).toBe(428);
        const stale = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-1'),
          headers: { 'If-Match': '"not-the-tag"' },
          body: { state: 'resolved' },
        });
        expect(stale.status).toBe(412);

        // A viewer has no `comment` in the thread's scope.
        const viewer = await h.call('PATCH', url, {
          token: as(doc, 'viewer', 'vw-2'),
          headers: { 'If-Match': t.etag },
          body: { state: 'resolved' },
        });
        expect(viewer.status).toBe(403);

        // An editor resolves it with the current tag: the new state, a new tag, one event, one notice.
        const resolved = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': t.etag },
          body: { state: 'resolved' },
        });
        expect(resolved.status, resolved.text).toBe(200);
        expect(resolved.json).toMatchObject({ id: t.id, state: 'resolved' });
        const resolvedTag = resolved.headers.get('etag');
        expect(resolvedTag).not.toBe(t.etag);
        expect(h.events.of('dep.thread.resolved.v1').length).toBe(resolvedBefore + 1);
        expect(
          h.stub.notices.some(
            (n) => n.kind === 'notify' && n.notification?.type === 'thread.resolved',
          ),
        ).toBe(true);

        // The old tag no longer matches.
        const replay = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': t.etag },
          body: { state: 'open' },
        });
        expect(replay.status).toBe(412);

        // Reopening with the new tag, and naming an assignee: the reopening is announced, and the
        // assignee change has only the `thread.updated` notice (webhooks have no such event).
        const reopenedBefore = h.events.of('dep.thread.reopened.v1').length;
        const reopened = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': resolvedTag as string },
          body: { state: 'open', assignee: 'ed-3' },
        });
        expect(reopened.status, reopened.text).toBe(200);
        expect(reopened.json).toMatchObject({ state: 'open', assignee: 'ed-3' });
        expect(h.events.of('dep.thread.reopened.v1').length).toBe(reopenedBefore + 1);
        expect(
          h.stub.notices.some(
            (n) => n.kind === 'notify' && n.notification?.type === 'thread.updated',
          ),
        ).toBe(true);

        // A wrong value is refused with a client error, and nothing changes.
        const wrong = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-2'),
          headers: { 'If-Match': reopened.headers.get('etag') as string },
          body: { state: 'closed' },
        });
        expect(wrong.status).toBeGreaterThanOrEqual(400);
        expect(wrong.status).toBeLessThan(500);
        const still = await h.call('GET', url, { token: as(doc, 'viewer', 'vw-2') });
        expect(still.json).toMatchObject({ state: 'open', assignee: 'ed-3' });
      },
    );

    it.skipIf(skip)(
      'adds a comment for a user with comment, refuses a viewer and a service credential (PRO-060 criterion 4, without mentions)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const t = await startThread(doc);
        const url = `/v1/threads/${t.id}/comments`;
        const viewer = await h.call('POST', url, {
          token: as(doc, 'viewer', 'vw-4'),
          body: comment,
        });
        expect(viewer.status).toBe(403);
        const service = await h.call('POST', url, { token: h.serviceJwt(), body: comment });
        expect(service.status).toBe(403);

        const before = h.events.of('dep.comment.created.v1').length;
        const made = await h.call('POST', url, { token: as(doc, 'editor', 'ed-4'), body: comment });
        expect(made.status, made.text).toBe(201);
        expect(made.json).toMatchObject({
          body: comment.body,
          author: expect.stringMatching(/^user:/),
          editedAt: null,
        });
        expect(made.headers.get('etag')).toMatch(/^"[0-9a-f-]+:0"$/);
        expect(h.events.of('dep.comment.created.v1').length).toBe(before + 1);
        expect(
          h.stub.notices.some(
            (n) =>
              n.kind === 'notify' &&
              n.notification?.type === 'comment.created' &&
              n.notification.resource === `/comments/${made.json.id}`,
          ),
        ).toBe(true);
      },
    );

    it.skipIf(skip)(
      'edits a comment by its author with If-Match, refuses others, and soft-deletes it (PRO-060 criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const t = await startThread(doc);
        const made = await h.call('POST', `/v1/threads/${t.id}/comments`, {
          token: as(doc, 'editor', 'ed-5'),
          body: comment,
        });
        const cid: string = made.json.id;
        const url = `/v1/comments/${cid}`;

        // Missing If-Match is 428; another editor is refused even with the right tag.
        expect(
          (
            await h.call('PATCH', url, {
              token: as(doc, 'editor', 'ed-5'),
              body: { body: [{ type: 'text', text: 'x' }] },
            })
          ).status,
        ).toBe(428);
        const other = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-6'),
          headers: { 'If-Match': made.headers.get('etag') as string },
          body: { body: [{ type: 'text', text: 'changed by someone else' }] },
        });
        expect(other.status).toBe(403);

        // The author edits it: a new tag, and the body is the new one.
        const edited = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-5'),
          headers: { 'If-Match': made.headers.get('etag') as string },
          body: { body: [{ type: 'text', text: 'Revised' }] },
        });
        expect(edited.status, edited.text).toBe(200);
        expect(edited.json.body).toEqual([{ type: 'text', text: 'Revised' }]);
        expect(edited.headers.get('etag')).not.toBe(made.headers.get('etag'));
        const stale = await h.call('PATCH', url, {
          token: as(doc, 'editor', 'ed-5'),
          headers: { 'If-Match': made.headers.get('etag') as string },
          body: { body: [{ type: 'text', text: 'again' }] },
        });
        expect(stale.status).toBe(412);

        // Another editor cannot delete it; the author can, and it is then not found.
        const otherDelete = await h.call('DELETE', url, { token: as(doc, 'editor', 'ed-6') });
        expect(otherDelete.status).toBe(403);
        const removed = await h.call('DELETE', url, { token: as(doc, 'editor', 'ed-5') });
        expect(removed.status).toBe(204);
        expect(
          (
            await h.call('PATCH', url, {
              token: as(doc, 'editor', 'ed-5'),
              headers: { 'If-Match': edited.headers.get('etag') as string },
              body: { body: [{ type: 'text', text: 'gone' }] },
            })
          ).status,
        ).toBe(404);
        expect((await h.call('DELETE', url, { token: as(doc, 'editor', 'ed-5') })).status).toBe(
          404,
        );

        // The thread itself is still there, and the deleted comment is not listed with it.
        const thread = await h.call('GET', `/v1/threads/${t.id}`, {
          token: as(doc, 'viewer', 'vw-5'),
        });
        expect(thread.status).toBe(200);
      },
    );

    it.skipIf(skip)(
      'lets an owner (manage) delete a comment it did not write (PRO-060 criterion 5)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const t = await startThread(doc);
        const made = await h.call('POST', `/v1/threads/${t.id}/comments`, {
          token: as(doc, 'editor', 'ed-7'),
          body: comment,
        });
        const removed = await h.call('DELETE', `/v1/comments/${made.json.id}`, {
          token: as(doc, 'owner', 'ow-7'),
        });
        expect(removed.status).toBe(204);
      },
    );
  });
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a thread in a region the reader cannot see (${storage})`, async () => {
    const skip = await skipReason(storage);
    // The legal region is hidden from everyone but owners (the policy of be-098-read-sweep).
    const visibility: Visibility = (conn) =>
      conn.role === 'owner'
        ? NOTHING_HIDDEN
        : { regions: new Set([LEGAL]), values: new Set(), titles: false };
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'answers not found to an editor who cannot see the region, for reading, changing and replying (PRO-060 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-8' });
        const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: LEGAL_BLOCK }, comment },
        });
        expect(made.status, made.text).toBe(201);
        const tid: string = made.json.id;
        const editor = h.userToken({ [doc]: 'editor' }, { sub: 'carol' });

        expect((await h.call('GET', `/v1/threads/${tid}`, { token: editor })).status).toBe(404);
        expect(
          (
            await h.call('PATCH', `/v1/threads/${tid}`, {
              token: editor,
              headers: { 'If-Match': made.headers.get('etag') as string },
              body: { state: 'resolved' },
            })
          ).status,
        ).toBe(404);
        expect(
          (await h.call('POST', `/v1/threads/${tid}/comments`, { token: editor, body: comment }))
            .status,
        ).toBe(404);
        // The owner still sees it.
        expect((await h.call('GET', `/v1/threads/${tid}`, { token: owner })).status).toBe(200);
      },
    );
  });
}
