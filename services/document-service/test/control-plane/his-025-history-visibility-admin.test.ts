// HIS-025 criteria 5 and 6: who sees full history is set per tenant and per document through the
// administration API (13 section 10), by a service credential only, audited with the actor, and
// the next request obeys it (ADR 0034 section 2). The document's setting wins over the tenant's;
// the tenant's is the default; without either the answer is `editors`. The gate is the real one:
// a viewer reads an earlier state over HTTP, and is refused or served as the setting says.
// PostgreSQL: pwsh -NoProfile -File infra/test-env.ps1 up (FND-010); those cases skip without it.
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgParts } from '../../src/server.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';

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

async function appendOne(h: Harness, doc: string, text: string): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-025-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commit: StoredCommit = {
    seq: head.seq + 1,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
    ] as StoredCommit['steps'],
    user: 'u-test',
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
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the history visibility settings of a tenant and a document (HIS-025, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document with two commits, so that seq 1 lies below the head. */
    async function makeDoc(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'Visibility' });
      await appendOne(h, doc, 'one');
      await appendOne(h, doc, 'two');
      return doc;
    }
    /** What a viewer gets for the state at seq 1: 200 when full history is visible, else 403. */
    async function viewerReadsSeq1(doc: string): Promise<number> {
      const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
      return (await h.call('GET', `/v1/documents/${doc}/content?seq=1`, { token })).status;
    }
    async function etagOf(path: string): Promise<string> {
      const r = await h.call('GET', path, { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      return r.headers.get('etag') ?? '';
    }
    const put = (path: string, setting: unknown, etag: string) =>
      h.call('PUT', path, { token: h.apiKey, body: { setting }, headers: { 'If-Match': etag } });

    it.skipIf(skip)('offers the routes: the parts compose a settings service', () => {
      expect(h.parts.historyVisibility).toBeDefined();
    });

    it.skipIf(skip)(
      'with no setting anywhere the effective setting is editors, and a viewer sees the head only (criterion 6)',
      async () => {
        const doc = await makeDoc();
        const view = await h.call('GET', `/v1/documents/${doc}/history-visibility`, {
          token: h.apiKey,
        });
        expect(view.status, view.text).toBe(200);
        expect(view.json).toEqual({ setting: null, effective: 'editors', source: 'default' });
        expect(view.headers.get('etag')).toBe('"0"');
        expect(await viewerReadsSeq1(doc)).toBe(403);
      },
    );

    it.skipIf(skip)(
      'the document setting wins over the tenant setting, which is the default for the rest (criterion 6)',
      async () => {
        const inheriting = await makeDoc();
        const own = await makeDoc();

        // The tenant chooses `all`: a document with no setting of its own follows it.
        const tenantPath = '/v1/history-visibility';
        const read = await h.call('GET', tenantPath, { token: h.apiKey });
        expect(read.json).toEqual({ setting: 'editors' });
        const first = await put(tenantPath, 'all', await etagOf(tenantPath));
        expect(first.status, first.text).toBe(200);
        expect(first.json).toEqual({ setting: 'all' });
        const inherited = await h.call('GET', `/v1/documents/${inheriting}/history-visibility`, {
          token: h.apiKey,
        });
        expect(inherited.json).toEqual({ setting: null, effective: 'all', source: 'tenant' });
        expect(await viewerReadsSeq1(inheriting)).toBe(200);

        // One document chooses `editors`: it wins, and the other document is not touched.
        const ownPath = `/v1/documents/${own}/history-visibility`;
        const set = await put(ownPath, 'editors', await etagOf(ownPath));
        expect(set.status, set.text).toBe(200);
        expect(set.json).toEqual({ setting: 'editors', effective: 'editors', source: 'document' });
        expect(set.headers.get('etag')).toBe('"1"');
        expect(await viewerReadsSeq1(own)).toBe(403);
        expect(await viewerReadsSeq1(inheriting)).toBe(200);

        // The tenant returns to `editors`: the document with a setting of its own is unmoved by a
        // later change of the tenant, and the other one follows it.
        await put(ownPath, 'all', await etagOf(ownPath));
        await put(tenantPath, 'editors', await etagOf(tenantPath));
        expect(await viewerReadsSeq1(own)).toBe(200);
        expect(await viewerReadsSeq1(inheriting)).toBe(403);
      },
    );

    it.skipIf(skip)(
      'a change takes effect on the next request and is audited with the actor (criterion 5)',
      async () => {
        const doc = await makeDoc();
        const path = `/v1/documents/${doc}/history-visibility`;
        expect(await viewerReadsSeq1(doc)).toBe(403);
        expect((await put(path, 'all', await etagOf(path))).status).toBe(200);
        expect(await viewerReadsSeq1(doc)).toBe(200);
        expect((await put(path, 'since_access', await etagOf(path))).status).toBe(200);
        // `since_access` without the claim fails closed at the head (ADR 0034).
        expect(await viewerReadsSeq1(doc)).toBe(403);

        const events = await h.parts.audit!.query(h.tenant, {
          kind: 'history_visibility.changed',
          doc,
          limit: 10,
        });
        expect(events).toHaveLength(2);
        expect(
          events
            .map((e) => e.data)
            .sort((a, b) =>
              String((a as { setting: string }).setting).localeCompare(
                String((b as { setting: string }).setting),
              ),
            ),
        ).toEqual([
          { scope: 'document', previous: null, setting: 'all' },
          { scope: 'document', previous: 'all', setting: 'since_access' },
        ]);
        for (const e of events) expect(e.actor).toBe('system');
        const page = await h.call('GET', '/v1/audit?kind=history_visibility.changed', {
          token: h.apiKey,
        });
        expect(page.status, page.text).toBe(200);
      },
    );

    it.skipIf(skip)(
      'only a service credential may read or change a setting (criterion 5)',
      async () => {
        const doc = await makeDoc();
        const token = h.userToken({ [doc]: 'owner' }, { sub: 'u-owner' });
        for (const [method, path] of [
          ['GET', '/v1/history-visibility'],
          ['PUT', '/v1/history-visibility'],
          ['GET', `/v1/documents/${doc}/history-visibility`],
          ['PUT', `/v1/documents/${doc}/history-visibility`],
        ] as const) {
          const r = await h.call(method, path, {
            token,
            ...(method === 'PUT'
              ? { body: { setting: 'all' }, headers: { 'If-Match': '"0"' } }
              : {}),
          });
          expect(r.status, `${method} ${path}`).toBe(403);
        }
        const own = await h.call('GET', `/v1/documents/${doc}/history-visibility`, {
          token: h.apiKey,
        });
        expect(own.json).toMatchObject({ setting: null });
      },
    );

    it.skipIf(skip)(
      'refuses a stale ETag, an unknown setting, an extra field and an unknown document, and writes nothing',
      async () => {
        const doc = await makeDoc();
        const path = `/v1/documents/${doc}/history-visibility`;
        const stale = await put(path, 'all', '"7"');
        expect(stale.status, stale.text).toBe(412);
        const bad = await put(path, 'everyone', '"0"');
        expect(bad.status, bad.text).toBe(400);
        const extra = await h.call('PUT', path, {
          token: h.apiKey,
          body: { setting: 'all', also: 1 },
          headers: { 'If-Match': '"0"' },
        });
        expect(extra.status, extra.text).toBe(400);
        const missing = '0190c9d8-0000-7000-8000-000000000000';
        expect(
          (await h.call('GET', `/v1/documents/${missing}/history-visibility`, { token: h.apiKey }))
            .status,
        ).toBe(404);
        expect(
          (
            await h.call('GET', '/v1/documents/not-a-document/history-visibility', {
              token: h.apiKey,
            })
          ).status,
        ).toBe(404);
        const after = await h.call('GET', path, { token: h.apiKey });
        expect(after.json).toMatchObject({ setting: null, effective: 'editors' });
        expect(after.headers.get('etag')).toBe('"0"');
        const events = await h.parts.audit!.query(h.tenant, {
          kind: 'history_visibility.changed',
          doc,
          limit: 10,
        });
        expect(events).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'keeps the settings in the migrated table and reads them again (durable)',
      async () => {
        if (!h.db) return;
        const doc = await makeDoc();
        const path = `/v1/documents/${doc}/history-visibility`;
        expect((await put(path, 'all', await etagOf(path))).status).toBe(200);
        const stored = await h.db.admin.query<{ setting: string; version: number }>(
          `SELECT setting, version FROM history_visibility_settings
          WHERE tenant_id = $1 AND doc_id = $2`,
          [h.tenant, doc],
        );
        expect(stored.rows).toEqual([{ setting: 'all', version: 1 }]);
        const again = pgParts(h.db.service);
        const record = await again.documents.get({ tenant: h.tenant, doc });
        expect(record?.historyVisibility).toBe('all');
      },
    );
  });
}
