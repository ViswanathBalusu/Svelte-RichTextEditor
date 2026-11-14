/**
 * BE-046 criterion 1 (lane U-BE-043-056): a ready asset that no `doc_assets` row attaches is removed,
 * its object and its row, once it has settled longer ago than the retention period; an attached
 * asset is kept (BE-046 criterion 2 for the current version; the earlier versions need the persist
 * path of BE-044). Runs against PostgreSQL (migration 0064, row-level security on) and the
 * S3-compatible store of the test environment, under tenants this run creates at random.
 *
 * Skips, with the reason, when PostgreSQL or the S3-compatible store is not up
 * (infra/test-env.ps1 up).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAssetRegistry } from '../../src/control-plane/assets.ts';
import { sweepAbandonedUploads } from '../../src/control-plane/asset-sweep.ts';
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
if (unavailable) console.warn(`be-046-orphan-assets: skipped: ${unavailable}`);

const DAY = 86_400_000;

describe.skipIf(unavailable !== null)(
  'ready assets that no document attaches are removed after retention (BE-046 criterion 1, PostgreSQL and S3)',
  () => {
    const now = Date.now();
    const old = now - 10 * DAY;
    const recent = now - 60_000;
    const tenant = newTenant();
    const other = newTenant();
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
      for (const t of [tenant, other]) {
        for (const key of await objects.list(objectKeys.prefix(t))) await objects.delete(key);
      }
      await db?.drop();
    });

    /** A ready asset settled at `settledAt`, with its object written under its hash. */
    async function ready(t: string, settledAt: number, text: string) {
      const id = randomUUID();
      const doc = randomUUID();
      const bytes = new TextEncoder().encode(text);
      await assets.create(
        t,
        {
          id,
          doc,
          filename: 'image.png',
          mime: 'image/png',
          declaredBytes: bytes.length,
          createdBy: 'U-BE-043-056',
          uploadExpiresAt: now + DAY,
        },
        settledAt - 1_000,
      );
      await assets.markProcessing(t, id, randomUUID(), settledAt - 500);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const objectKey = objectKeys.asset(t, sha256);
      await new TenantObjects(objects, t).put(objectKey, bytes);
      await assets.settleReady(
        t,
        id,
        {
          sha256,
          bytes: bytes.length,
          contentType: 'image/png',
          objectKey,
          width: 1,
          height: 1,
          frames: 1,
          renditions: [],
        },
        settledAt,
      );
      return { id, doc, objectKey };
    }

    /** Attaches an asset to a document, as the persist path will (BE-044); the row is the service role's. */
    async function attach(t: string, doc: string, asset: string): Promise<void> {
      const c = await db.service.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [t]);
        await c.query(
          'INSERT INTO doc_assets (tenant_id, doc_id, asset_id, first_seq) VALUES ($1, $2, $3, 0)',
          [t, doc, asset],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    async function objectExists(t: string, key: string): Promise<boolean> {
      return new TenantObjects(objects, t).exists(key);
    }

    it('removes an unattached ready asset settled before the retention: its object and its row', async () => {
      const a = await ready(tenant, old, `orphan ${randomUUID()}`);
      expect(await objectExists(tenant, a.objectKey)).toBe(true);

      await expect(
        sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now),
      ).resolves.toBe(1);

      expect(await assets.get(tenant, a.id)).toBeNull();
      expect(await objectExists(tenant, a.objectKey)).toBe(false);
    });

    it('keeps a ready asset that a document attaches, however old', async () => {
      const a = await ready(tenant, old, `attached ${randomUUID()}`);
      await attach(tenant, a.doc, a.id);

      await sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now);

      expect((await assets.get(tenant, a.id))?.state).toBe('ready');
      expect(await objectExists(tenant, a.objectKey)).toBe(true);
    });

    it('keeps an unattached ready asset that settled inside the retention period', async () => {
      const a = await ready(tenant, recent, `fresh ${randomUUID()}`);

      await sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now);

      expect((await assets.get(tenant, a.id))?.state).toBe('ready');
      expect(await objectExists(tenant, a.objectKey)).toBe(true);
    });

    it('keeps a shared object while another asset of the tenant still names it', async () => {
      const text = `shared ${randomUUID()}`;
      const orphan = await ready(tenant, old, text);
      const kept = await ready(tenant, recent, text);
      expect(kept.objectKey).toBe(orphan.objectKey);

      await sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now);

      expect(await assets.get(tenant, orphan.id)).toBeNull();
      expect((await assets.get(tenant, kept.id))?.state).toBe('ready');
      expect(await objectExists(tenant, kept.objectKey)).toBe(true);
    });

    it('keeps orphan ready assets when no retention is set (the composition default)', async () => {
      const a = await ready(other, old, `unset ${randomUUID()}`);

      await sweepAbandonedUploads({ assets, objects }, other, now);

      expect((await assets.get(other, a.id))?.state).toBe('ready');
      expect(await objectExists(other, a.objectKey)).toBe(true);
    });

    it("does not touch another tenant's orphan", async () => {
      const a = await ready(other, old, `tenant ${randomUUID()}`);

      await sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now);

      expect((await assets.get(other, a.id))?.state).toBe('ready');
      expect(await objectExists(other, a.objectKey)).toBe(true);
    });
  },
);
