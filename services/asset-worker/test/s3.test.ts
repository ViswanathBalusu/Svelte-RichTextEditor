/**
 * The asset worker against the S3-compatible store of the test environment (Versity S3 Gateway,
 * FND-010; infra/test-env.ps1): the size-bound pre-signed upload into quarantine (BE-042
 * criterion 3), the whole job from quarantine to `tenants/{tenant}/assets/{sha256}` (BE-043
 * criteria 2, 3, 7; SEC-037 criteria 1 and 2), and the asset origin reading from the store
 * (BE-045 criteria 2 to 5). The content checks run unsandboxed here; sandbox.podman.test.ts runs
 * them in Podman. Skips, with the reason, when the store is not up
 * (`pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetKeys } from '../src/keys.ts';
import { ObjectTooLarge } from '../src/objects.ts';
import { startAssetOrigin, type RunningOrigin } from '../src/origin.ts';
import { S3AssetObjects, type S3Settings } from '../src/s3.ts';
import { unsandboxed } from '../src/sandbox-port.ts';
import { JPEG, PNG } from '../src/sandbox/types.ts';
import { assetUrlExpiry, signAssetUrl } from '../src/signing.ts';
import { presignQuarantineUpload } from '../src/upload.ts';
import { createAssetWorker, type AssetFailed, type AssetReady } from '../src/worker.ts';
import { concat, enc, jpegOf, png } from './fixtures.ts';

const CONTAINERS = fileURLToPath(new URL('../../../infra/containers/', import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const S: Record<string, string> = {
  ...readEnvFile(`${CONTAINERS}.env.example`),
  ...readEnvFile(`${CONTAINERS}.env`),
};
for (const k of Object.keys(S)) if (process.env[k]) S[k] = process.env[k]!;

const settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function unavailable(): Promise<string | null> {
  try {
    await new S3AssetObjects(settings).head(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up -NoExport`;
  }
}

const skip = await unavailable();
const store = new S3AssetObjects(settings);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe.skipIf(skip)(`assets in the S3-compatible store (${skip ?? settings.endpoint})`, () => {
  describe('the pre-signed upload into quarantine (BE-042 criterion 3)', () => {
    it('accepts exactly the declared size and refuses more, less, or an unsized stream', async () => {
      const tenant = randomUUID();
      const asset = randomUUID();
      const bytes = png();
      const up = presignQuarantineUpload(store, {
        tenant,
        asset,
        size: bytes.length,
        lifetimeSeconds: 120,
      });
      expect(up.key).toBe(`tenants/${tenant}/quarantine/${asset}`);
      expect(up.headers).toEqual({ 'content-length': String(bytes.length) });
      const larger = await fetch(up.url, {
        method: 'PUT',
        body: concat(bytes, enc('<script>more</script>')),
      });
      expect(larger.status).toBe(403);
      await larger.arrayBuffer();
      const smaller = await fetch(up.url, {
        method: 'PUT',
        body: bytes.subarray(0, bytes.length - 1),
      });
      expect(smaller.status).toBe(403);
      await smaller.arrayBuffer();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
      const chunked = await fetch(up.url, {
        method: 'PUT',
        body: stream,
        duplex: 'half',
      } as RequestInit);
      expect(chunked.ok).toBe(false);
      await chunked.arrayBuffer();
      expect(await store.head(up.key)).toBeNull();
      const exact = await fetch(up.url, { method: 'PUT', body: bytes });
      expect(exact.status).toBe(200);
      await exact.arrayBuffer();
      expect(await store.head(up.key)).toEqual({ bytes: bytes.length });
      // The same address cannot then be used for another upload of a different size.
      const again = await fetch(up.url, {
        method: 'PUT',
        body: new Uint8Array(bytes.length + 1000),
      });
      expect(again.status).toBe(403);
      await again.arrayBuffer();
      await store.delete(up.key);
    });

    it('refuses an upload address that has expired', async () => {
      const past = new S3AssetObjects({ ...settings, now: () => Date.now() - 3_600_000 });
      const up = presignQuarantineUpload(past, {
        tenant: randomUUID(),
        asset: randomUUID(),
        size: 4,
        lifetimeSeconds: 60,
      });
      const res = await fetch(up.url, { method: 'PUT', body: enc('abcd') });
      expect(res.status).toBe(403);
      await res.arrayBuffer();
    });
  });

  describe('the job from quarantine to the final object (BE-043; SEC-037 criteria 1 and 2)', () => {
    const events: (AssetReady | AssetFailed)[] = [];
    const worker = createAssetWorker({
      objects: store,
      sandbox: unsandboxed(),
      allowUnsandboxed: true,
      outcomes: {
        ready: async (r) => void events.push(r),
        failed: async (f) => void events.push(f),
      },
    });

    async function uploadAndProcess(tenant: string, bytes: Uint8Array, mime: string) {
      const asset = randomUUID();
      const up = presignQuarantineUpload(store, { tenant, asset, size: bytes.length });
      const res = await fetch(up.url, { method: 'PUT', body: bytes });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      const r = await worker.handle({
        tenant,
        id: randomUUID(),
        payload: { asset, mime, size: bytes.length, sha256: sha(bytes) },
      });
      return { r, asset };
    }

    it('writes the re-encoded file under its own hash, with its content type, and deletes the upload', async () => {
      const tenant = randomUUID();
      const input = concat(png(), enc('<html>appended</html>'));
      const { r, asset } = await uploadAndProcess(tenant, input, PNG);
      const ready = r as AssetReady;
      expect(ready.ok).toBe(true);
      // The client's hash of its own bytes (in the payload) is not what the object is keyed by.
      expect(ready.sha256).not.toBe(sha(input));
      expect(ready.objectKey).toBe(`tenants/${tenant}/assets/${ready.sha256}`);
      const stored = await store.get(ready.objectKey, 1 << 24);
      expect(stored && sha(stored)).toBe(ready.sha256);
      expect(await store.head(assetKeys.quarantine(tenant, asset))).toBeNull();
      // The content type the store returns is the one the worker set.
      const direct = await fetch(store.presignRead(ready.objectKey, 60));
      expect(direct.headers.get('content-type')).toBe(PNG);
      await direct.arrayBuffer();
      await store.delete(ready.objectKey);
    });

    it('fails a file whose type differs, deleting the upload and storing nothing', async () => {
      const tenant = randomUUID();
      const { r, asset } = await uploadAndProcess(
        tenant,
        enc('<html><script>alert(1)</script></html>'),
        JPEG,
      );
      expect(r).toMatchObject({ ok: false, reason: 'type_mismatch' });
      expect(await store.head(assetKeys.quarantine(tenant, asset))).toBeNull();
    });

    it('gives two tenants who upload the same bytes one object each, under their own prefixes', async () => {
      const a = randomUUID();
      const b = randomUUID();
      const bytes = jpegOf(40, 30);
      const ra = (await uploadAndProcess(a, bytes, JPEG)).r as AssetReady;
      const rb = (await uploadAndProcess(b, bytes, JPEG)).r as AssetReady;
      expect(ra.sha256).toBe(rb.sha256);
      expect(ra.objectKey).not.toBe(rb.objectKey);
      expect(await store.head(ra.objectKey)).not.toBeNull();
      expect(await store.head(rb.objectKey)).not.toBeNull();
      // Writing tenant A's key again is skipped, so tenant B cannot reach it through the worker.
      expect(
        await store.put(ra.objectKey, enc('overwrite'), { contentType: PNG, ifAbsent: true }),
      ).toBe('exists');
      expect(sha((await store.get(ra.objectKey, 1 << 24))!)).toBe(ra.sha256);
      await store.delete(ra.objectKey);
      await store.delete(rb.objectKey);
    });

    it('reads an upload with a size bound', async () => {
      const key = assetKeys.quarantine(randomUUID(), randomUUID());
      await store.put(key, new Uint8Array(4096), { contentType: 'application/octet-stream' });
      await expect(store.get(key, 1000)).rejects.toThrow(ObjectTooLarge);
      await store.delete(key);
    });
  });

  describe('the asset origin over the store (BE-045 criteria 2 to 5)', () => {
    let origin: RunningOrigin;
    const keys = { current: { id: 'k1', secret: randomBytes(32) } };
    const tenant = randomUUID();
    const bytes = png();
    const hash = sha(bytes);
    beforeAll(async () => {
      await store.put(assetKeys.final(tenant, hash), bytes, { contentType: 'text/html' });
      origin = await startAssetOrigin({ objects: store, keys });
    });
    afterAll(async () => {
      await origin.close();
      await store.delete(assetKeys.final(tenant, hash));
    });

    it('serves one object by a short-lived signed URL with fixed headers, and refuses an altered one', async () => {
      const url = signAssetUrl({
        origin: origin.url,
        tenant,
        sha256: hash,
        mime: PNG,
        expiresAt: assetUrlExpiry(Date.now()),
        keys,
      });
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(PNG);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toMatch(/immutable/);
      expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(hash);
      const other = await fetch(url.replace(tenant, randomUUID()));
      expect(other.status).toBe(403);
      await other.arrayBuffer();
    });
  });
});
