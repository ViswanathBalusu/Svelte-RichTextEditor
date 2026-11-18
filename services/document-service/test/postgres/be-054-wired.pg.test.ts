// BE-054 criteria 1, 2 and 3 through the composed service on PostgreSQL. With `searchIndex` on, a
// checkpoint that the real data plane writes (a content replacement over HTTP) queues the indexer
// job, the job's runner indexes its words into the tables of migration 0086, `GET /search` answers a
// service credential with its own tenant's hits and refuses a user token, and the purge of the
// deleted document removes its entries. The database is made for this file and dropped afterwards.
// Test values only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import { PgSearchIndex } from '../../src/control-plane/search-index-pg.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { inTenant } from '../../src/storage/db.ts';
import { ADMIN } from '../support/env.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

/** The sample document with its first text replaced. */
function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions()) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

describe.skipIf(skip !== null)(
  'the search index in the composed service (BE-054, PostgreSQL)',
  () => {
    let h: Harness;
    let purgePool: pg.Pool;
    let doc: string;
    const word = `zebra${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    beforeAll(async () => {
      h = await startHarness('postgres', {
        realDataPlane: true,
        config: { searchIndex: true, jobIdleMs: 50 },
      });
      purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 2 });
      purgePool.on('error', () => {});
      purgePool.on('connect', (c) => {
        void c.query('SET ROLE docedit_purge');
      });
    }, 60_000);
    afterAll(async () => {
      await purgePool?.end();
      await h?.close();
    });

    const search = (token: string, q: string) =>
      h.call('GET', `/v1/search?q=${encodeURIComponent(q)}&limit=10`, { token });

    async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
      const end = Date.now() + 20_000;
      for (;;) {
        const v = await read();
        if (done(v) || Date.now() > end) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    it('indexes a checkpoint the data plane wrote, and finds it for a service credential (criteria 1 and 2)', async () => {
      doc = await h.createDocument({ content: documentWithRegions(), title: 'BE-054' });
      const etag = (
        await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
      ).headers.get('etag');
      const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
        token: h.apiKey,
        body: edited(`the ${word} crossed the road`),
        headers: { 'If-Match': etag! },
      });
      expect(put.status, put.text).toBe(204);

      const found = await until(
        () => search(h.apiKey, word),
        (r) => (r.json.items as unknown[] | undefined)?.length === 1,
      );
      expect(found.status, found.text).toBe(200);
      const items = found.json.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(1);
      expect(items[0]!['doc']).toBe(doc);
      expect(Object.keys(items[0]!).sort()).toEqual(['doc', 'externalId', 'score', 'seq']);
      // The entries are in the tenant's rows of the new tables, under the tenant policy.
      const rows = await inTenant(h.db!.service, h.tenant, (c) =>
        c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM search_entries WHERE tenant_id = $1 AND doc_id = $2',
          [h.tenant, doc],
        ),
      );
      expect(rows.rows[0]!.n).toBe('1');
      // The words were counted in a worker thread, not inline (criterion 5).
      const stats = h.service.searchWorkers!.stats;
      expect(stats.run).toBeGreaterThan(0);
      expect(stats.inline).toBe(0);
    });

    it("returns nothing of this tenant's text to another tenant's credential, and refuses a user token (criterion 2)", async () => {
      const other = randomUUID();
      await h.parts.registry.putTenant(other, 'Other tenant');
      const key = newApiKey(other);
      await h.parts.registry.addApiKey(other, { id: key.id, secretHash: hashSecret(key.secret) });
      const none = await search(key.credential, word);
      expect(none.status, none.text).toBe(200);
      expect(none.json.items).toEqual([]);

      const user = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
      const refused = await search(user, word);
      expect(refused.status).toBe(403);
      expect(refused.json.code).toBe('forbidden');
    });

    it('removes the entries when the deleted document is purged (criterion 3)', async () => {
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
      expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);
      const purge = new DocumentPurge({
        store: new PgPurgeStore(purgePool),
        objects: h.parts.objects,
        audit: h.parts.audit!,
        search: new PgSearchIndex(h.db!.service),
        retentionMs: 30 * DAY_MS,
        now: () => Date.now(),
      });
      const run = await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS);
      expect(run.purged).toEqual([doc]);
      const rows = await inTenant(h.db!.service, h.tenant, (c) =>
        c.query<{ n: string }>(
          `SELECT (SELECT count(*) FROM search_entries WHERE doc_id = $1)::text AS n,
                (SELECT count(*) FROM search_tokens WHERE doc_id = $1)::text AS t`,
          [doc],
        ),
      );
      expect(rows.rows[0]).toMatchObject({ n: '0', t: '0' });
      const after = await search(h.apiKey, word);
      expect(after.json.items).toEqual([]);
    });
  },
);
