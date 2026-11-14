// BE-002 criterion 5 (lane U-BE-001-014): one adapter is replaced through configuration when the
// service starts, with no change to room or control-plane code. The object store is the adapter
// replaced here: with DOCEDIT_S3_* settings the composition takes the S3-compatible store of the
// test environment (Versity S3 Gateway), without them it takes the in-memory one. The log and the
// registry stay on PostgreSQL in both runs. The test starts the real `startService` from
// `configFromEnv`, writes an object through the service's own store, and reads it back with a
// separate S3 client, which proves the bytes reached the gateway and not process memory.
// Skipped when PostgreSQL or the S3 gateway is not up (infra/test-env.ps1 up).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { MemoryObjectStore } from '../../src/objects/store.ts';
import { PgLogStore } from '../../src/storage/log-store.ts';
import { startService, type Service } from '../../src/server.ts';
import {
  createTestDatabase,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';

const S = settings();

async function s3Unavailable(): Promise<string | null> {
  const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    return null;
  } catch (e) {
    return `the S3 gateway is not reachable at ${endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip = (await postgresUnavailable()) ?? (await s3Unavailable());

describe.skipIf(skip !== null)(
  'the object store is replaced through configuration (BE-002 criterion 5)',
  () => {
    let db: TestDatabase;
    const started: Service[] = [];
    const written: string[] = [];
    let s3Cleanup: S3ObjectStore | null = null;

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      for (const s of started) await s.close().catch(() => undefined);
      // Remove only the probe objects this file wrote.
      for (const key of written) await s3Cleanup?.delete(key).catch(() => undefined);
      await db?.drop();
    });

    // The service role's connection string, as the service would read it from DOCEDIT_DATABASE_URL.
    const databaseUrl = (): string => {
      const c = db.serviceConfig;
      return `postgres://${encodeURIComponent(String(c.user))}:${encodeURIComponent(String(c.password))}@${c.host}:${c.port}/${c.database}`;
    };

    const base = {
      DOCEDIT_LISTEN_HOST: '127.0.0.1',
      DOCEDIT_LISTEN_PORT: '0',
      DOCEDIT_ENVIRONMENT: 'test',
    };

    it('with S3 settings the service writes objects to the S3 gateway', async () => {
      const config = configFromEnv({
        ...base,
        DOCEDIT_DATABASE_URL: databaseUrl(),
        DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'],
        DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'],
        DOCEDIT_S3_REGION: S['DOCEDIT_S3_REGION'],
        DOCEDIT_S3_BUCKET: S['DOCEDIT_S3_BUCKET'],
        DOCEDIT_S3_ACCESS_KEY: S['DOCEDIT_S3_ACCESS_KEY'],
        DOCEDIT_S3_SECRET_KEY: S['DOCEDIT_S3_SECRET_KEY'],
      });
      const service = await startService({ config });
      started.push(service);

      expect(service.parts.logs).toBeInstanceOf(PgLogStore);
      expect(service.parts.objects).toBeInstanceOf(S3ObjectStore);

      // A key under a tenant prefix unique to this run (U-BE-001-014), so nothing else is touched.
      const tenant = `u-be-001-014-${randomUUID()}`;
      const key = `tenants/${tenant}/quarantine/probe-${randomUUID()}`;
      const body = new TextEncoder().encode(`u-be-001-014 probe ${randomUUID()}`);
      await service.parts.objects.put(key, body);
      written.push(key);

      // A separate client of the same gateway reads the object back: it reached the gateway.
      const reader = new S3ObjectStore(config.s3!);
      s3Cleanup = reader;
      expect(await reader.get(key)).toEqual(body);
    });

    it('without S3 settings the same composition keeps objects in memory and the log on PostgreSQL', async () => {
      const config = configFromEnv({ ...base, DOCEDIT_DATABASE_URL: databaseUrl() });
      expect(config.s3).toBeNull();
      const service = await startService({ config });
      started.push(service);

      expect(service.parts.logs).toBeInstanceOf(PgLogStore);
      expect(service.parts.objects).toBeInstanceOf(MemoryObjectStore);
    });
  },
);
