/**
 * SEC-049 criterion 4 (10 §3.7; 06 §13; BE-096), lane V-SEC-049-064: the backup key is different
 * from the keys of live data, shown by behaviour and by key material rather than by identifiers.
 *
 * The keys of live data are of two kinds. Each tenant has an RSA-OAEP `unwrap` key in `KeyService`
 * (its private half never leaves the service), and each stored object is sealed with its own
 * AES-256-GCM data key, wrapped with that tenant key (encrypted-store.ts). The key service does
 * return unwrapped data keys (06 §14), so the test can read every live data key and compare its
 * bytes with the backup key. The tenant keys cannot be read, so for them the test shows behaviour:
 * no tenant key unwraps the backup's data key, and the backup key does not open a tenant object.
 *
 * A negative control builds a backup key from a live data key and shows that the same checks then
 * fail, so the checks are not true by construction. The scenario runs on an in-memory store and
 * again on the S3-compatible test store (docedit-test-s3), which it skips with the reason when that
 * store is not up: pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../../services/document-service/src/data-plane/memory-ports.ts';
import {
  BackupError,
  backupKey,
  openBackup,
  readBackup,
  writeBackup,
  type BackupKey,
} from '../../../services/document-service/src/data-plane/backup.ts';
import {
  EncryptedObjectStore,
  tenantKeyId,
} from '../../../services/document-service/src/objects/encrypted-store.ts';
import { S3ObjectStore } from '../../../services/document-service/src/objects/s3.ts';
import {
  MemoryObjectStore,
  type ObjectStore,
} from '../../../services/document-service/src/objects/store.ts';
import { MemoryKeyService } from '../../../services/document-service/src/storage/key-service.ts';
import { settings } from '../../../services/document-service/test/support/env.ts';

const TAG = 'V-UX-046-060-v-sec-049-064';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DUMP = 'CREATE TABLE doc_commits (seq integer);\n';

/** The parts of an object envelope of encrypted-store.ts (version 1). */
interface Envelope {
  wrapped: Uint8Array;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function envelope(sealed: Uint8Array): Envelope {
  const buf = Buffer.from(sealed);
  expect(buf[0]).toBe(1);
  const wrappedLength = buf.readUInt16BE(1);
  const start = 3 + wrappedLength;
  const body = buf.subarray(start + IV_BYTES);
  return {
    wrapped: new Uint8Array(buf.subarray(3, start)),
    iv: buf.subarray(start, start + IV_BYTES),
    ciphertext: body.subarray(0, body.length - TAG_BYTES),
    tag: body.subarray(body.length - TAG_BYTES),
  };
}

/** AES-256-GCM open of an object envelope with `key` as its data key; null when it does not open. */
function openObject(env: Envelope, key: Buffer, objectKey: string): Buffer | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, env.iv);
    d.setAAD(Buffer.from(objectKey, 'utf8'));
    d.setAuthTag(env.tag);
    return Buffer.concat([d.update(env.ciphertext), d.final()]);
  } catch {
    return null;
  }
}

/** The header of a sealed backup (backup.ts, version 1). */
function backupHeader(sealed: Uint8Array): { kek: string; wrapIv: Buffer; wrapped: Buffer } {
  const buf = Buffer.from(sealed);
  const length = buf.readUInt32BE(5);
  const h = JSON.parse(buf.subarray(9, 9 + length).toString('utf8')) as Record<string, string>;
  return {
    kek: h['kek']!,
    wrapIv: Buffer.from(h['wrapIv']!, 'base64'),
    wrapped: Buffer.from(h['wrapped']!, 'base64'),
  };
}

/** The backup's own data key, unwrapped with `kek` as backup.ts does. */
function backupDataKey(sealed: Uint8Array, kek: Buffer): Buffer {
  const h = backupHeader(sealed);
  const d = createDecipheriv('aes-256-gcm', kek, h.wrapIv);
  d.setAuthTag(h.wrapped.subarray(h.wrapped.length - TAG_BYTES));
  return Buffer.concat([d.update(h.wrapped.subarray(0, h.wrapped.length - TAG_BYTES)), d.final()]);
}

interface LiveObject {
  tenant: string;
  key: string;
  plain: Buffer;
  env: Envelope;
  /** The live data key of this object, unwrapped through the key service. */
  dataKey: Buffer;
}

interface Scenario {
  keys: MemoryKeyService;
  raw: ObjectStore;
  tenants: string[];
  live: LiveObject[];
  kek: BackupKey;
  sealed: Buffer;
  backupKeyName: string;
}

/** Two tenants with two sealed objects each, and a backup of them under a fresh backup key. */
async function scenario(
  raw: ObjectStore,
  target: ObjectStore,
  backupKeyName: string,
): Promise<Scenario> {
  const keys = new MemoryKeyService();
  const encrypted = new EncryptedObjectStore(raw, keys);
  const tenants = [randomUUID(), randomUUID()];
  const live: LiveObject[] = [];
  for (const tenant of tenants) {
    await encrypted.provision(tenant);
    for (const n of [0, 1]) {
      const key = `tenants/${tenant}/checkpoints/${TAG}-${n}.json`;
      const plain = Buffer.from(JSON.stringify({ text: `${TAG} ${tenant} ${n}` }));
      await encrypted.put(key, plain);
      const env = envelope((await raw.get(key))!);
      const dataKey = Buffer.from(await keys.unwrap(tenantKeyId(tenant), env.wrapped));
      live.push({ tenant, key, plain, env, dataKey });
    }
  }
  const kek = backupKey(randomBytes(32).toString('base64'));
  await writeBackup({
    source: { dumpDatabase: async () => new TextEncoder().encode(DUMP), objects: raw },
    tenants,
    kek,
    target,
    targetKey: backupKeyName,
    audit: { audit: new MemoryAudit(), actor: `operator:${TAG}` },
  });
  const sealed = Buffer.from((await target.get(backupKeyName))!);
  return { keys, raw, tenants, live, kek, sealed, backupKeyName };
}

/** The checks of criterion 4. Each returns the reasons it failed, so the negative control can use them. */
async function separationFailures(s: Scenario, kek: BackupKey): Promise<string[]> {
  const failures: string[] = [];
  // Key material: the backup key is none of the live data keys, and the backup's own data key is
  // none of them either.
  const backupData = backupDataKey(s.sealed, s.kek.key);
  for (const o of s.live) {
    if (o.dataKey.equals(kek.key)) failures.push(`the backup key is the data key of ${o.key}`);
    if (o.dataKey.equals(backupData))
      failures.push(`the backup's data key is the data key of ${o.key}`);
    // Behaviour: the backup key does not open a live object as its data key.
    if (openObject(o.env, kek.key, o.key) !== null) failures.push(`the backup key opens ${o.key}`);
  }
  // Behaviour: no tenant key of the key service unwraps the backup's data key.
  const { wrapped } = backupHeader(s.sealed);
  for (const tenant of s.tenants) {
    const opened = await s.keys.unwrap(tenantKeyId(tenant), new Uint8Array(wrapped)).then(
      () => true,
      () => false,
    );
    if (opened) failures.push(`the key of tenant ${tenant} unwraps the backup's data key`);
  }
  // Behaviour: no live data key opens the backup, even when it is given the backup key's identifier.
  for (const o of s.live) {
    try {
      openBackup(s.sealed, { id: s.kek.id, key: o.dataKey });
      failures.push(`the data key of ${o.key} opens the backup`);
    } catch (e) {
      if (!(e instanceof BackupError)) throw e;
    }
  }
  return failures;
}

async function provesSeparation(s: Scenario): Promise<void> {
  // Positive controls: every live data key was really read (it opens its own object), and the
  // backup really opens with its own key.
  for (const o of s.live) {
    expect(o.dataKey.length).toBe(32);
    expect(openObject(o.env, o.dataKey, o.key)?.equals(o.plain)).toBe(true);
  }
  expect(openBackup(s.sealed, s.kek).length).toBeGreaterThan(0);
  // The tenant keys are RSA-2048 key pairs; the backup key is a 32-byte symmetric key.
  for (const tenant of s.tenants) {
    const jwk = await s.keys.publicJwk(tenantKeyId(tenant));
    expect(jwk.kty).toBe('RSA');
    expect(Buffer.from(jwk.n!, 'base64url').length).toBe(256);
  }
  expect(s.kek.key.length).toBe(32);

  expect(await separationFailures(s, s.kek)).toEqual([]);

  // Negative control: a backup key made from a live data key is caught by the same checks.
  const reused = backupKey(s.live[0]!.dataKey.toString('base64'));
  const caught = await separationFailures(s, reused);
  expect(caught).toContain(`the backup key is the data key of ${s.live[0]!.key}`);
  expect(caught).toContain(`the backup key opens ${s.live[0]!.key}`);

  // Independence: with every tenant key disabled, the backup still opens with its own key, so it
  // depends on no live key; the live objects no longer open through the key service.
  for (const tenant of s.tenants) await s.keys.disable(tenantKeyId(tenant));
  const encrypted = new EncryptedObjectStore(s.raw, s.keys);
  await expect(encrypted.get(s.live[0]!.key)).rejects.toThrow();
  const target = new MemoryObjectStore();
  await target.put(s.backupKeyName, s.sealed);
  const bundle = await readBackup({
    target,
    key: s.backupKeyName,
    kek: s.kek,
    audit: { audit: new MemoryAudit(), actor: `operator:${TAG}` },
  });
  expect(Buffer.from(bundle.database, 'base64').toString('utf8')).toBe(DUMP);
  expect(bundle.objects.map((o) => o.key).sort()).toEqual(s.live.map((o) => o.key).sort());
}

describe('SEC-049 criterion 4: the backup key is different from the keys of live data (in memory)', () => {
  it('differs in material from every live data key, opens no live object, and no live key opens the backup', async () => {
    const raw = new MemoryObjectStore();
    await provesSeparation(
      await scenario(raw, new MemoryObjectStore(), `backups/${TAG}-${randomUUID()}.debk`),
    );
  });
});

const S = settings();
const s3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).exists(`probe/${TAG}-${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = await s3Unavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'SEC-049 criterion 4: the backup key is different from the keys of live data (S3-compatible store)',
  () => {
    const created: string[] = [];
    const tenants: string[] = [];

    afterAll(async () => {
      const store = new S3ObjectStore(s3Settings);
      for (const t of tenants)
        for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      for (const key of created) await store.delete(key).catch(() => {});
    });

    it('holds for objects sealed in the S3-compatible store and a backup written to it', async () => {
      const store = new S3ObjectStore(s3Settings);
      const name = `backups/${TAG}-${randomUUID()}.debk`;
      created.push(name);
      const s = await scenario(store, store, name);
      tenants.push(...s.tenants);
      for (const o of s.live) created.push(o.key);
      await provesSeparation(s);
    });
  },
);
