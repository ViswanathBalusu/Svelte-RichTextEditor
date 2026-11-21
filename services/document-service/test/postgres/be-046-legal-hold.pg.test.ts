/**
 * BE-046 criterion 4 (lane U-BE-043-056): the assets of a document under legal hold are kept by the
 * asset sweep, both the orphan ready assets and the expired uploads, while the assets of documents
 * that no hold covers are removed as before. A hold of one tenant does not keep another tenant's
 * assets. Runs against PostgreSQL (the hold table of holds-pg.ts, the asset registry of migration
 * 0064, row-level security on) and the S3-compatible store of the test environment, under tenants
 * this run creates at random.
 *
 * Skips, with the reason, when PostgreSQL or the S3-compatible store is not up
 * (infra/test-env.ps1 up).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAssetRegistry } from '../../src/control-plane/assets-pg.ts';
import { sweepAbandonedUploads } from '../../src/control-plane/asset-sweep.ts';
import { HoldService, type HoldServiceDeps } from '../../src/control-plane/holds.ts';
import { PgHoldStore } from '../../src/control-plane/holds-pg.ts';
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
if (unavailable) console.warn(`be-046-legal-hold: skipped: ${unavailable}`);

const DAY = 86_400_000;

describe.skipIf(unavailable !== null)(
  'assets of a document under legal hold are kept by the sweep (BE-046 criterion 4, PostgreSQL and S3)',
  () => {
    const now = Date.now();
    const old = now - 10 * DAY;
    const tenant = newTenant();
    const other = newTenant();
    let db: TestDatabase;
    let assets: PgAssetRegistry;
    let objects: S3ObjectStore;
    let store: PgHoldStore;
    let holds: HoldService;

    beforeAll(async () => {
      db = await createTestDatabase();
      assets = new PgAssetRegistry(db.service);
      objects = new S3ObjectStore(s3Settings);
      store = new PgHoldStore(db.service);
      holds = new HoldService({
        store,
        audit: { record: async () => [] } as unknown as HoldServiceDeps['audit'],
        documentExists: async () => true,
        now: () => now,
      });
    });

    afterAll(async () => {
      for (const t of [tenant, other]) {
        for (const key of await objects.list(objectKeys.prefix(t))) await objects.delete(key);
      }
      await db?.drop();
    });

    /** A ready asset of `doc` settled at `settledAt`, with its object written under its hash. */
    async function ready(t: string, doc: string, settledAt: number, text: string) {
      const id = randomUUID();
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

    /** An upload nobody completed, whose window ended long ago. */
    async function expiredUpload(t: string, doc: string): Promise<{ id: string; doc: string }> {
      const id = randomUUID();
      await assets.create(
        t,
        {
          id,
          doc,
          filename: 'late.png',
          mime: 'image/png',
          declaredBytes: 4,
          createdBy: 'U-BE-043-056',
          uploadExpiresAt: old,
        },
        old - DAY,
      );
      return { id, doc };
    }

    async function hold(t: string, doc: string): Promise<void> {
      await store.add({
        id: randomUUID(),
        tenant: t,
        document: doc,
        reason: 'legal hold for BE-046 criterion 4',
        placedBy: 'U-BE-043-056',
        placedAt: now - DAY,
      });
    }

    async function objectExists(t: string, key: string): Promise<boolean> {
      return new TenantObjects(objects, t).exists(key);
    }

    it('reads the documents a hold covers, for the tenant only', async () => {
      const held = randomUUID();
      await hold(tenant, held);
      expect((await holds.heldDocuments(tenant)).has(held)).toBe(true);
      expect((await holds.heldDocuments(other)).has(held)).toBe(false);
    });

    it('keeps an orphan ready asset of a held document, and removes one of a document no hold covers', async () => {
      const heldDoc = randomUUID();
      await hold(tenant, heldDoc);
      const kept = await ready(tenant, heldDoc, old, `held ${randomUUID()}`);
      const gone = await ready(tenant, randomUUID(), old, `free ${randomUUID()}`);

      await expect(
        sweepAbandonedUploads(
          { assets, objects, orphanRetentionMs: DAY, heldDocuments: (t) => holds.heldDocuments(t) },
          tenant,
          now,
        ),
      ).resolves.toBe(1);

      expect(await assets.get(tenant, kept.id)).not.toBeNull();
      expect(await objectExists(tenant, kept.objectKey)).toBe(true);
      expect(await assets.get(tenant, gone.id)).toBeNull();
      expect(await objectExists(tenant, gone.objectKey)).toBe(false);
    });

    it('keeps an expired upload of a held document, and removes an expired upload of a free one', async () => {
      const heldDoc = randomUUID();
      await hold(tenant, heldDoc);
      const kept = await expiredUpload(tenant, heldDoc);
      const gone = await expiredUpload(tenant, randomUUID());

      await expect(
        sweepAbandonedUploads(
          { assets, objects, batch: 500, heldDocuments: (t) => holds.heldDocuments(t) },
          tenant,
          now,
        ),
      ).resolves.toBe(1);

      expect(await assets.get(tenant, kept.id)).not.toBeNull();
      expect(await assets.get(tenant, gone.id)).toBeNull();
    });

    it("does not let another tenant's hold keep an asset", async () => {
      const doc = randomUUID();
      await hold(other, doc);
      const a = await ready(tenant, doc, old, `cross ${randomUUID()}`);

      await expect(
        sweepAbandonedUploads(
          { assets, objects, orphanRetentionMs: DAY, heldDocuments: (t) => holds.heldDocuments(t) },
          tenant,
          now,
        ),
      ).resolves.toBe(1);

      expect(await assets.get(tenant, a.id)).toBeNull();
    });
  },
);
