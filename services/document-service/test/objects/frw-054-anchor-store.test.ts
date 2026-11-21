// The signed, time-stamped chain head file (FRW-054 criterion 3): written under the tenant under S3
// Object Lock, a second store of the same record is a no-op, another record for the workflow is
// refused, and an overwrite and a delete are refused while the retention lasts. Run against the
// S3-compatible server of the test environment (Versity S3 Gateway, FND-010), in a bucket this test
// creates with a name that includes frw-054-anchor and removes afterwards. Test values only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { objectKeys } from '../../src/objects/store.ts';
import {
  ANCHOR_FILE_FORMAT,
  anchorFileBytes,
  ObjectAnchorStore,
  type AnchorFile,
} from '../../src/workflow/anchor-store.ts';
import { settings } from '../support/env.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';

const suffix = randomUUID().slice(0, 8);
const bucket = `docedit-frw-054-anchor-${suffix}`;
const objects = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });
const anchors = new ObjectAnchorStore(objects);

const tenant = randomUUID();
const doc = randomUUID();
const workflow = `wf-${suffix}`;
const file = (record: string): AnchorFile => ({
  format: ANCHOR_FILE_FORMAT,
  record,
  recordSha256: 'ab'.repeat(32),
  cms: Buffer.from('not a real signature, a test value').toString('base64'),
  timestampTime: '2026-11-18T10:00:00.000Z',
  keyId: 'operator-key',
});
const retainUntilMs = Date.now() + 4_000;

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

describe.skipIf(skip !== null)('the chain head anchor file (FRW-054 criterion 3)', () => {
  const key = objectKeys.anchor(tenant, doc, workflow);

  beforeAll(async () => {
    await objects.createBucket({ objectLock: true });
  });
  afterAll(async () => {
    const wait = retainUntilMs - Date.now() + 500;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await objects.delete(key).catch(() => undefined);
    await objects.deleteBucket().catch(() => undefined);
  });

  it('writes the file under the tenant and reads it back', async () => {
    expect(key.startsWith(`tenants/${tenant}/`)).toBe(true);
    const out = await anchors.store({
      tenant,
      doc,
      workflow,
      file: file('{"a":1}'),
      retainUntilMs,
    });
    expect(out).toEqual({ ok: true, existing: false });
    expect(await anchors.read(tenant, doc, workflow)).toEqual(file('{"a":1}'));
    expect(
      Buffer.from((await objects.get(key))!).equals(Buffer.from(anchorFileBytes(file('{"a":1}')))),
    ).toBe(true);
  });

  it('stores the same record again as a no-op and refuses another record for the workflow', async () => {
    expect(
      await anchors.store({ tenant, doc, workflow, file: file('{"a":1}'), retainUntilMs }),
    ).toEqual({ ok: true, existing: true });
    expect(
      await anchors.store({ tenant, doc, workflow, file: file('{"a":2}'), retainUntilMs }),
    ).toEqual({ ok: false, reason: 'different_record' });
    expect(await anchors.read(tenant, doc, workflow)).toEqual(file('{"a":1}'));
  });

  it('refuses an overwrite and a delete while the retention lasts, with the root credentials', async () => {
    const over = await objects.put(key, new TextEncoder().encode('{}')).catch((e: unknown) => e);
    expect((over as { status?: number }).status).toBe(403);
    const del = await objects.delete(key).catch((e: unknown) => e);
    expect((del as { status?: number }).status).toBe(403);
    expect(await anchors.read(tenant, doc, workflow)).toEqual(file('{"a":1}'));
  });

  it('reports a store that cannot be written as store_failed', async () => {
    const absent = new ObjectAnchorStore(
      new S3ObjectStore({
        endpoint,
        region,
        bucket: `docedit-frw-054-absent-${suffix}`,
        accessKeyId,
        secretAccessKey,
      }),
    );
    expect(
      await absent.store({ tenant, doc, workflow, file: file('{"a":1}'), retainUntilMs }),
    ).toEqual({ ok: false, reason: 'store_failed' });
  });
});
