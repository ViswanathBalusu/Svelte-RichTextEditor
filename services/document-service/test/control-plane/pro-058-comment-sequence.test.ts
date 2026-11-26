// PRO-058 criterion 3 over HTTP (lane w5; owner decision 73): a comment has a sequence number of
// its own in its document, and the activity lists the comments of other people above the caller's
// comment marker, in that order. In-memory storage and PostgreSQL (migration 0102).
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

function firstBlock(doc: unknown): string {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: string | null = null;
  root.descendants((n) => {
    if (!found && n.isTextblock) found = String(n.attrs['id']);
    return !found;
  });
  if (!found) throw new Error('no text block');
  return found;
}

const body = (text: string) => [{ type: 'text', text }];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`comment activity by comment sequence number (${storage}, PRO-058)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let other: string;
    let block: string;
    let otherBlock: string;
    const as = (sub: string, id = doc) => h.userToken({ [id]: 'owner' }, { sub });

    const comment = async (sub: string, text: string, id = doc, blk = block) => {
      const r = await h.call('POST', `/v1/documents/${id}/threads`, {
        token: as(sub, id),
        body: { target: { block: blk }, comment: { body: body(text) } },
      });
      expect(r.status, r.text).toBe(201);
      return r.json as { id: string };
    };
    const activity = async (sub: string) => {
      const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as(sub) });
      expect(r.status, r.text).toBe(200);
      return r.json as {
        commentMarker: number;
        commentHead: number;
        comments: Array<{ seq: number; author: string; body: Array<{ text: string }> }>;
      };
    };
    const put = (sub: string, payload: Record<string, unknown>) => {
      const r = h.call('PUT', `/v1/documents/${doc}/read-marker`, {
        token: as(sub),
        headers: { 'If-Match': '*' },
        body: payload,
      });
      return r;
    };

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Comments' });
      other = await h.createDocument({ content: documentWithRegions(), title: 'Other' });
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      block = firstBlock(content.json.doc);
      const c2 = await h.call('GET', `/v1/documents/${other}/content`, { token: h.apiKey });
      otherBlock = firstBlock(c2.json.doc);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'numbers the comments of a document in order, and lists those of others above the marker',
      async () => {
        const t1 = await comment('bob', 'first');
        await comment('alice', 'mine');
        await comment('bob', 'second');
        // A reply is a comment too: it takes the next number.
        const reply = await h.call('POST', `/v1/threads/${t1.id}/comments`, {
          token: as('bob'),
          body: { body: body('reply') },
        });
        expect(reply.status, reply.text).toBeLessThan(300);
        // Another document counts on its own.
        await comment('bob', 'elsewhere', other, otherBlock);

        const a = await activity('alice');
        expect(a.commentMarker).toBe(0);
        expect(a.commentHead).toBe(4);
        expect(a.comments.map((c) => [c.seq, c.author, c.body[0]!.text])).toEqual([
          [1, 'bob', 'first'],
          [3, 'bob', 'second'],
          [4, 'bob', 'reply'],
        ]);

        // Alice has read up to the third comment: only the one after it is new.
        const moved = await put('alice', { seq: 0, commentSeq: 3 });
        expect(moved.status, moved.text).toBe(200);
        expect(moved.json).toEqual({ seq: 0, commentSeq: 3 });
        const after = await activity('alice');
        expect(after.commentMarker).toBe(3);
        expect(after.comments.map((c) => c.seq)).toEqual([4]);

        // The marker only moves forward, and on its own: the log marker is not touched.
        const back = await put('alice', { seq: 0, commentSeq: 1 });
        expect(back.json).toEqual({ seq: 0, commentSeq: 3 });
        const same = await put('alice', { seq: 0 });
        expect(same.json).toEqual({ seq: 0 });
        expect((await activity('alice')).commentMarker).toBe(3);

        // Bob's marker is his own: he still sees the comment of alice.
        const b = await activity('bob');
        expect(b.commentMarker).toBe(0);
        expect(b.comments.map((c) => [c.seq, c.author])).toEqual([[2, 'alice']]);
      },
    );

    it.skipIf(skip)(
      'refuses a comment marker beyond the last comment, or not a number',
      async () => {
        const beyond = await put('alice', { seq: 0, commentSeq: 99 });
        expect(beyond.status).toBe(404);
        const bad = await put('alice', { seq: 0, commentSeq: -1 });
        expect(bad.status).toBe(400);
        const text = await put('alice', { seq: 0, commentSeq: '2' });
        expect(text.status).toBe(400);
      },
    );

    it.skipIf(skip)('does not reuse a number after a thread is deleted', async () => {
      const t = await comment('bob', 'to delete');
      const before = await activity('alice');
      const last = before.commentHead;
      const gone = await h.call('GET', `/v1/threads/${t.id}`, { token: as('bob') });
      const del = await h.call('DELETE', `/v1/threads/${t.id}`, {
        token: as('bob'),
        headers: { 'If-Match': gone.headers.get('etag')! },
      });
      expect(del.status, del.text).toBeLessThan(300);
      await comment('bob', 'after delete');
      const after = await activity('alice');
      expect(after.commentHead).toBe(last + 1);
      expect(after.comments.at(-1)!.seq).toBe(last + 1);
    });
  });
}
