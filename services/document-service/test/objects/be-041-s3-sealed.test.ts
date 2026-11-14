// BE-041 criteria 1 and 2 on the S3-compatible store of the test environment (FND-010), lane
// V-BE-029-042. Objects are written through EncryptedObjectStore over S3ObjectStore, with a
// key service per run. Criterion 1: the stored bytes are sealed (the plaintext is not in them), and
// they open only under their own tenant's key. Criterion 2: disabling tenant A's key makes A's
// objects unreadable and leaves tenant B unaffected. Each run uses random tenants, so its keys sit
// under prefixes of their own; the test deletes what it wrote. Skipped, with the reason, when the
// store is down. Criteria 3 (hosted bucket versioning and replication) and 4 (BE-078 recovery) are
// not tested here.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { EncryptedObjectStore, tenantKeyId } from '../../src/objects/encrypted-store.ts';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { objectKeys } from '../../src/objects/store.ts';
import { KeyDisabledError, MemoryKeyService } from '../../src/storage/key-service.ts';
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
    await new S3ObjectStore(s3Settings).exists(`tenants/${randomUUID()}/probe`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip = await s3Unavailable();
if (skip) console.warn(`be-041-s3-sealed: skipped: ${skip}`);

const enc = new TextEncoder();
const dec = new TextDecoder();

describe.skipIf(skip !== null)('BE-041 criteria 1 and 2 on S3 (V-BE-029-042)', () => {
  const raw = new S3ObjectStore(s3Settings);
  const keys = new MemoryKeyService();
  const store = new EncryptedObjectStore(raw, keys);
  const a = randomUUID();
  const b = randomUUID();
  const written: string[] = [];

  async function put(key: string, body: Uint8Array): Promise<void> {
    written.push(key);
    await store.put(key, body, { contentType: 'application/zstd' });
  }

  afterAll(async () => {
    for (const key of written) await raw.delete(key).catch(() => undefined);
  });

  it('criterion 1: an object is sealed under its tenant key, stored bytes hide the plaintext and open only with that key', async () => {
    await store.provision(a);
    await store.provision(b);
    const doc = randomUUID();
    const key = objectKeys.checkpoint(a, doc, 7);
    const plain = enc.encode('V-BE-029-042 tenant A canonical document');
    await put(key, plain);

    // The bytes in the bucket are not the plaintext.
    const stored = await raw.get(key);
    expect(stored).not.toBeNull();
    expect(dec.decode(stored ?? new Uint8Array())).not.toContain('canonical document');

    // The tenant's own key reads it back.
    expect(await store.get(key)).toEqual(plain);

    // Copied under tenant B's prefix, the same bytes do not open with B's key.
    const moved = objectKeys.checkpoint(b, randomUUID(), 7);
    written.push(moved);
    await raw.put(moved, stored ?? new Uint8Array());
    // B's key does not unwrap A's data key, so the read fails before any plaintext is returned.
    await expect(store.get(moved)).rejects.toThrow();

    // Each tenant's key is its own key, not a shared one.
    expect(await keys.publicJwk(tenantKeyId(a))).not.toEqual(await keys.publicJwk(tenantKeyId(b)));
  });

  it("criterion 2: disabling tenant A's key makes A's objects unreadable on S3 and leaves tenant B unaffected", async () => {
    await store.provision(a);
    await store.provision(b);
    const aKey = objectKeys.checkpoint(a, randomUUID(), 8);
    const bKey = objectKeys.checkpoint(b, randomUUID(), 8);
    await put(aKey, enc.encode('A objects'));
    await put(bKey, enc.encode('B objects'));

    await keys.disable(tenantKeyId(a));

    // A's object is still in the bucket, sealed, and no longer opens.
    expect(await raw.exists(aKey)).toBe(true);
    await expect(store.get(aKey)).rejects.toBeInstanceOf(KeyDisabledError);

    // B reads its object as before.
    expect(dec.decode((await store.get(bKey)) ?? new Uint8Array())).toBe('B objects');

    // A new write under A's disabled key is refused and nothing reaches the bucket.
    const refused = objectKeys.checkpoint(a, randomUUID(), 9);
    await expect(store.put(refused, enc.encode('x'))).rejects.toThrow();
    expect(await raw.exists(refused)).toBe(false);
  });
});
