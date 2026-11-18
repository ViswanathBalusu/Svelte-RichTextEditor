// PRM-042: no side door to text below the history gate. The threads at a `seq`, a fork that names an
// acting user in `DEP-Actor`, and a named version opened by a reader without `edit` anywhere, each
// over real HTTP on memory and on PostgreSQL (07 §8; ADR 0034; ADR 0379, proposed). The content,
// diff, attribution, activity and export routes have their own tests (his-024-content-gate,
// pro-055-diff-attribution, pro-058-read-marker-activity, routes.exports-gate).
// PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010).
import { randomUUID } from 'node:crypto';
import type { StoredCommit } from '@docedit/authority';
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

const INTRO = 'pIntro0000000001';
const LEGAL = 'rLegal0000000001';
const BLOCK = 'pEnd000000000001';

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Appends one text commit per entry of `texts`, as an editor's steps would. */
async function append(h: Harness, doc: string, texts: string[]): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'prm-042-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = texts.map((t, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text: t }] } },
    ] as StoredCommit['steps'],
    user: 'u-alice',
    session: 'session-test',
    time: h.now(),
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
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`history surfaces under the gate (PRM-042, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document with a head of 3, a thread on a block, and the default `editors` setting. */
    async function document(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions() });
      await append(h, doc, ['a', 'b', 'c']);
      const made = await h.call('POST', `/v1/documents/${doc}/threads`, {
        token: h.userToken({ [doc]: 'editor' }, { sub: 'ed-1' }),
        body: { target: { block: BLOCK }, comment: { text: 'A question' } },
      });
      expect(made.status, made.text).toBe(201);
      return doc;
    }

    const threadsAt = (doc: string, token: string, seq?: number) =>
      h.call('GET', `/v1/documents/${doc}/threads${seq === undefined ? '' : `?seq=${seq}`}`, {
        token,
      });
    const fork = (doc: string, atSeq: number, actor?: string) =>
      h.call('POST', `/v1/documents/${doc}/fork`, {
        token: h.apiKey,
        headers: { 'Idempotency-Key': randomUUID(), ...(actor ? { 'DEP-Actor': actor } : {}) },
        body: { atSeq },
      });

    it.skipIf(skip)(
      'refuses the threads of a state below the gate and serves them at or above it (criterion 1)',
      async () => {
        const doc = await document();
        const owner = h.userToken({ [doc]: 'owner' });
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });

        const below = await threadsAt(doc, viewer, 1);
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        expect(below.text).not.toContain('A question');

        expect((await threadsAt(doc, viewer, 3)).status).toBe(200);
        expect((await threadsAt(doc, viewer)).status).toBe(200);
        // A role with `edit` sees full history under the default setting.
        const full = await threadsAt(doc, owner, 1);
        expect(full.status).toBe(200);
        expect(full.json.items).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      'opens a named version to a reader without edit, on the content and threads routes (criterion 6)',
      async () => {
        const doc = await document();
        const owner = h.userToken({ [doc]: 'owner' });
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });
        const content = (seq: number) =>
          h.call('GET', `/v1/documents/${doc}/content?seq=${seq}`, { token: viewer });

        expect((await content(1)).status).toBe(403);
        const named = await h.call('POST', `/v1/documents/${doc}/versions`, {
          token: owner,
          body: { seq: 1, name: 'First review' },
        });
        expect(named.status, named.text).toBe(201);

        const opened = await content(1);
        expect(opened.status).toBe(200);
        expect(opened.json).toMatchObject({ seq: 1 });
        expect((await threadsAt(doc, viewer, 1)).status).toBe(200);
        // Only the named state opens: its neighbours stay behind the gate.
        expect((await content(0)).status).toBe(403);
        expect((await content(2)).status).toBe(403);
        expect((await threadsAt(doc, viewer, 2)).status).toBe(403);
      },
    );

    it.skipIf(skip)(
      'returns no text below the gate from history, diff or attribution (criterion 2)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, ['Zedone', 'Zedtwo', 'Zedthree']);
        const owner = h.userToken({ [doc]: 'owner' });
        const viewer = h.userToken({ [doc]: 'viewer' }, { sub: 'carol' });
        const get = (path: string, token: string) =>
          h.call('GET', `/v1/documents/${doc}${path}`, { token });

        // The owner reads the whole range: the control that shows the text is there to leak.
        const all = await get('/diff?fromSeq=0&toSeq=3', owner);
        expect(all.status, all.text).toBe(200);
        expect(all.text).toContain('Zed');
        expect((await get('/history', owner)).status).toBe(200);
        expect((await get('/attribution?atSeq=1', owner)).status).toBe(200);

        // The viewer's gate is the head (`editors`; ADR 0034): a range that starts, ends or
        // straddles below it is refused whole, and the refusal carries none of the text.
        const refused = [
          await get('/history?fromSeq=1', viewer),
          await get('/history?toSeq=1', viewer),
          await get('/diff?fromSeq=1&toSeq=3', viewer),
          await get('/diff?fromSeq=0&toSeq=3', viewer),
          await get('/attribution?atSeq=1', viewer),
          await get('/attribution?atSeq=2', viewer),
        ];
        for (const r of refused) {
          expect(r.status, r.text).toBe(403);
          expect(r.json.code).toBe('forbidden');
          expect(r.text).not.toContain('Zed');
        }

        // At the gate the same routes answer, and what they answer holds nothing from below it.
        const history = await get('/history', viewer);
        expect(history.status, history.text).toBe(200);
        expect(history.text).not.toContain('Zed');
        for (const item of history.json.items as Array<{ type: string; fromSeq?: number }>)
          if (item.type === 'group') expect(item.fromSeq).toBeGreaterThanOrEqual(3);
        const atHead = await get('/diff?fromSeq=3&toSeq=3', viewer);
        expect(atHead.status).toBe(200);
        expect(atHead.json.changes).toEqual([]);
        const head = await get('/attribution', viewer);
        expect(head.status).toBe(200);
        expect(head.json.seq).toBe(3);
      },
    );

    it.skipIf(skip)(
      'applies the gate of the acting user to a fork with DEP-Actor (criterion 4)',
      async () => {
        const doc = await document();
        // No acting user: the service credential reads full history, as before.
        expect((await fork(doc, 1)).status).toBe(201);
        // A named user with no edit anywhere sees the head only.
        const refused = await fork(doc, 1, 'carol');
        expect(refused.status).toBe(403);
        expect(refused.json.code).toBe('forbidden');
        expect((await fork(doc, 3, 'carol')).status).toBe(201);

        // A grant of `editor` in a region stored for the user opens full history.
        const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
        const p = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': g.headers.get('etag')! },
          body: { grants: [{ region: LEGAL, principal: 'user:dora', role: 'editor' }] },
        });
        expect(p.status, p.text).toBe(200);
        expect((await fork(doc, 1, 'dora')).status).toBe(201);
        expect((await fork(doc, 1, 'carol')).status).toBe(403);
      },
    );
  });
}
