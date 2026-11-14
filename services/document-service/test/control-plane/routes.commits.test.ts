// The paged commit log over real HTTP (05 §6.2; BE-038 is the data plane's paging, BE-098 the
// projection rule; PRM-041 criterion 3; HIS-024; D141), in memory and with PostgreSQL. The stub
// data plane of the harness offers no `readCommits` first, so user reads come from storage here;
// one test then gives it a page function and checks that user reads go through it.
import { NOTHING_HIDDEN, type StoredCommit, type Visibility } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';
const INTRO = 'pIntro0000000001';

/** The legal region is hidden from everyone but owners and its grantees (as in routes.content). */
const visibility: Visibility = (conn, _doc, perms) =>
  conn.role === 'owner' ||
  perms.grants.some((g) => g.region === LEGAL && g.principal === `user:${conn.sub}`)
    ? NOTHING_HIDDEN
    : { regions: new Set([LEGAL]), values: new Set(), titles: false };

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

async function append(h: Harness, doc: string, user: string, texts: string[]): Promise<number> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
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
    user,
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
  return head.seq + texts.length;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`GET /documents/{id}/commits (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { views: { ...FULL_VIEWS, visibility } });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'pages the log after `after` in ascending seq with a cursor, showing authors by sub (BE-038 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        const ann = (await h.parts.users.resolve(h.tenant, 'ann')).surrogate;
        await append(h, doc, ann, ['a', 'b', 'c', 'd', 'e']);
        const page = await h.call('GET', `/v1/documents/${doc}/commits?after=1&limit=2`, {
          token: h.apiKey,
        });
        expect(page.status).toBe(200);
        expect(page.headers.get('cache-control')).toBe('private, no-cache');
        expect(page.json.items.map((c: { seq: number }) => c.seq)).toEqual([2, 3]);
        expect(page.json.items[0]).toMatchObject({
          kind: 'steps',
          control: null,
          origin: 'input',
          author: { user: 'ann', session: 'session-test', agent: null },
        });
        expect(page.json).toMatchObject({ head: 5, view: expect.any(String) });
        const next = await h.call(
          'GET',
          `/v1/documents/${doc}/commits?limit=2&cursor=${encodeURIComponent(page.json.nextCursor)}`,
          { token: h.apiKey },
        );
        expect(next.json.items.map((c: { seq: number }) => c.seq)).toEqual([4, 5]);
        expect(next.json.nextCursor).toBeNull();
        const atHead = await h.call('GET', `/v1/documents/${doc}/commits?after=5`, {
          token: h.apiKey,
        });
        expect(atHead.json).toMatchObject({ items: [], nextCursor: null, head: 5 });
        for (const bad of ['', '?after=6', '?after=-1', '?after=0&limit=201', '?cursor=forged'])
          expect(
            (await h.call('GET', `/v1/documents/${doc}/commits${bad}`, { token: h.apiKey })).json
              .code,
            bad,
          ).toBe('validation_failed');
      },
    );

    it.skipIf(skip)(
      'refuses `after` below the history gate and returns nothing below it (PRM-041 criterion 3; HIS-024)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, 'u-test', ['a', 'b']);
        // Owners see full history; under the default `editors` a viewer sees the head only.
        const owner = h.userToken({ [doc]: 'owner' });
        expect(
          (await h.call('GET', `/v1/documents/${doc}/commits?after=0`, { token: owner })).json
            .items,
        ).toHaveLength(2);
        // A grant on the legal region puts alice in the full class; she is still only a viewer.
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.apiKey });
        await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.apiKey,
          headers: { 'If-Match': grants.headers.get('etag')! },
          body: { grants: [{ region: LEGAL, principal: 'user:alice', role: 'viewer' }] },
        });
        const viewer = h.userToken({ [doc]: 'viewer' });
        const below = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, {
          token: viewer,
        });
        expect(below.status).toBe(403);
        expect(below.json.code).toBe('forbidden');
        expect(below.text).not.toContain('"seq"');
        // The control commit of the grant is the head now: from there the viewer may page.
        const head = (await h.parts.logs.head({ tenant: h.tenant, doc })).seq;
        const fromHead = await h.call('GET', `/v1/documents/${doc}/commits?after=${head}`, {
          token: viewer,
        });
        expect(fromHead.status).toBe(200);
        // A token that does not cover the document is refused before anything is read.
        const other = await h.createDocument({});
        expect(
          (
            await h.call('GET', `/v1/documents/${doc}/commits?after=${head}`, {
              token: h.userToken({ [other]: 'owner' }),
            })
          ).status,
        ).toBe(403);
      },
    );

    it.skipIf(skip)(
      'serves no page to a reader whose class hides content: such a reader reloads (ADR 0019; BE-098 criterion 1)',
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, 'u-test', ['a']);
        const editor = h.userToken({ [doc]: 'editor' });
        const r = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, { token: editor });
        expect(r.status).toBe(503);
        expect(r.json.code).toBe('unavailable');
        expect(r.text).not.toContain('Liability');
        const owner = h.userToken({ [doc]: 'owner' });
        const full = await h.call('GET', `/v1/documents/${doc}/commits?after=0`, { token: owner });
        expect(full.status).toBe(200);
        const content = await h.call('GET', `/v1/documents/${doc}/content`, { token: owner });
        // The page carries the view token of the full class, which the content read names too.
        expect(full.json.view).toBe(content.json.view);
      },
    );

    it.skipIf(skip)(
      "routes a user's read through the data plane's page when it offers one (seams readCommits)",
      async () => {
        const doc = await h.createDocument({ content: documentWithRegions() });
        await append(h, doc, 'u-test', ['a', 'b']);
        const calls: Array<{ after: number; limit: number }> = [];
        h.stub.readCommits = async (_identity, _doc, after, limit) => {
          calls.push({ after, limit });
          return { items: [], next: after + 1, head: 2, incarnation: 'i' };
        };
        try {
          const r = await h.call('GET', `/v1/documents/${doc}/commits?after=0&limit=7`, {
            token: h.userToken({ [doc]: 'owner' }),
          });
          expect(r.status).toBe(200);
          expect(calls).toEqual([{ after: 0, limit: 7 }]);
          const next = await h.call(
            'GET',
            `/v1/documents/${doc}/commits?cursor=${encodeURIComponent(r.json.nextCursor)}`,
            { token: h.userToken({ [doc]: 'owner' }) },
          );
          expect(next.status).toBe(200);
          expect(calls[1]!.after).toBe(1);
        } finally {
          delete h.stub.readCommits;
        }
      },
    );
  });
}
