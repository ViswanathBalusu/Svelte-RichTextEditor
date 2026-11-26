// EXP-084 criterion 2 (with 3 and 4): an export with `comments: margin` carries the open comment
// threads mapped to the exported `seq`, as the control plane's payload for the worker. Over HTTP,
// with in-memory storage and with PostgreSQL. Test values only. The commit that moves or deletes
// the text is appended through the log store, as in pro-059-range-threads.test.ts.
import { uuid7, type JsonNode } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plainTextOf, UNKNOWN_PERSON } from '../../src/control-plane/export-comments.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

describe('plainTextOf', () => {
  it('joins the text parts and never prints a mention identifier', () => {
    expect(
      plainTextOf([
        { type: 'text', text: 'Ask ' },
        { type: 'mention', principal: 'user:ada@example.test' },
        { type: 'text', text: ' about this.' },
      ]),
    ).toBe('Ask @mention about this.');
    expect(plainTextOf(null)).toBe('');
  });
});

/** The first text block: its position (inside it) and its identifier. */
function firstBlock(doc: unknown): { pos: number; id: string } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { pos: number; id: string } | null = null;
  root.descendants((n, pos) => {
    if (!found && n.isTextblock) found = { pos: pos + 1, id: String(n.attrs['id']) };
  });
  return found!;
}

/** Appends one commit that replaces `from` to `to` with `text` in the body, as a room would. */
async function edit(h: Harness, doc: string, from: number, to: number, text: string) {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const slice = text === '' ? {} : { slice: { content: [{ type: 'text', text }] } };
  const commit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps' as const,
    steps: [{ stepType: 'replace', from, to, ...slice }] as never,
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
  };
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits: [commit],
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + 1;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`EXP-084 margin comments in the export payload (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, { config: { exportTargets: ['pdf', 'tex', 'md'] } });
    });
    afterAll(async () => {
      await h?.close();
    });

    const as = (doc: string, role: string, sub: string, name?: string) =>
      h.userToken({ [doc]: role }, { sub, ...(name ? { name } : {}) });

    async function start(doc: string, text: string, who = 'ed-1', name = 'Ada Lovelace') {
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const b = firstBlock(content.json.doc as JsonNode);
      const head = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
      const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: as(doc, 'editor', who, name),
        body: {
          target: { range: { from: b.pos, to: b.pos + 5, baseSeq: head } },
          comment: { body: [{ type: 'text', text }] },
        },
      });
      expect(made.status, made.text).toBe(201);
      return { b, thread: made.json as { id: string }, etag: made.headers.get('etag')! };
    }

    async function payloadOf(
      doc: string,
      options: Record<string, unknown>,
      extra = {},
      role = 'viewer',
    ) {
      const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: as(doc, role, role === 'viewer' ? 'vw-1' : 'ed-1'),
        body: { target: 'pdf', options, ...extra },
      });
      expect(r.status, r.text).toBe(202);
      const job = await h.parts.queue.get(h.tenant, r.json.id as string);
      return job!.payload;
    }

    it.skipIf(skip)(
      'carries an open range thread with its paragraph, the words it covers and the display name',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const { b, thread } = await start(doc, 'Is this still right?');
        const p = await payloadOf(doc, { comments: 'margin' });
        expect(p['commentThreads']).toEqual([
          {
            id: thread.id,
            block: b.id,
            quote: 'Hello',
            messages: [{ author: 'Ada Lovelace', text: 'Is this still right?' }],
          },
        ]);
        // `none`, or no option: the payload carries no threads.
        expect((await payloadOf(doc, { comments: 'none' }))['commentThreads']).toBeUndefined();
        expect((await payloadOf(doc, {}))['commentThreads']).toBeUndefined();
      },
    );

    it.skipIf(skip)(
      'maps the range to the exported seq, and leaves out a later thread',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const before = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
        const first = firstBlock(content.json.doc as JsonNode);
        await edit(h, doc, first.pos, first.pos, 'Well, ');
        // The thread is made on `Well,` after the first commit.
        const { b } = await start(doc, 'First.');
        // Text typed at the start of the paragraph moves the range to the right, not the words.
        await edit(h, doc, b.pos, b.pos, 'Oh ');
        const atHead = (await payloadOf(doc, { comments: 'margin' }))['commentThreads'] as Array<{
          block: string;
          quote: string;
        }>;
        expect(atHead).toHaveLength(1);
        expect(atHead[0]!.block).toBe(b.id);
        expect(atHead[0]!.quote).toBe('Well,');
        // At a seq before the thread was made, it did not exist.
        const earlier = await payloadOf(doc, { comments: 'margin' }, { seq: before }, 'editor');
        expect(earlier['commentThreads']).toEqual([]);
      },
    );

    it.skipIf(skip)('lists a range whose text was deleted as detached (criterion 3)', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const { b, thread } = await start(doc, 'Gone soon.');
      await edit(h, doc, b.pos, b.pos + 5, '');
      const out = (await payloadOf(doc, { comments: 'margin' }))['commentThreads'] as Array<{
        id: string;
        detached?: boolean;
        block: string;
      }>;
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: thread.id, detached: true, block: '' });
    });

    it.skipIf(skip)('leaves out a resolved thread (owner decision 52)', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const { thread, etag } = await start(doc, 'Done.');
      const r = await h.call('PATCH', `/v1/threads/${thread.id}`, {
        token: as(doc, 'editor', 'ed-1', 'Ada Lovelace'),
        headers: { 'If-Match': etag },
        body: { state: 'resolved' },
      });
      expect(r.status, r.text).toBe(200);
      expect((await payloadOf(doc, { comments: 'margin' }))['commentThreads']).toEqual([]);
    });

    it.skipIf(skip)(
      'names a person with no display name "Unknown person" (decision 39)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await start(doc, 'No name.', 'ed-2', '');
        const out = (await payloadOf(doc, { comments: 'margin' }))['commentThreads'] as Array<{
          messages: Array<{ author: string }>;
        }>;
        expect(out[0]!.messages[0]!.author).toBe(UNKNOWN_PERSON);
      },
    );

    it.skipIf(skip)('is part of the request key: a new comment is a new job', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      await start(doc, 'One.');
      const body = { target: 'pdf', options: { comments: 'margin' } };
      const call = () =>
        h.call('POST', `/v1/documents/${doc}/exports`, { token: as(doc, 'viewer', 'vw-1'), body });
      const first = await call();
      await start(doc, 'Two.', 'ed-3', 'Grace Hopper');
      const second = await call();
      expect(second.json.id).not.toBe(first.json.id);
    });

    it.skipIf(skip)('refuses margin comments for md, which has no margin', async () => {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token: as(doc, 'viewer', 'vw-1'),
        body: { target: 'md', options: { comments: 'margin' } },
      });
      // The control plane queues it and the worker refuses (option_unsupported); no threads are carried.
      expect(r.status).toBe(202);
      const job = await h.parts.queue.get(h.tenant, r.json.id as string);
      expect(job!.payload['commentThreads']).toBeUndefined();
    });
  });
}
