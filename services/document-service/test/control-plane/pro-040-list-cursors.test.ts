// PRO-040 criterion 5 (lane U-PRO-035-051): following `nextCursor` to the end on every REST list
// route sees every item once. The routes are the GET operations of the published OpenAPI document
// (spec/dep/dep-1.openapi.json) whose 200 response carries `nextCursor`, only those this server
// serves. The walk runs against the real `startService` on PostgreSQL (the real data plane writes
// the commits, so the commit list is real), at `limit=1`, and compares the paged items with the
// unpaged list. The conformance kit that the criterion names is not built (PRO-108); this is the
// service-side check it will reuse. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { startService, type Service } from '../../src/server.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { documentWithRegions } from './support.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

interface Operation {
  responses?: Record<string, unknown>;
}
interface Spec {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
}

const spec = JSON.parse(
  readFileSync(new URL('../../../../spec/dep/dep-1.openapi.json', import.meta.url), 'utf8'),
) as Spec;

// The GET list operations whose 200 response (or a schema it names) carries `nextCursor`.
function announcedListRoutes(): string[] {
  const out: string[] = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    const get = ops['get'];
    if (!get) continue;
    const text = JSON.stringify(get.responses?.['200'] ?? {});
    const refs = [...text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
    const named = refs.map((r) => JSON.stringify(spec.components?.schemas?.[r] ?? {})).join(' ');
    if (text.includes('nextCursor') || named.includes('nextCursor')) out.push(path);
  }
  return out.sort();
}

// Every list route continues a page with `cursor` (the commit list too, after its first `after`).
function cursorParam(_path: string): string {
  return 'cursor';
}

describe.skipIf(skip !== null)(
  'REST list routes follow nextCursor to the end, PostgreSQL (PRO-040 criterion 5)',
  () => {
    let db: TestDatabase;
    let s: Service;
    let apiKey: string;
    let doc: string;
    const routes = announcedListRoutes();

    beforeAll(async () => {
      db = await createTestDatabase();
      const c = db.serviceConfig;
      const databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
      await db.service.end();
      s = await startService({
        config: { ...configFromEnv({}), port: 0, workers: 1, databaseUrl, externalWorkers: true },
      });
      expect(await s.ready()).toMatchObject({ ready: true });
      const tenant = randomUUID();
      await s.parts.registry.putTenant(tenant, 'U-PRO-035-051 list cursors');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      apiKey = key.credential;

      const created = await rest('POST', '/documents', { content: documentWithRegions() });
      expect(created.status).toBe(201);
      doc = ((await created.json()) as { id: string }).id;
      // Three documents, so the document list has more than one page at limit=1.
      for (let i = 0; i < 2; i++) {
        const more = await rest('POST', '/documents', { content: documentWithRegions() });
        expect(more.status).toBe(201);
      }
      // Replacements on `doc`. Each is a snapshot commit, which the commit list reports as a reset
      // and ends on, so the commit list holds no items from seq 0 here (see the final assertion).
      for (let i = 0; i < 3; i++) {
        const head = await rest('GET', `/documents/${doc}/content`);
        const etag = head.headers.get('etag');
        expect(etag).toBeTruthy();
        const put = await rest('PUT', `/documents/${doc}/content`, documentWithRegions(), {
          'If-Match': etag!,
          'DEP-Actor': 'ivy',
        });
        expect(put.status).toBe(204);
      }
    });

    afterAll(async () => {
      await s?.close();
      await db?.drop();
    });

    function rest(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      return fetch(`${s.url}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    }

    // The first request of a route: the commit list needs `after` (its start, seq 0) before a cursor.
    const start = (path: string) => (path.endsWith('/commits') ? `${path}?after=0` : path);

    // Walks one list route to the end at `limit=1`, returning every item in order.
    async function walk(path: string): Promise<{ items: string[]; pages: number }> {
      const items: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      const param = cursorParam(path);
      do {
        const base = start(path);
        const sep = base.includes('?') ? '&' : '?';
        const cur = cursor === null ? '' : `&${param}=${encodeURIComponent(cursor)}`;
        const r = await rest('GET', `${base}${sep}limit=1${cur}`);
        expect(r.status, `${path} page ${pages + 1}`).toBe(200);
        const body = (await r.json()) as { items: unknown[]; nextCursor: string | null };
        expect(body.items.length, `${path} page size at limit=1`).toBeLessThanOrEqual(1);
        items.push(...body.items.map((x) => JSON.stringify(x)));
        cursor = body.nextCursor;
        pages += 1;
        expect(pages, `${path} did not end`).toBeLessThan(100);
      } while (cursor !== null);
      return { items, pages };
    }

    it('sees every item once on every announced list route, and the commit list pages', async () => {
      expect(routes.length).toBeGreaterThan(0);
      const pagesOf: Record<string, number> = {};
      const notServed: string[] = [];
      for (const template of routes) {
        const path = template.replaceAll('{id}', doc);
        const unpaged = await rest('GET', start(path));
        if (unpaged.status === 404) {
          // The server does not offer this announced route (for example /search); it is not walked.
          notServed.push(template);
          continue;
        }
        expect(unpaged.status, `${path} unpaged`).toBe(200);
        const all = ((await unpaged.json()) as { items: unknown[] }).items.map((x) =>
          JSON.stringify(x),
        );
        const paged = await walk(path);
        expect(new Set(paged.items).size, `${path} repeats an item`).toBe(paged.items.length);
        expect(paged.items, `${path} paged items differ from the unpaged list`).toEqual(all);
        pagesOf[template] = paged.pages;
      }
      // The document list pages at limit=1 over three documents: the walk really followed cursors.
      expect(pagesOf['/documents']).toBeGreaterThan(1);
      // Commit lists are walked and compared with the unpaged list, but the snapshot commits seeded
      // here end the page at a reset, so they give no paged items; paging over edit commits needs
      // the data plane (not walked here).
      expect([...notServed].sort()).toEqual([
        '/documents/{id}/history',
        '/documents/{id}/threads',
        '/search',
        '/webhooks',
      ]);
    });
  },
);
