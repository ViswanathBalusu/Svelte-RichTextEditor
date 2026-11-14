/**
 * SEC-014 criterion 4 (U-SEC-001-016): a revocation holds after the service restarts. The
 * revocation is written to PostgreSQL by the first service process; the second process, started on
 * the same port (so the token's `aud` still matches) and the same database, must refuse the old
 * token on REST and in `hello`, and accept a token minted after the revocation.
 *
 * Runs against the shared PostgreSQL of infra/test-env.ps1 (each run creates its own database and
 * drops it). Skips with the reason when PostgreSQL does not answer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type TestDatabase,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const skip = await postgresUnavailable();

describe.skipIf(skip !== null)(
  'SEC-014 revocation survives a restart (PostgreSQL, U-SEC-001-016)',
  () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });

    it('keeps the old token refused after the service restarts, and accepts a fresh one', async () => {
      const first = await startHarness('postgres', { databaseUrl: db.url });
      const port = Number(new URL(first.base).port);
      let doc: string;
      let old: string;
      try {
        doc = await first.createDocument(first.a, documentWithRegions());
        // A host-signed token: its key is in PostgreSQL, so it verifies after the restart and the
        // refusal can only come from the stored revocation. A service-minted token would be signed
        // with a key that lives as long as the process (control-plane/tokens.ts), so after a
        // restart it fails as `unauthenticated` for that reason, not because of the revocation.
        old = first.userToken(first.a, 'ivo', { [doc]: 'editor' });
        // The watermark is to the second (05 section 3.3): the old token must be older than it.
        await sleep(1100);
        const r = await first.call('POST', '/v1/sessions/revoke', {
          token: first.a.apiKey,
          body: { sub: 'ivo' },
        });
        expect(r.status).toBe(204);
      } finally {
        await first.close();
      }

      const second = await startHarness('postgres', { databaseUrl: db.url, port });
      const probe = await WireClient.connect(second.wsUrl, { origin: first.a.origin });
      try {
        expect(Number(new URL(second.base).port)).toBe(port);

        const rest = await second.call('GET', `/v1/documents/${doc}`, { token: old });
        expect(rest.status).toBe(401);
        expect(rest.json['code']).toBe('revoked');

        const refused = await probe.hello(old);
        expect(refused.t).toBe('error');
        expect(refused.d?.['code']).toBe('revoked');

        await sleep(1100);
        const fresh = second.userToken(first.a, 'ivo', { [doc]: 'editor' });
        const restFresh = await second.call('GET', `/v1/documents/${doc}`, { token: fresh });
        expect(restFresh.status).toBe(200);
      } finally {
        probe.terminate();
        await second.close();
      }
    });
  },
);
