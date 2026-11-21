// PRO-036 criteria 1 to 3 on the control plane's side (lane w5; 05 section 5.6): each thread and
// comment route sends its notification, with the thread as `resource`, and a thread event's `data`
// carries the thread's current range and the `seq` it refers to (SYN-032). The notifications are
// those the stub data plane records; the real socket is in pro-036-live-events.test.ts. Memory and
// PostgreSQL. Test values only. The commit that moves the text is appended through the log store,
// as a room would append it.
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const comment = { body: [{ type: 'text', text: 'Is this still right?' }] };
const BODY_BLOCK = 'pEnd000000000001';
const LEGAL_BLOCK = 'pLegal0000000001';

function firstTextPosition(doc: unknown): number {
  const root = cdmSchema().nodeFromJSON(doc);
  let found = -1;
  root.descendants((n, pos) => {
    if (found < 0 && n.isTextblock) found = pos + 1;
  });
  return found;
}

async function typeAt(h: Harness, doc: string, pos: number, text: string): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [
      {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps' as const,
        steps: [
          { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
        ] as never,
        user: 'test-author',
        session: 'session-test',
        time: h.now(),
        origin: 'input',
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed: [],
      },
    ],
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + 1;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`thread and comment notifications of the routes (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    const sent = () =>
      h.stub.notices.flatMap((n) =>
        n.kind === 'notify' && n.notification
          ? [{ ...n.notification, scopes: n.scopes, user: n.user }]
          : [],
      );
    const last = (type: string) =>
      sent()
        .filter((n) => n.type === type)
        .at(-1);

    it.skipIf(skip)(
      'sends thread.created, thread.updated, thread.resolved, thread.reopened and thread.deleted with the thread as resource, each with its current range and seq (criteria 1 and 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const p = firstTextPosition(content.json.doc);
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-36' });
        const threads = `/v1/documents/${doc}/threads`;

        const made = await h.call('POST', threads, {
          token: owner,
          body: { target: { range: { from: p, to: p + 5, baseSeq: 0 } }, comment },
        });
        expect(made.status, made.text).toBe(201);
        const tid = made.json.id as string;
        const resource = `/threads/${tid}`;
        const created = last('thread.created')!;
        expect(created.resource).toBe(resource);
        expect(created.data).toEqual({ state: 'open', seq: 0, range: { from: p, to: p + 5 } });
        expect(created.scopes).toEqual(['body']);

        // Text typed at the start moves the range: later events carry the range at the head.
        const head = await typeAt(h, doc, p, 'ab');
        let tag = made.headers.get('etag')!;
        const patch = async (body: Record<string, unknown>) => {
          const r = await h.call('PATCH', `/v1/threads/${tid}`, {
            token: owner,
            body,
            headers: { 'If-Match': tag },
          });
          expect(r.status, r.text).toBe(200);
          tag = r.headers.get('etag')!;
        };
        const moved = { range: { from: p + 2, to: p + 7 }, seq: head };

        await patch({ assignee: 'someone' });
        expect(last('thread.updated')).toMatchObject({
          resource,
          data: { state: 'open', ...moved },
        });
        await patch({ state: 'resolved' });
        expect(last('thread.resolved')).toMatchObject({
          resource,
          data: { state: 'resolved', ...moved },
        });
        await patch({ state: 'open' });
        expect(last('thread.reopened')).toMatchObject({
          resource,
          data: { state: 'open', ...moved },
        });

        const gone = await h.call('DELETE', `/v1/threads/${tid}`, { token: owner });
        expect(gone.status).toBe(204);
        expect(last('thread.deleted')).toMatchObject({ resource, data: moved });
      },
    );

    it.skipIf(skip)(
      'names the block of a block thread, and the scope of a thread in a region, for the data plane to filter on',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-36b' });
        const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: LEGAL_BLOCK }, comment },
        });
        expect(made.status, made.text).toBe(201);
        const created = last('thread.created')!;
        expect(created.data).toEqual({ state: 'open', seq: 0, block: LEGAL_BLOCK });
        expect(created.scopes).toEqual(['region:rLegal0000000001']);

        const inBody = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: BODY_BLOCK }, comment },
        });
        expect(inBody.status, inBody.text).toBe(201);
        expect(last('thread.created')!.scopes).toEqual(['body']);
      },
    );

    it.skipIf(skip)(
      'sends comment.created, comment.updated and comment.deleted with the comment as resource (criterion 3)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: 'ow-36c' });
        const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: BODY_BLOCK }, comment },
        });
        const tid = made.json.id as string;

        const reply = await h.call('POST', `/v1/threads/${tid}/comments`, {
          token: owner,
          body: { body: [{ type: 'text', text: 'A reply' }] },
        });
        expect(reply.status, reply.text).toBe(201);
        const cid = reply.json.id as string;
        expect(last('comment.created')).toMatchObject({
          resource: `/comments/${cid}`,
          data: { thread: tid },
          scopes: ['body'],
        });

        const edit = await h.call('PATCH', `/v1/comments/${cid}`, {
          token: owner,
          body: { body: [{ type: 'text', text: 'An edited reply' }] },
          headers: { 'If-Match': reply.headers.get('etag')! },
        });
        expect(edit.status, edit.text).toBe(200);
        expect(last('comment.updated')).toMatchObject({
          resource: `/comments/${cid}`,
          data: { thread: tid },
        });

        const removed = await h.call('DELETE', `/v1/comments/${cid}`, { token: owner });
        expect(removed.status, removed.text).toBe(204);
        expect(last('comment.deleted')).toMatchObject({
          resource: `/comments/${cid}`,
          data: { thread: tid },
        });
      },
    );
  });
}
