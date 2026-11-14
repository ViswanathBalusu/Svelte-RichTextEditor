// BE-042 criterion 1 against the S3-compatible store of the test environment (FND-010), lane
// U-BE-029-042: the upload answer carries a pre-signed PUT into `tenants/{tenant}/quarantine/{asset}`
// bound to the declared size, the bytes written through that URL land under the key, and a body of
// another length is refused. Each run uses a random tenant (the harness's), so its keys are under a
// prefix of their own; the test deletes what it wrote. Skipped, with the reason, when the store is down.
import { unsandboxed } from '@docedit/asset-worker';
import { NOTHING_HIDDEN, type Visibility } from '@docedit/authority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';
import { settings } from '../support/env.ts';

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
    const store = new S3ObjectStore(s3Settings);
    await store.get('tenants/probe-u-be-029-042/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip = await s3Unavailable();
if (skip) console.warn(`be-042-s3-quarantine: skipped: ${skip}`);

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const visibility: Visibility = () => NOTHING_HIDDEN;

describe.skipIf(skip !== null)('BE-042 criterion 1 on S3 (U-BE-029-042)', () => {
  let h: Harness;
  const written: string[] = [];
  const store = new S3ObjectStore(s3Settings);

  beforeAll(async () => {
    h = await startHarness('memory', {
      views: { ...FULL_VIEWS, visibility },
      assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
      config: { s3: s3Settings, jobIdleMs: 20 },
    });
  });

  afterAll(async () => {
    for (const key of written) await store.delete(key).catch(() => undefined);
    await h?.close();
  });

  it('answers a pre-signed quarantine PUT bound to the declared size, and the bytes land at the key', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token: editor,
      body: { filename: 'dot.png', mime: 'image/png', size: PNG.length },
    });
    expect(r.status).toBe(201);
    const asset: string = r.json.asset;
    const key = `tenants/${h.tenant}/quarantine/${asset}`;
    written.push(key);

    const upload = r.json.upload as {
      url: string;
      method: string;
      headers: Record<string, string>;
    };
    expect(upload.method).toBe('PUT');
    expect(upload.headers['content-length']).toBe(String(PNG.length));
    // Path-style S3 URL: the bucket, then the key with each segment encoded.
    const url = new URL(upload.url);
    expect(url.origin).toBe(s3Settings.endpoint);
    expect(decodeURIComponent(url.pathname)).toBe(`/${s3Settings.bucket}/${key}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders') ?? '').toContain('content-length');

    const put = await fetch(upload.url, {
      method: 'PUT',
      headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
      body: PNG,
    });
    expect(put.status).toBe(200);
    const stored = await store.get(key);
    expect(stored && Buffer.from(stored).equals(PNG)).toBe(true);
  });

  it('refuses a body whose length differs from the declared size', async () => {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const editor = h.userToken({ [doc]: 'editor' });
    const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
      token: editor,
      body: { filename: 'long.png', mime: 'image/png', size: PNG.length },
    });
    expect(r.status).toBe(201);
    const key = `tenants/${h.tenant}/quarantine/${r.json.asset}`;
    const longer = Buffer.concat([PNG, Buffer.from('x')]);
    // The gateway may answer, or wait for bytes that never come; a bound of five seconds covers both.
    const put = await fetch(r.json.upload.url, {
      method: 'PUT',
      headers: { 'content-length': String(PNG.length), 'content-type': 'image/png' },
      body: longer,
      signal: AbortSignal.timeout(5000),
    }).catch((e: unknown) => e);
    if (put instanceof Response) expect(put.ok).toBe(false);
    expect(await store.get(key)).toBeNull();
  }, 20000);
});
