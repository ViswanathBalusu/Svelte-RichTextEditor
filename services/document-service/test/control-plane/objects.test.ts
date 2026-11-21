// Object storage (BE-003; 06 §4.2): the key layout, the tenant guard, write-once, and the contract
// suites of the checkpoint and asset stores (test/contract/object-checks.ts), against the in-memory
// store and the S3-compatible server of the test environment (Versity S3 Gateway, FND-010).
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ObjectAssetStore, ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import {
  ForeignKeyError,
  MemoryObjectStore,
  ObjectExistsError,
  objectKeys,
  TenantObjects,
  type ObjectStore,
  type PutOptions,
} from '../../src/objects/store.ts';
import {
  ASSET_STORE_CHECKS,
  CHECKPOINT_STORE_CHECKS,
  failingObjectChecks,
  objectHarness,
  OPTIONAL_CHECKPOINT_MEMBERS,
} from '../contract/object-checks.ts';
import { settings } from '../support/env.ts';

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
    const store = new S3ObjectStore(s3Settings);
    await store.exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const s3Skip = await s3Unavailable();
if (s3Skip) console.warn(`objects.test.ts: the S3 cases are skipped: ${s3Skip}`);

describe('the key layout of 06 §4.2 (BE-003 criterion 1)', () => {
  it('puts every kind of object under the tenant prefix', () => {
    const t = randomUUID();
    const d = randomUUID();
    const sha = createHash('sha256').update('x').digest('hex');
    expect(objectKeys.checkpoint(t, d, 2000)).toBe(
      `tenants/${t}/docs/${d}/checkpoints/2000.cdm.json.zst`,
    );
    expect(objectKeys.checkpointSide(t, d, 2000)).toBe(
      `tenants/${t}/docs/${d}/checkpoints/2000.side.json.zst`,
    );
    expect(objectKeys.segment(t, d, 1, 500)).toBe(
      `tenants/${t}/docs/${d}/segments/1-500.payloads.zst`,
    );
    const asset = randomUUID();
    expect(objectKeys.quarantine(t, asset)).toBe(`tenants/${t}/quarantine/${asset}`);
    expect(objectKeys.asset(t, sha)).toBe(`tenants/${t}/assets/${sha}`);
    const job = randomUUID();
    expect(objectKeys.exportFile(t, job, 'output.pdf')).toBe(
      `tenants/${t}/exports/${job}/output.pdf`,
    );
    expect(objectKeys.final(t, d, 'wf1')).toBe(`tenants/${t}/final/${d}/wf1.pdf`);
    expect(() => objectKeys.exportFile(t, job, '../x')).toThrow();
    expect(() => objectKeys.prefix('not-a-uuid')).toThrow();
  });
});

for (const kind of ['memory', 's3'] as const) {
  const skip = kind === 's3' ? s3Skip : null;
  const store = (): ObjectStore =>
    kind === 's3' ? new S3ObjectStore(s3Settings) : new MemoryObjectStore();

  describe(`object stores (${kind})`, () => {
    it.skipIf(skip)(
      'refuses a key under another tenant before any request is sent (criterion 2)',
      async () => {
        const calls: string[] = [];
        const inner = store();
        const recording: ObjectStore = new Proxy(inner, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function'
              ? (...args: unknown[]) => {
                  calls.push(String(prop));
                  return (v as (...a: unknown[]) => unknown).apply(target, args);
                }
              : v;
          },
        });
        const a = randomUUID();
        const b = randomUUID();
        const objects = new TenantObjects(recording, a);
        await expect(
          objects.put(objectKeys.asset(b, '0'.repeat(64)), Buffer.from('x')),
        ).rejects.toThrow(ForeignKeyError);
        await expect(objects.get(`tenants/${b}/docs/x`)).rejects.toThrow(ForeignKeyError);
        await expect(objects.get(`tenants/${a}/../${b}/x`)).rejects.toThrow(ForeignKeyError);
        await expect(objects.list(`tenants/${b}/`)).rejects.toThrow(ForeignKeyError);
        expect(() => objects.signedUrl(`tenants/${b}/assets/x`, Date.now() + 1000)).toThrow(
          ForeignKeyError,
        );
        expect(calls).toEqual([]);
        await objects.put(`tenants/${a}/quarantine/${randomUUID()}`, Buffer.from('ok'));
        expect(calls).toEqual(['put']);
      },
    );

    it.skipIf(skip)('writes a sealed PDF once (criterion 3)', async () => {
      const assets = new ObjectAssetStore(store());
      const t = randomUUID();
      const d = randomUUID();
      await assets.putSealed(t, d, 'wf1', Buffer.from('%PDF-1.7 sealed'));
      await expect(assets.putSealed(t, d, 'wf1', Buffer.from('%PDF-1.7 other'))).rejects.toThrow(
        ObjectExistsError,
      );
      expect(Buffer.from((await assets.getSealed(t, d, 'wf1'))!).toString()).toBe(
        '%PDF-1.7 sealed',
      );
    });
  });

  // Criterion 4: the contract suites, each check a test of its own.
  describe(`CheckpointStore contract (${kind})`, () => {
    for (const c of CHECKPOINT_STORE_CHECKS)
      it.skipIf(skip)(c.name, () => c.run(objectHarness(store())));
  });

  describe(`AssetStore contract (${kind})`, () => {
    for (const c of ASSET_STORE_CHECKS)
      it.skipIf(skip)(c.name, () => c.run(objectHarness(store())));
  });
}

describe('signed URLs of the S3-compatible store', () => {
  it.skipIf(s3Skip)('stop reading the object once their time has passed', async () => {
    const live = new ObjectAssetStore(new S3ObjectStore(s3Settings));
    const t = randomUUID();
    const job = randomUUID();
    await live.putExport(t, job, 'output.pdf', Buffer.from('%PDF'), 'application/pdf');
    const key = objectKeys.exportFile(t, job, 'output.pdf');
    // Signed ten minutes ago for one minute. The server judges the time by its own clock, so the
    // margin of nine minutes is far more than any difference between the two machines.
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    const past = new ObjectAssetStore(
      new S3ObjectStore({ ...s3Settings, now: () => tenMinutesAgo }),
    );
    const expired = await fetch(past.signedUrl(t, key, tenMinutesAgo + 60_000));
    await expired.arrayBuffer();
    expect(expired.status).toBe(403);
    const fresh = await fetch(live.signedUrl(t, key, Date.now() + 60_000));
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe('%PDF');
  });
});

describe('the reference stores and the contract suites', () => {
  it('offer every optional member of CheckpointStore, so no check passes by default', () => {
    const cps = new ObjectCheckpointStore(new MemoryObjectStore());
    for (const member of OPTIONAL_CHECKPOINT_MEMBERS) expect(typeof cps[member]).toBe('function');
  });

  /** Passes every call on; a wrong store overrides the one rule it breaks. */
  class Delegating implements ObjectStore {
    protected readonly inner: ObjectStore = new MemoryObjectStore();

    put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
      return this.inner.put(key, body, opts);
    }
    get(key: string): Promise<Uint8Array | null> {
      return this.inner.get(key);
    }
    exists(key: string): Promise<boolean> {
      return this.inner.exists(key);
    }
    delete(key: string): Promise<void> {
      return this.inner.delete(key);
    }
    list(prefix: string): Promise<string[]> {
      return this.inner.list(prefix);
    }
    signedUrl(key: string, expiresAt: number): string {
      return this.inner.signedUrl(key, expiresAt);
    }
  }

  /** Not write-once: `ifAbsent` is ignored, so a second sealed PDF replaces the first. */
  class Overwrites extends Delegating {
    override put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
      return this.inner.put(
        key,
        body,
        opts.contentType !== undefined ? { contentType: opts.contentType } : {},
      );
    }
  }

  /** Lists one page only, as an adapter that drops the continuation token would. */
  class OnePageOnly extends Delegating {
    override async list(prefix: string): Promise<string[]> {
      return (await this.inner.list(prefix)).slice(0, 1000);
    }
  }

  /** Reads objects as text and writes them back as UTF-8: bytes that are not text are lost. */
  class TextOnly extends Delegating {
    override async get(key: string): Promise<Uint8Array | null> {
      const bytes = await this.inner.get(key);
      return bytes ? new TextEncoder().encode(new TextDecoder().decode(bytes)) : null;
    }
  }

  const failed = async (make: () => ObjectStore): Promise<string[]> =>
    (
      await failingObjectChecks([...CHECKPOINT_STORE_CHECKS, ...ASSET_STORE_CHECKS], () =>
        objectHarness(make()),
      )
    ).map((f) => f.split(':')[0]!);

  it('pass the in-memory store through the same runner', async () => {
    expect(await failed(() => new MemoryObjectStore())).toEqual([]);
  });

  it('refuse a store that is not write-once', async () => {
    expect(await failed(() => new Overwrites())).toEqual(['a sealed PDF is written once']);
  });

  it('refuse a store that lists one page only', async () => {
    expect(await failed(() => new OnePageOnly())).toEqual([
      'the newest checkpoint is found among more objects than one listing page holds',
    ]);
  });

  it('refuse a store that does not keep bytes as they were written', async () => {
    const names = await failed(() => new TextOnly());
    for (const required of [
      'the stored bytes are the canonical JSON text compressed with Zstandard',
      'the side object of a checkpoint is stored beside it and is not a checkpoint',
      'a quarantined upload is read back by its tenant, and a second upload replaces it',
      'a final asset is stored under the SHA-256 the store computes, once for each tenant',
      'a sealed PDF is written once',
    ])
      expect(names).toContain(required);
  });
});
