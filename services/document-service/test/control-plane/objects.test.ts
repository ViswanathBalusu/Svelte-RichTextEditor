// Object storage (BE-003; 06 §4.2): the key layout, the tenant guard, write-once, and the
// checkpoint and asset stores, against the in-memory store and the S3-compatible server of the
// test environment (Versity S3 Gateway, FND-010).
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AssetStore, ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import {
  ForeignKeyError,
  MemoryObjectStore,
  ObjectExistsError,
  objectKeys,
  TenantObjects,
  type ObjectStore,
} from '../../src/objects/store.ts';
import { emptyDocument } from '../../src/control-plane/content.ts';
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
  describe(`object stores (${kind})`, () => {
    const skip = kind === 's3' ? s3Skip : null;
    const store = (): ObjectStore =>
      kind === 's3' ? new S3ObjectStore(s3Settings) : new MemoryObjectStore();

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
      const assets = new AssetStore(store());
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

    it.skipIf(skip)('passes the CheckpointStore contract (criterion 4)', async () => {
      const cps = new ObjectCheckpointStore(store());
      const ref = { tenant: randomUUID(), doc: randomUUID() };
      expect(await cps.get(ref, 0)).toBeNull();
      expect(await cps.latest(ref, 10)).toBeNull();
      const zero = emptyDocument();
      await cps.put(ref, 0, zero);
      const later = { ...emptyDocument(), requires: ['x-feature'] };
      await cps.put(ref, 20, later);
      await cps.put(ref, 3, zero);
      expect(await cps.get(ref, 0)).toEqual(zero);
      expect(await cps.latest(ref, 19)).toEqual({ seq: 3, content: zero });
      expect(await cps.latest(ref, 20)).toEqual({ seq: 20, content: later });
      // Another tenant's checkpoint of the same document identifier is a different object.
      expect(await cps.get({ tenant: randomUUID(), doc: ref.doc }, 0)).toBeNull();
    });

    it.skipIf(skip)(
      'passes the AssetStore contract: quarantine, content-addressed finals, exports (criterion 4)',
      async () => {
        const s = store();
        const assets = new AssetStore(s);
        const t = randomUUID();
        const asset = randomUUID();
        await assets.putQuarantined(t, asset, Buffer.from('raw upload'));
        expect(Buffer.from((await assets.getQuarantined(t, asset))!).toString()).toBe('raw upload');
        const bytes = Buffer.from('a validated image');
        const sha = await assets.putFinal(t, bytes, 'image/png');
        expect(sha).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(await assets.putFinal(t, bytes, 'image/png')).toBe(sha);
        expect(Buffer.from((await assets.getFinal(t, sha))!).toString()).toBe('a validated image');
        const job = randomUUID();
        await assets.putExport(t, job, 'output.pdf', Buffer.from('%PDF'), 'application/pdf');
        const url = assets.signedUrl(
          t,
          objectKeys.exportFile(t, job, 'output.pdf'),
          Date.now() + 60_000,
        );
        if (kind === 's3') {
          // The signed URL reads the object without credentials, and nothing else.
          const res = await fetch(url);
          expect(res.status).toBe(200);
          expect(await res.text()).toBe('%PDF');
          const tampered = await fetch(url.replace('output.pdf', 'other.pdf'));
          expect(tampered.status).toBe(403);
        } else expect(url).toMatch(/^memory:\/\/objects\/tenants\//);
      },
    );
  });
}
