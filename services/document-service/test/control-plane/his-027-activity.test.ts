// HIS-027 over HTTP (lane w7): `GET /documents/{id}/activity` returns the changes of other people
// since the caller's marker as a comparison with a summary per region, the comments of other people,
// and the mentions and tasks addressed to the caller ("for you"); a very long gap is compared by
// block alignment in a worker thread (08 §10; 05 §6.2). In-memory storage and PostgreSQL; the long
// gap runs on the in-memory store only. The commits are appended as a room would, through the log.
import { threadId } from 'node:worker_threads';
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

const typing = (pos: number, text: string) => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

function firstText(doc: unknown): { pos: number; block: string } {
  const root = cdmSchema().nodeFromJSON(doc);
  let found: { pos: number; block: string } | null = null;
  root.descendants((n, pos) => {
    if (!found && n.isTextblock) found = { pos: pos + 1, block: String(n.attrs['id']) };
    return !found;
  });
  if (!found) throw new Error('no text block');
  return found;
}

/** Appends `count` typing commits by one user, at the clock's time. */
async function appendBy(h: Harness, doc: string, user: string, pos: number, count = 1) {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-027-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const time = h.now();
  const commits = Array.from({ length: count }, (_, i) => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps' as const,
    steps: [typing(pos, 'x')] as never,
    user,
    session: 'session-test',
    time,
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  }));
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  if (r.status !== 'ok') throw new Error(`append refused: ${r.status}`);
  return head.seq + count;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the activity since the marker over HTTP (${storage}, HIS-027)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let doc: string;
    let block: string;
    let alice: string;
    let bob: string;
    const as = (sub: string) => h.userToken({ [doc]: 'owner' }, { sub });

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      doc = await h.createDocument({ content: documentWithRegions(), title: 'Activity' });
      alice = (await h.parts.users.resolve(h.tenant, 'alice')).surrogate;
      bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      const at = firstText(content.json.doc);
      block = at.block;
      // seq 1 and 3 by bob, seq 2 by alice (the caller's own).
      h.advance(1000);
      await appendBy(h, doc, bob, at.pos);
      h.advance(1000);
      await appendBy(h, doc, alice, at.pos);
      h.advance(1000);
      await appendBy(h, doc, bob, at.pos);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'returns a comparison with a summary per region, without the caller own changes (criterion 3)',
      async () => {
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as('alice') });
        expect(r.status, r.text).toBe(200);
        expect(r.json).toMatchObject({ marker: 0, head: 3, fromSeq: 0 });
        expect(r.json.items.map((i: { seq: number }) => i.seq)).toEqual([1, 3]);
        const c = r.json.comparison;
        expect(c).toMatchObject({ fromSeq: 0, toSeq: 3, method: 'steps' });
        const spans = c.changes.flatMap((x: { spans?: Array<{ user?: string }> }) => x.spans ?? []);
        expect(spans.length).toBeGreaterThan(0);
        // Every span of the comparison is by bob: the commit of alice is not in it.
        expect(spans.every((s: { user?: string }) => s.user === 'bob')).toBe(true);
        expect(Array.isArray(r.json.summary)).toBe(true);
        expect(r.json.summary.length).toBeGreaterThan(0);
        // Bob sees alice's change, and not his own.
        const b = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as('bob') });
        const bobSpans = b.json.comparison.changes.flatMap(
          (x: { spans?: Array<{ user?: string }> }) => x.spans ?? [],
        );
        expect(bobSpans.every((s: { user?: string }) => s.user === 'alice')).toBe(true);
      },
    );

    it.skipIf(skip)(
      'offers nothing when the marker is at the head (criterion 6 of the story: no activity)',
      async () => {
        const put = await h.call('PUT', `/v1/documents/${doc}/read-marker`, {
          token: as('carol'),
          body: { seq: 3 },
        });
        expect(put.status, put.text).toBe(200);
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as('carol') });
        expect(r.status).toBe(200);
        expect(r.json).toMatchObject({ marker: 3, items: [], comparison: null, summary: [] });
        expect(r.json.comments).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'lists the comments of others, with mentions and tasks for the caller first (criterion 4)',
      async () => {
        h.advance(1000);
        const mention = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as('bob'),
          body: {
            target: { block },
            comment: {
              body: [
                { type: 'text', text: 'Please look ' },
                { type: 'mention', principal: 'user:alice' },
              ],
            },
          },
        });
        expect(mention.status, mention.text).toBe(201);
        const plain = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as('bob'),
          body: { target: { block }, comment: { body: 'A remark without a mention' } },
        });
        expect(plain.status, plain.text).toBe(201);
        const mine = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: as('alice'),
          body: { target: { block }, comment: { body: 'My own comment' } },
        });
        expect(mine.status, mine.text).toBe(201);
        // A task: a thread assigned to alice.
        const task = await h.call('GET', `/v1/threads/${plain.json.id}`, { token: as('bob') });
        const assigned = await h.call('PATCH', `/v1/threads/${plain.json.id}`, {
          token: as('bob'),
          headers: { 'If-Match': task.headers.get('etag')! },
          body: { assignee: 'user:alice' },
        });
        expect(assigned.status, assigned.text).toBe(200);

        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as('alice') });
        expect(r.status, r.text).toBe(200);
        const authors = r.json.comments.map((c: { author: string }) => c.author);
        expect(authors).toEqual(['bob', 'bob']);
        expect(r.text).not.toContain('My own comment');
        const kinds = r.json.forYou.map((x: { kind: string }) => x.kind);
        expect(kinds).toEqual(['mention', 'task']);
        expect(r.json.forYou[0]).toMatchObject({
          kind: 'mention',
          thread: mention.json.id,
          author: 'bob',
        });
        expect(r.json.forYou[1]).toMatchObject({
          kind: 'task',
          thread: plain.json.id,
          state: 'open',
        });

        // Bob is mentioned nowhere and has nothing assigned; he sees the comment of alice.
        const b = await h.call('GET', `/v1/documents/${doc}/activity`, { token: as('bob') });
        expect(b.json.forYou).toEqual([]);
        expect(b.json.comments.map((c: { author: string }) => c.author)).toEqual(['alice']);
      },
    );

    it.skipIf(skip)(
      'a viewer under the default setting gets the activity from the gate, and nothing below it',
      async () => {
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'dave' });
        const r = await h.call('GET', `/v1/documents/${doc}/activity`, { token: viewer });
        expect(r.status, r.text).toBe(200);
        expect(r.json.fromSeq).toBe(3);
        expect(r.json.items.every((i: { seq: number }) => i.seq >= 3)).toBe(true);
        expect(r.json.comparison).toBeNull();
      },
    );
  });
}

describe('a very long gap is compared by block alignment in a worker thread (HIS-027 criterion 6)', () => {
  let h: Harness;
  let doc: string;
  const seen: { kind: string; thread: number | null }[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', { realDataPlane: true });
    doc = await h.createDocument({ content: documentWithRegions(), title: 'Long gap' });
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
    await appendBy(h, doc, bob, firstText(content.json.doc).pos, 2_001);
    const pool = h.service.pool;
    const run = pool.run.bind(pool) as (kind: string, input: unknown) => Promise<unknown>;
    (pool as { run: unknown }).run = async (kind: string, input: unknown) => {
      const out = await run(kind, input);
      seen.push({ kind, thread: (out as { threadId?: number }).threadId ?? null });
      return out;
    };
  }, 120_000);
  afterAll(async () => {
    await h?.close();
  });

  it('uses the aligned method for a gap of more than 2,000 commits, and a thread other than the main one answers', async () => {
    const r = await h.call('GET', `/v1/documents/${doc}/activity`, {
      token: h.userToken({ [doc]: 'owner' }, { sub: 'alice' }),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json.head).toBe(2_001);
    expect(r.json.comparison).toMatchObject({ fromSeq: 0, toSeq: 2_001, method: 'aligned' });
    const compares = seen.filter((s) => s.kind === 'compare');
    expect(compares.length).toBeGreaterThan(0);
    expect(compares.every((c) => c.thread !== null && c.thread !== threadId)).toBe(true);
  }, 120_000);
});
