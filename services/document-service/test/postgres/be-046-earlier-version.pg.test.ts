/**
 * BE-046 criterion 2 (lane U-BE-043-056, round 9): an asset attached to a document only in an
 * earlier version is kept when the orphan sweep runs, past the retention period. The attachment is
 * the `doc_assets` row (migration 0064): rows are never deleted while the asset exists, so a row
 * whose `first_seq` is an earlier sequence keeps the asset whatever the current content names.
 *
 * The row is written here by the test, as the persist path of BE-044 will write it (BE-044
 * criterion 1 is still open); the sweep itself reads only the rows, never the content.
 *
 * Runs against PostgreSQL (migration 0064, row-level security on) and the S3-compatible store of
 * the Podman test environment, under tenants this run creates at random. Skips, with the reason,
 * when either is not up (infra/test-env.ps1 up).
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
if (unavailable) console.warn(`be-046-earlier-version: skipped: ${unavailable}`);

const DAY = 86_400_000;

describe.skipIf(unavailable !== null)(
  'an asset attached only in an earlier version is kept (BE-046 criterion 2, PostgreSQL and S3)',
  () => {
    const now = Date.now();
    const old = now - 10 * DAY;
    const tenant = newTenant();
    let db: TestDatabase;
    let assets: PgAssetRegistry;
    let objects: S3ObjectStore;

    beforeAll(async () => {
      db = await createTestDatabase();
      assets = new PgAssetRegistry(db.service);
      objects = new S3ObjectStore(s3Settings);
    });

    afterAll(async () => {
      for (const key of await objects.list(objectKeys.prefix(tenant))) await objects.delete(key);
      await db?.drop();
    });

    /** A ready asset settled long before the retention period, with its object under its hash. */
    async function readyOld(text: string) {
      const id = randomUUID();
      const doc = randomUUID();
      const bytes = new TextEncoder().encode(text);
      await assets.create(
        tenant,
        {
          id,
          doc,
          filename: 'image.png',
          mime: 'image/png',
          declaredBytes: bytes.length,
          createdBy: 'U-BE-043-056',
          uploadExpiresAt: now + DAY,
        },
        old - 1_000,
      );
      await assets.markProcessing(tenant, id, randomUUID(), old - 500);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const objectKey = objectKeys.asset(tenant, sha256);
      await new TenantObjects(objects, tenant).put(objectKey, bytes);
      await assets.settleReady(
        tenant,
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
        old,
      );
      return { id, doc, objectKey };
    }

    /** A `doc_assets` row attaching `asset` to `doc` from `firstSeq` (the service role's write). */
    async function attachFrom(doc: string, asset: string, firstSeq: number): Promise<void> {
      const c = await db.service.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [tenant]);
        await c.query(
          'INSERT INTO doc_assets (tenant_id, doc_id, asset_id, first_seq) VALUES ($1, $2, $3, $4)',
          [tenant, doc, asset, firstSeq],
        );
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    async function attachmentRows(asset: string): Promise<number> {
      const c = await db.service.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [tenant]);
        const r = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM doc_assets WHERE tenant_id = $1 AND asset_id = $2',
          [tenant, asset],
        );
        await c.query('COMMIT');
        return Number(r.rows[0]?.n ?? 0);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    }

    it('keeps an asset whose only attachment is an earlier version (first_seq below the head)', async () => {
      const a = await readyOld(`earlier ${randomUUID()}`);
      // Attached from sequence 2; the document's head has moved on, so its current content may no
      // longer name the image. The sweep reads only the attachment rows, so the asset stays.
      await attachFrom(a.doc, a.id, 2);
      expect(await attachmentRows(a.id)).toBe(1);

      await expect(
        sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now),
      ).resolves.toBe(0);

      expect((await assets.get(tenant, a.id))?.state).toBe('ready');
      expect(await new TenantObjects(objects, tenant).exists(a.objectKey)).toBe(true);
      expect(await attachmentRows(a.id)).toBe(1);
    });

    it('keeps an asset attached from an earlier sequence to a second document, and removes none of its rows', async () => {
      const a = await readyOld(`second ${randomUUID()}`);
      const later = randomUUID();
      await attachFrom(a.doc, a.id, 1);
      await attachFrom(later, a.id, 7);

      await sweepAbandonedUploads({ assets, objects, orphanRetentionMs: DAY }, tenant, now);

      expect((await assets.get(tenant, a.id))?.state).toBe('ready');
      expect(await new TenantObjects(objects, tenant).exists(a.objectKey)).toBe(true);
      expect(await attachmentRows(a.id)).toBe(2);
    });
  },
);
