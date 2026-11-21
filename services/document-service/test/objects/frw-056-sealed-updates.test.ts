// The updates of a sealed PDF (FRW-056 criterion 3) in the write-once object store: the sealed
// object stays byte for byte, each update is a further object that begins with the latest bytes,
// the newest is found by its number, and neither the sealed object nor an update can be overwritten
// or deleted while the retention lasts. Versity S3 Gateway of the test environment (FND-010), in a
// bucket this test creates and removes. Test values only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { sealedHash, storeSealedPdf } from '../../src/objects/sealed-pdf.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { Pool } from '../../src/storage/db.ts';
import { ObjectSealedPdfStore } from '../../src/workflow/sealed-store.ts';
import { settings } from '../support/env.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';
const suffix = randomUUID().slice(0, 8);
const bucket = `docedit-frw-056-updates-${suffix}`;
const objects = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
// The update path reads and writes objects only; the record table is not touched here.
const store = new ObjectSealedPdfStore(null as unknown as Pool, objects);

const tenant = randomUUID();
const doc = randomUUID();
const workflow = `wf-${suffix}`;
const enc = new TextEncoder();
const original = enc.encode('%PDF-1.7\n% sealed\n%%EOF\n');
const grow = (base: Uint8Array, tag: string) =>
  Uint8Array.from([...base, ...enc.encode(`% ${tag}\n`)]);
const retainUntilMs = Date.now() + 5_000;
const keys: string[] = [];

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
  'updates of a sealed PDF in the write-once store (FRW-056 criterion 3)',
  () => {
    beforeAll(async () => {
      await objects.createBucket({ objectLock: true });
      expect(
        await storeSealedPdf(objects, tenant, doc, workflow, original, retainUntilMs),
      ).toMatchObject({
        ok: true,
      });
      keys.push(objectKeys.final(tenant, doc, workflow));
    });
    afterAll(async () => {
      const wait = retainUntilMs - Date.now() + 500;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      for (const k of keys) await objects.delete(k).catch(() => undefined);
      await objects.deleteBucket().catch(() => undefined);
    }, 60_000);

    const update = (bytes: Uint8Array, basedOn: Uint8Array) =>
      store.storeUpdate({
        tenant,
        docId: doc,
        workflowId: workflow,
        bytes,
        basedOnHash: sealedHash(basedOn),
        retainUntilMs,
      });

    it('has the sealed object as the latest until there is an update', async () => {
      const latest = await store.readLatest(tenant, doc, workflow);
      expect(latest).toMatchObject({ n: 0, hash: sealedHash(original) });
    });

    it('stores an update as a further object that begins with the sealed bytes', async () => {
      const u1 = grow(original, 'update 1');
      expect(await update(u1, original)).toEqual({
        ok: true,
        n: 1,
        hash: sealedHash(u1),
        existing: false,
      });
      keys.push(objectKeys.finalUpdate(tenant, doc, workflow, 1));
      const latest = (await store.readLatest(tenant, doc, workflow))!;
      expect(latest).toMatchObject({ n: 1, hash: sealedHash(u1) });
      expect(
        Buffer.from(latest.bytes.subarray(0, original.length)).equals(Buffer.from(original)),
      ).toBe(true);
      // The sealed object is as it was.
      expect(
        Buffer.from((await objects.get(objectKeys.final(tenant, doc, workflow)))!).equals(
          Buffer.from(original),
        ),
      ).toBe(true);
    });

    it('takes the same update again as a no-op, and refuses a stale base and a file that is not an append', async () => {
      const u1 = grow(original, 'update 1');
      expect(await update(u1, original)).toMatchObject({ ok: true, n: 1, existing: true });
      expect(await update(grow(original, 'another'), original)).toEqual({
        ok: false,
        reason: 'stale',
      });
      expect(await update(enc.encode('%PDF-1.7\n% different\n%%EOF\n'), u1)).toEqual({
        ok: false,
        reason: 'not_an_append',
      });
      expect((await store.readLatest(tenant, doc, workflow))!.n).toBe(1);
    });

    it('finds the newest by number, not by name: update 10 is after update 9', async () => {
      let prev = grow(original, 'update 1');
      for (let n = 2; n <= 10; n++) {
        const next = grow(prev, `update ${n}`);
        expect(await update(next, prev)).toMatchObject({ ok: true, n });
        keys.push(objectKeys.finalUpdate(tenant, doc, workflow, n));
        prev = next;
      }
      expect(await store.readLatest(tenant, doc, workflow)).toMatchObject({
        n: 10,
        hash: sealedHash(prev),
      });
    }, 60_000);

    it('refuses an overwrite and a delete of the sealed object and of an update while the retention lasts', async () => {
      for (const key of [
        objectKeys.final(tenant, doc, workflow),
        objectKeys.finalUpdate(tenant, doc, workflow, 1),
      ]) {
        const over = await objects.put(key, enc.encode('x')).catch((e: unknown) => e);
        expect((over as { status?: number }).status).toBe(403);
        const del = await objects.delete(key).catch((e: unknown) => e);
        expect((del as { status?: number }).status).toBe(403);
      }
    });

    it('reports a workflow with nothing stored as not sealed', async () => {
      expect(
        await store.storeUpdate({
          tenant,
          docId: doc,
          workflowId: 'other',
          bytes: original,
          basedOnHash: sealedHash(original),
          retainUntilMs,
        }),
      ).toEqual({ ok: false, reason: 'not_sealed' });
    });
  },
);
