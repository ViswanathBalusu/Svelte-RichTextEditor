// PRO-050 criterion 1 end to end (lane U-PRO-035-051): `PUT /v1/documents/{id}/content` with a
// service credential and a current `If-Match` stores a snapshot commit with origin `import` in
// PostgreSQL. This is the whole route: the real `startService` on PostgreSQL, the real data plane
// behind it, and the commit row read back with the database's own admin pool. The database is one
// this file creates (migrated, dropped at the end). Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { startService, type Service } from '../../src/server.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';
import { documentWithRegions } from './support.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

interface CommitRow {
  seq: string;
  kind: string;
  origin: string;
  user_id: string;
}

describe.skipIf(skip !== null)(
  'PUT /documents/{id}/content stores an import snapshot (PRO-050 criterion 1)',
  () => {
    let db: TestDatabase;
    let s: Service;
    let apiKey: string;

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
      await s.parts.registry.putTenant(tenant, 'U-PRO-035-051 import route');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      apiKey = key.credential;
    });

    afterAll(async () => {
      await s?.close();
      await db?.drop();
    });

    const rest = (
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(`${s.url}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    it('stores the replacement as a snapshot commit with origin import, in PostgreSQL', async () => {
      const created = await rest('POST', '/documents', { content: documentWithRegions() });
      expect(created.status).toBe(201);
      const doc = ((await created.json()) as { id: string }).id;

      const head = await rest('GET', `/documents/${doc}/content`);
      expect(head.status).toBe(200);
      const etag = head.headers.get('etag');
      expect(etag).toBeTruthy();

      const put = await rest('PUT', `/documents/${doc}/content`, documentWithRegions(), {
        'If-Match': etag!,
        'DEP-Actor': 'ivy',
      });
      expect(put.status).toBe(204);

      const rows = (
        await db.admin.query<CommitRow>(
          `SELECT seq, kind, origin, user_id FROM doc_commits
          WHERE doc_id = $1 AND origin = 'import' ORDER BY seq`,
          [doc],
        )
      ).rows;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.at(-1)).toMatchObject({ kind: 'snapshot', origin: 'import' });
    });
  },
);
