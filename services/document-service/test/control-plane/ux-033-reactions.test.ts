// Reactions to a comment over HTTP, with in-memory storage and with PostgreSQL (UX-033; 05 section
// 6.2; ADR 0424): one reaction per person, idempotent in both directions, no change of the
// comment's tag, no commit, a notice only when something changed, and `comment` as the right it
// needs. Test values only. The column is migration 0099.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY_BLOCK = 'pEnd000000000001';
const threads = (doc: string) => `/v1/documents/${doc}/threads`;
const comment = { body: [{ type: 'text', text: 'Is this still right?' }] };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`reactions to a comment over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });

    const start = async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const r = await h.call('POST', threads(doc), {
        token: as(doc, 'editor', 'ed-1'),
        body: { target: { block: BODY_BLOCK }, comment },
      });
      expect(r.status).toBe(201);
      const first = (r.json.comments as Array<{ id: string; etag: string; author: string }>)[0]!;
      // d-1 wrote the comment, so the author is how the service names d-1.
      return {
        doc,
        thread: r.json.id as string,
        cid: first.id,
        etag: first.etag,
        ed: first.author,
      };
    };
    const url = (cid: string, reaction: string) => `/v1/comments/${cid}/reactions/${reaction}`;

    it.skipIf(skip)('adds and removes a reaction, in order, without changing the tag', async () => {
      const { doc, cid, etag, ed } = await start();
      const a = await h.call('POST', url(cid, 'heart'), { token: as(doc, 'editor', 'ed-1') });
      expect(a.status).toBe(200);
      expect(a.json.reactions).toEqual([{ reaction: 'heart', users: [ed] }]);
      expect(a.headers.get('etag')).toBe(etag);
      const co = (
        await h.call('POST', url(cid, 'thumbsUp'), { token: as(doc, 'commenter', 'co-1') })
      ).json.reactions[0].users[0] as string;
      const b = await h.call('POST', url(cid, 'heart'), { token: as(doc, 'commenter', 'co-1') });
      // The wire order is the order of the set; the people are in the order they reacted.
      expect(b.json.reactions).toEqual([
        { reaction: 'thumbsUp', users: [co] },
        { reaction: 'heart', users: [ed, co] },
      ]);
      const gone = await h.call('DELETE', url(cid, 'heart'), { token: as(doc, 'editor', 'ed-1') });
      expect(gone.status).toBe(200);
      expect(gone.json.reactions).toEqual([
        { reaction: 'thumbsUp', users: [co] },
        { reaction: 'heart', users: [co] },
      ]);
    });

    it.skipIf(skip)('is idempotent and leaves a reaction nobody holds out', async () => {
      const { doc, cid, ed } = await start();
      const token = (): string => as(doc, 'editor', 'ed-1');
      await h.call('POST', url(cid, 'eyes'), { token: token() });
      const again = await h.call('POST', url(cid, 'eyes'), { token: token() });
      expect(again.json.reactions).toEqual([{ reaction: 'eyes', users: [ed] }]);
      await h.call('DELETE', url(cid, 'eyes'), { token: token() });
      const twice = await h.call('DELETE', url(cid, 'eyes'), { token: token() });
      expect(twice.status).toBe(200);
      expect(twice.json.reactions).toBeUndefined();
    });

    it.skipIf(skip)(
      'is read with the thread, and a notice goes out only for a change',
      async () => {
        const { doc, thread, cid, ed } = await start();
        const count = (): number =>
          h.stub.notices.filter(
            (n) => n.kind === 'notify' && n.notification?.type === 'comment.reacted',
          ).length;
        const before = count();
        await h.call('POST', url(cid, 'done'), { token: as(doc, 'editor', 'ed-1') });
        await h.call('POST', url(cid, 'done'), { token: as(doc, 'editor', 'ed-1') });
        expect(count()).toBe(before + 1);
        const t = await h.call('GET', `/v1/threads/${thread}`, {
          token: as(doc, 'editor', 'ed-1'),
        });
        expect(t.json.comments[0].reactions).toEqual([{ reaction: 'done', users: [ed] }]);
        await h.call('DELETE', url(cid, 'done'), { token: as(doc, 'editor', 'ed-1') });
        expect(count()).toBe(before + 2);
      },
    );

    it.skipIf(skip)(
      'needs comment, knows only the six reactions, and finds only a live comment',
      async () => {
        const { doc, cid } = await start();
        const viewer = await h.call('POST', url(cid, 'heart'), {
          token: as(doc, 'viewer', 'vi-1'),
        });
        expect([403, 404]).toContain(viewer.status);
        const odd = await h.call('POST', url(cid, 'clap'), { token: as(doc, 'editor', 'ed-1') });
        expect(odd.status).toBe(400);
        const none = await h.call('POST', url('00000000-0000-7000-8000-000000000000', 'heart'), {
          token: as(doc, 'editor', 'ed-1'),
        });
        expect(none.status).toBe(404);
      },
    );
  });
}
