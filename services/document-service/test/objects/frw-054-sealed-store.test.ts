// The sealed PDF store (FRW-054 criteria 1 and 2): the sealed bytes are written under the tenant
// under S3 Object Lock, an overwrite and a delete are refused while the retention lasts, and a
// store that fails leaves the workflow at `completed` through the finalisation gate. Run against the
// S3-compatible server of the test environment (Versity S3 Gateway, FND-010), in buckets this test
// creates with a name that includes U-FRW-037-054 and removes afterwards. Test values only.
// Lane U-FRW-037-054, 2026-11-13.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finaliseWorkflow, type SealResult } from '@docedit/authority';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import {
  readSealedPdf,
  sealedHash,
  sealedPdfKey,
  storeSealedPdf,
} from '../../src/objects/sealed-pdf.ts';
import { settings } from '../support/env.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';

// Bucket names are lower case: the lane name in its lower-case form.
const suffix = randomUUID().slice(0, 8);
const bucket = `docedit-u-frw-037-054-sealed-${suffix}`;
const absentBucket = `docedit-u-frw-037-054-absent-${suffix}`;
const store = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
const absentStore = new S3ObjectStore({
  endpoint,
  region,
  bucket: absentBucket,
  accessKeyId,
  secretAccessKey,
});

const tenant = randomUUID();
const doc = randomUUID();
const gateDoc = randomUUID();
const workflow = `wf-${suffix}`;
const sealed = new TextEncoder().encode('%PDF-1.7\n% U-FRW-037-054 sealed sample\n%%EOF\n');
const retainUntil = Date.now() + 4_000;

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

describe.skipIf(skip !== null)('the sealed PDF store (FRW-054 criteria 1 and 2)', () => {
  const key = sealedPdfKey(tenant, doc, workflow);

  beforeAll(async () => {
    await store.createBucket({ objectLock: true });
  });

  afterAll(async () => {
    // The sealed object can be removed only once its retention has ended; wait for that, then remove
    // the bucket. A failure here leaves the bucket behind and is reported by the test run.
    const wait = retainUntil - Date.now() + 500;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await store.delete(key).catch(() => undefined);
    await store.delete(sealedPdfKey(tenant, gateDoc, workflow)).catch(() => undefined);
    await store.deleteBucket().catch(() => undefined);
  });

  it('stores the sealed bytes under the tenant key and returns the hash of the bytes written', async () => {
    const result = await storeSealedPdf(store, tenant, doc, workflow, sealed, retainUntil);
    expect(result).toEqual({ ok: true, storedHash: sealedHash(sealed) });
    expect(key.startsWith(`tenants/${tenant}/`)).toBe(true);
    expect(await readSealedPdf(store, tenant, doc, workflow)).toEqual(sealed);
  });

  it('lets the finalisation gate raise finalised when the stored hash equals the sealed hash', async () => {
    const seal: SealResult = {
      ok: true,
      timestamped: true,
      sealedHash: sealedHash(sealed),
    };
    const stored = await storeSealedPdf(store, tenant, gateDoc, workflow, sealed, retainUntil);
    const outcome = finaliseWorkflow({ compile: { ok: true }, seal, store: stored });
    expect(outcome.status).toBe('finalised');
    expect(outcome.raised).toEqual(['completed', 'finalised']);
  });

  it('refuses an overwrite of the sealed PDF while its retention lasts, even with the root credentials', async () => {
    const err = await store
      .put(key, new TextEncoder().encode('%PDF-1.7\n% rewritten\n%%EOF\n'))
      .catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(await readSealedPdf(store, tenant, doc, workflow)).toEqual(sealed);
  });

  it('refuses a delete of the sealed PDF while its retention lasts', async () => {
    const err = await store.delete(key).catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(403);
    expect(await readSealedPdf(store, tenant, doc, workflow)).toEqual(sealed);
  });

  it('reports store_failed, and keeps the workflow at completed, when the bucket cannot take the bytes', async () => {
    const other = randomUUID();
    const stored = await storeSealedPdf(absentStore, tenant, other, workflow, sealed, retainUntil);
    expect(stored).toEqual({ ok: false, reason: 'store_failed' });
    const seal: SealResult = { ok: true, timestamped: true, sealedHash: sealedHash(sealed) };
    const outcome = finaliseWorkflow({ compile: { ok: true }, seal, store: stored });
    expect(outcome.status).toBe('completed');
    expect(outcome.raised).toEqual(['completed']);
    expect(outcome.stoppedAt).toBe('store');
    expect(outcome.alert).toBe(true);
  });

  it('refuses a second write of a different sealed PDF for the same workflow', async () => {
    const again = await storeSealedPdf(
      store,
      tenant,
      doc,
      workflow,
      new TextEncoder().encode('%PDF-1.7\n% second\n%%EOF\n'),
      retainUntil,
    );
    expect(again).toEqual({ ok: false, reason: 'store_failed' });
    expect(await readSealedPdf(store, tenant, doc, workflow)).toEqual(sealed);
  });
});
