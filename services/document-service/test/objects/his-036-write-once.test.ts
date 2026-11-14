// Write-once anchoring storage (HIS-036 criterion 4): an entry written under S3 Object Lock cannot be
// overwritten or deleted before its retention ends, even with the operator's own (root) credentials.
// Run against the S3-compatible server of the test environment (Versity S3 Gateway, FND-010), in a
// bucket this test creates with a name that includes U-HIS-033-046 and removes afterwards. Test
// values only. Lane U-HIS-033-046, 2026-11-13.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { settings } from '../support/env.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';

// Bucket names are lower case: the lane name in its lower-case form.
const bucket = `docedit-u-his-033-046-worm-${randomUUID().slice(0, 8)}`;
const store = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore({
      endpoint,
      region,
      bucket: 'docedit-probe',
      accessKeyId,
      secretAccessKey,
    }).exists('probe');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip = await s3Unavailable();

describe.skipIf(skip !== null)(
  'write-once anchoring storage under Object Lock (HIS-036 criterion 4)',
  () => {
    const key = 'anchors/u-his-033-046/head-1.json';
    const original = new TextEncoder().encode('{"seq":1,"head":"first"}');
    const retainUntil = Date.now() + 4_000;

    beforeAll(async () => {
      await store.createBucket({ objectLock: true });
      await store.putRetained(key, original, retainUntil);
    });

    afterAll(async () => {
      // The object can be removed only once its retention has ended; wait for that, then remove the
      // bucket. A failure here leaves the bucket behind and is reported by the test run.
      const wait = retainUntil - Date.now() + 500;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await store.delete(key).catch(() => undefined);
      await store.deleteBucket().catch(() => undefined);
    });

    it('returns the entry as written while it is retained', async () => {
      expect(await store.get(key)).toEqual(original);
    });

    it('refuses a delete of the entry before its retention ends, even with the root credentials', async () => {
      const err = await store.delete(key).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { status?: number }).status).toBe(403);
      expect(await store.get(key)).toEqual(original);
    });

    it('refuses an overwrite of the entry before its retention ends', async () => {
      const err = await store
        .put(key, new TextEncoder().encode('{"seq":1,"head":"rewritten"}'))
        .catch((e: unknown) => e);
      expect((err as { status?: number }).status).toBe(403);
      expect(await store.get(key)).toEqual(original);
    });

    it('lets the entry be removed once its retention has ended, so the test cleans up after itself', async () => {
      const wait = retainUntil - Date.now() + 500;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
    });
  },
);
