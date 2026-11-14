/**
 * BE-046 criterion 3 (lane U-BE-043-056): a quarantined upload that nobody completed within its
 * window is removed, its object and its row, by the scheduled task (BE-052). Runs against
 * PostgreSQL (a database of its own, RLS on) and the S3-compatible store of the test environment,
 * under tenants that this run creates at random. The objects it wrote are deleted at the end.
 *
 * Skips, with the reason, when PostgreSQL or the S3-compatible store is not up
 * (infra/test-env.ps1 up).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAssetRegistry } from '../../src/control-plane/assets.ts';
import {
  ABANDONED_UPLOADS_TASK,
  abandonedUploadsTask,
  sweepAbandonedUploads,
} from '../../src/control-plane/asset-sweep.ts';
import type { JobQueue } from '../../src/control-plane/jobs/queue.ts';
import { Scheduler } from '../../src/control-plane/scheduler.ts';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { objectKeys, TenantObjects } from '../../src/objects/store.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  settings,
  type TestDatabase,
} from '../support/env.ts';

const S = settings();
const s3Settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).get('tenants/probe-u-be-043-056/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`be-046-abandoned-uploads: skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'abandoned uploads are removed after their window (BE-046 criterion 3, PostgreSQL and S3)',
  () => {
    const now = Date.now();
    const expired = now - 60_000;
    const open = now + 3_600_000;
    const tenant = newTenant();
    const held = newTenant();
    let db: TestDatabase;
    let assets: PgAssetRegistry;
    let objects: S3ObjectStore;

    beforeAll(async () => {
      db = await createTestDatabase();
      assets = new PgAssetRegistry(db.service);
      objects = new S3ObjectStore(s3Settings);
    });

    afterAll(async () => {
      // Only this run's tenants: their prefixes hold nothing else.
      for (const t of [tenant, held]) {
        for (const key of await objects.list(objectKeys.prefix(t))) await objects.delete(key);
      }
      await db?.drop();
    });

    async function upload(t: string, uploadExpiresAt: number): Promise<string> {
      const id = randomUUID();
      await assets.create(
        t,
        {
          id,
          doc: randomUUID(),
          filename: 'upload.png',
          mime: 'image/png',
          declaredBytes: 8,
          createdBy: 'U-BE-043-056',
          uploadExpiresAt,
        },
        now - 120_000,
      );
      await new TenantObjects(objects, t).put(
        objectKeys.quarantine(t, id),
        new TextEncoder().encode(`bytes of ${id}`),
      );
      return id;
    }

    async function objectExists(t: string, id: string): Promise<boolean> {
      return new TenantObjects(objects, t).exists(objectKeys.quarantine(t, id));
    }

    it('removes an expired quarantined upload: its object and its row', async () => {
      const id = await upload(tenant, expired);
      expect(await objectExists(tenant, id)).toBe(true);

      await expect(sweepAbandonedUploads({ assets, objects }, tenant, now)).resolves.toBe(1);

      expect(await assets.get(tenant, id)).toBeNull();
      expect(await objectExists(tenant, id)).toBe(false);
    });

    it('keeps an upload that is still inside its window', async () => {
      const id = await upload(tenant, open);

      await sweepAbandonedUploads({ assets, objects }, tenant, now);

      expect((await assets.get(tenant, id))?.state).toBe('quarantined');
      expect(await objectExists(tenant, id)).toBe(true);
    });

    it('keeps an expired upload that a worker has taken', async () => {
      const id = await upload(tenant, expired);
      expect(await assets.markProcessing(tenant, id, randomUUID(), now - 1_000)).not.toBeNull();

      await sweepAbandonedUploads({ assets, objects }, tenant, now);

      expect((await assets.get(tenant, id))?.state).toBe('processing');
      expect(await objectExists(tenant, id)).toBe(true);
    });

    it('runs as the scheduled task for each tenant that is not on hold', async () => {
      const due = await upload(tenant, expired);
      const onHold = await upload(held, expired);
      const scheduler = new Scheduler({
        queue: { enqueue: async () => undefined } as unknown as JobQueue,
        tasks: [abandonedUploadsTask({ assets, objects })],
        tenants: async () => [tenant, held],
        onHold: async (t) => t === held,
        now: () => Date.now(),
      });

      const slot = Math.floor(Date.now() / 3_600_000);
      const result = (await scheduler.handler(
        {
          payload: { task: ABANDONED_UPLOADS_TASK, slot },
        } as unknown as Parameters<Scheduler['handler']>[0],
        {} as unknown as Parameters<Scheduler['handler']>[1],
      )) as { failures: number; count: number };

      expect(result.failures).toBe(0);
      expect(await assets.get(tenant, due)).toBeNull();
      expect(await objectExists(tenant, due)).toBe(false);
      expect((await assets.get(held, onHold))?.state).toBe('quarantined');
      expect(await objectExists(held, onHold)).toBe(true);
    });
  },
);
