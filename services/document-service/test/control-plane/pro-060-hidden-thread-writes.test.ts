// The write routes hide a thread in a region the caller cannot see (PRO-060 criterion 1; ADR 0019;
// lane V-PRO-052-068, reviewer finding on `thread-routes.ts`). A reader who cannot see the region
// must get 404 whatever `If-Match` it sends: none, a wrong one, or the right one. Before the fix a
// missing tag gave 428 and a wrong one 412, which told the reader that the thread existed.
// Runs with in-memory storage and with PostgreSQL. Test values only.
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

const LEGAL_BLOCK = 'pLegal0000000001'; // in the region `rLegal0000000001`, hidden from non-owners
const LEGAL = 'rLegal0000000001';
const comment = { body: [{ type: 'text', text: 'Is this clause still right?' }] };
const MISSING = '019a0000-0000-7000-8000-000000000000';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`writes to a thread in a region the caller cannot see (${storage})`, async () => {
    const skip = await skipReason(storage);
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

    /** A hidden thread by an owner, with a reply by the owner, and an editor who cannot see it. */
    const hiddenThread = async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = () => h.userToken({ [doc]: 'owner' }, { sub: 'ow-hidden' });
      const editor = () => h.userToken({ [doc]: 'editor' }, { sub: 'ed-hidden' });
      const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: owner(),
        body: { target: { block: LEGAL_BLOCK }, comment },
      });
      expect(made.status, made.text).toBe(201);
      const reply = await h.call('POST', `/v1/threads/${made.json.id}/comments`, {
        token: owner(),
        body: comment,
      });
      expect(reply.status, reply.text).toBe(201);
      return {
        tid: made.json.id as string,
        threadTag: made.headers.get('etag') as string,
        cid: reply.json.id as string,
        commentTag: reply.headers.get('etag') as string,
        owner,
        editor,
      };
    };

    it.skipIf(skip)(
      'answers 404 to PATCH /threads/{tid} with no, a wrong or the right If-Match',
      async () => {
        const x = await hiddenThread();
        const url = `/v1/threads/${x.tid}`;
        const body = { state: 'resolved' };
        const tags: (string | undefined)[] = [undefined, '"not-the-tag"', x.threadTag];
        for (const tag of tags) {
          const r = await h.call('PATCH', url, {
            token: x.editor(),
            ...(tag === undefined ? {} : { headers: { 'If-Match': tag } }),
            body,
          });
          expect(r.status, `If-Match ${tag ?? 'absent'}: ${r.text}`).toBe(404);
        }
        // A thread that does not exist answers the same.
        const missing = await h.call('PATCH', `/v1/threads/${MISSING}`, {
          token: x.editor(),
          body,
        });
        expect(missing.status).toBe(404);
        // Nothing changed: the owner still sees the thread open, with the same tag.
        const seen = await h.call('GET', url, { token: x.owner() });
        expect(seen.status).toBe(200);
        expect(seen.json).toMatchObject({ state: 'open' });
        expect(seen.headers.get('etag')).toBe(x.threadTag);
      },
    );

    it.skipIf(skip)(
      'answers 404 to PATCH and DELETE /comments/{cid} with no, a wrong or the right If-Match',
      async () => {
        const x = await hiddenThread();
        const url = `/v1/comments/${x.cid}`;
        const tags: (string | undefined)[] = [undefined, '"not-the-tag"', x.commentTag];
        for (const tag of tags) {
          const headers = tag === undefined ? {} : { headers: { 'If-Match': tag } };
          const patched = await h.call('PATCH', url, {
            token: x.editor(),
            ...headers,
            body: { body: [{ type: 'text', text: 'changed' }] },
          });
          expect(patched.status, `PATCH, If-Match ${tag ?? 'absent'}: ${patched.text}`).toBe(404);
          const deleted = await h.call('DELETE', url, { token: x.editor(), ...headers });
          expect(deleted.status, `DELETE, If-Match ${tag ?? 'absent'}: ${deleted.text}`).toBe(404);
        }
        // A comment that does not exist answers the same.
        const missingPatch = await h.call('PATCH', `/v1/comments/${MISSING}`, {
          token: x.editor(),
          body: { body: [{ type: 'text', text: 'changed' }] },
        });
        expect(missingPatch.status).toBe(404);
        const missingDelete = await h.call('DELETE', `/v1/comments/${MISSING}`, {
          token: x.editor(),
          headers: { 'If-Match': '"not-the-tag"' },
        });
        expect(missingDelete.status).toBe(404);
        // The comment is untouched: its author can still edit it with the tag it was given.
        const edited = await h.call('PATCH', url, {
          token: x.owner(),
          headers: { 'If-Match': x.commentTag },
          body: { body: [{ type: 'text', text: 'Revised by the owner' }] },
        });
        expect(edited.status, edited.text).toBe(200);
      },
    );

    it.skipIf(skip)('answers 404 to DELETE /threads/{tid} for the hidden thread', async () => {
      const x = await hiddenThread();
      const r = await h.call('DELETE', `/v1/threads/${x.tid}`, { token: x.editor() });
      expect(r.status).toBe(404);
      expect((await h.call('GET', `/v1/threads/${x.tid}`, { token: x.owner() })).status).toBe(200);
    });
  });
}
