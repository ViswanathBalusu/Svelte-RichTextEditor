// Mentions in a comment body (PRO-060 criterion 4; 05 §6.2; 13 §5) over HTTP, with in-memory
// storage and with PostgreSQL: a reply and a new thread raise `dep.comment.mentioned` once for each
// distinct principal, besides `comment.created`; a comment without a mention raises none; an edit
// raises none. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mentionsOf } from '../../src/control-plane/mentions.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const BODY_BLOCK = 'pEnd000000000001';

/** A comment body with text and mention nodes, as the editor's mention picker writes it. */
const body = (...principals: string[]) => ({
  body: [
    { type: 'text', text: 'Please look at this ' },
    ...principals.flatMap((p) => [
      { type: 'mention', principal: p },
      { type: 'text', text: ' ' },
    ]),
  ],
});

describe('mentionsOf (PRO-060 criterion 4)', () => {
  it('reads mention nodes wherever they lie, once each, in order of appearance', () => {
    expect(mentionsOf(body('user:ann', 'group:legal', 'user:ann'))).toEqual([
      'user:ann',
      'group:legal',
    ]);
    expect(
      mentionsOf({ type: 'doc', content: [{ type: 'p', content: [body('user:ben').body[1]] }] }),
    ).toEqual(['user:ben']);
  });

  it('ignores text, other nodes and principals that are not user: or group: identifiers', () => {
    expect(mentionsOf(undefined)).toEqual([]);
    expect(mentionsOf('hello @ann')).toEqual([]);
    expect(mentionsOf({ text: 'Is this still right?' })).toEqual([]);
    expect(mentionsOf({ type: 'mention', principal: 'ann' })).toEqual([]);
    expect(mentionsOf({ type: 'mention', principal: 'user:a b' })).toEqual([]);
    expect(mentionsOf({ type: 'link', principal: 'user:ann' })).toEqual([]);
    expect(mentionsOf({ type: 'mention', principal: 7 })).toEqual([]);
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`comment mentions over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string) => h.userToken({ [doc]: role }, { sub });
    const mentioned = (doc: string) =>
      h.events.of('dep.comment.mentioned.v1').filter((e) => e.subject === doc);

    it.skipIf(skip)(
      'raises dep.comment.mentioned once for each distinct principal of a reply, besides comment.created',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const t = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as(doc, 'editor', 'ed-1'),
          body: {
            target: { block: BODY_BLOCK },
            comment: { body: [{ type: 'text', text: 'No mention here' }] },
          },
        });
        expect(t.status).toBe(201);
        expect(mentioned(doc)).toEqual([]);

        const createdBefore = h.events.of('dep.comment.created.v1').length;
        const r = await h.call('POST', `/v1/threads/${t.json.id}/comments`, {
          token: as(doc, 'editor', 'ed-2'),
          body: body('user:ann', 'group:legal', 'user:ann'),
        });
        expect(r.status, r.text).toBe(201);
        expect(h.events.of('dep.comment.created.v1').length).toBe(createdBefore + 1);
        const events = mentioned(doc);
        expect(events.map((e) => e.data['principal'])).toEqual(['user:ann', 'group:legal']);
        for (const e of events)
          expect(e.data).toMatchObject({ comment: r.json.id, thread: t.json.id });
      },
    );

    it.skipIf(skip)('raises none for a reply without a mention, or for an edit', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const t = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: as(doc, 'editor', 'ed-1'),
        body: {
          target: { block: BODY_BLOCK },
          comment: { body: [{ type: 'text', text: 'First' }] },
        },
      });
      const plain = await h.call('POST', `/v1/threads/${t.json.id}/comments`, {
        token: as(doc, 'editor', 'ed-2'),
        body: { body: [{ type: 'text', text: 'A plain reply' }] },
      });
      expect(plain.status).toBe(201);
      const edit = await h.call('PATCH', `/v1/comments/${plain.json.id}`, {
        token: as(doc, 'editor', 'ed-2'),
        headers: { 'If-Match': plain.headers.get('etag') as string },
        body: body('user:ben'),
      });
      expect(edit.status, edit.text).toBe(200);
      expect(mentioned(doc)).toEqual([]);
    });

    it.skipIf(skip)('raises it for the first comment of a new thread', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const t = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: as(doc, 'editor', 'ed-1'),
        body: { target: { block: BODY_BLOCK }, comment: body('user:cara') },
      });
      expect(t.status).toBe(201);
      const events = mentioned(doc);
      expect(events.map((e) => e.data['principal'])).toEqual(['user:cara']);
      expect(events[0]!.data).toMatchObject({ thread: t.json.id });
    });

    it.skipIf(skip)('raises none for a reply that is refused', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const t = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: as(doc, 'editor', 'ed-1'),
        body: {
          target: { block: BODY_BLOCK },
          comment: { body: [{ type: 'text', text: 'First' }] },
        },
      });
      const refused = await h.call('POST', `/v1/threads/${t.json.id}/comments`, {
        token: as(doc, 'viewer', 'vw-1'),
        body: body('user:dan'),
      });
      expect(refused.status).toBe(403);
      expect(mentioned(doc)).toEqual([]);
    });
  });
}
