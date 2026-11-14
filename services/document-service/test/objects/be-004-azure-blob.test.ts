// Azure Blob Storage (BE-004, lane V-BE-001-014): the ObjectStore port over Azure's Blob service,
// run against the Azurite emulator of the test environment (its own container, one uniquely named
// container per run, deleted afterwards). The key layout, write-once and the CheckpointStore and
// AssetStore contracts are the ones of BE-003, run unchanged.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AzureBlobObjectStore, type AzureBlobSettings } from '../../src/objects/azure.ts';
import { AssetStore, ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import {
  ObjectExistsError,
  objectKeys,
  TenantObjects,
  type ObjectStore,
} from '../../src/objects/store.ts';
import { emptyDocument } from '../../src/control-plane/content.ts';
import { settings as testSettings } from '../support/env.ts';

// The public, well-known key of the Azurite emulator's devstoreaccount1 account. It is not a secret.
const EMULATOR_ACCOUNT = 'devstoreaccount1';
const EMULATOR_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
// The endpoint comes from the test-environment settings (infra/containers/.env.example, .env, then
// the process environment), as the S3 and PostgreSQL ones do. The test environment has no Azurite
// entry yet (settings() lets the environment override only keys the files name), so the process
// environment is read directly too, and the last fallback is the port the BE-004 evidence used.
const ENDPOINT =
  testSettings()['DOCEDIT_AZURITE_ENDPOINT'] ??
  process.env['DOCEDIT_AZURITE_ENDPOINT'] ??
  'http://127.0.0.1:57321/devstoreaccount1';

const container = `docedit-v-be-001-014-${randomUUID().slice(0, 8)}`;
const settings: AzureBlobSettings = {
  endpoint: ENDPOINT,
  account: EMULATOR_ACCOUNT,
  accountKey: EMULATOR_KEY,
  container,
};

const store = new AzureBlobObjectStore(settings);

// Probed before the tests are declared, so that `describe.skipIf` sees the result (a flag set in
// `beforeAll` is read too late: skip conditions are evaluated at collection time). Creating the
// run's own container is the probe; it is deleted in `afterAll`.
async function azuriteUnavailable(): Promise<string | null> {
  try {
    await store.createContainer();
    return null;
  } catch (e) {
    return `Azurite is not reachable at ${ENDPOINT} (${e instanceof Error ? e.message : String(e)}); run it with podman and set DOCEDIT_AZURITE_ENDPOINT (see the BE-004 evidence)`;
  }
}

const skip = await azuriteUnavailable();
if (skip) console.warn(`be-004-azure-blob: skipped: ${skip}`);

describe.skipIf(skip !== null)('Azure Blob adapter (BE-004)', () => {
  afterAll(async () => {
    await store.deleteContainer().catch(() => undefined);
  });

  it('round-trips objects, lists them by prefix and deletes them', async () => {
    const t = randomUUID();
    const d = randomUUID();
    const key = objectKeys.checkpoint(t, d, 42);
    await store.put(key, new TextEncoder().encode('checkpoint bytes'), {
      contentType: 'application/octet-stream',
    });
    expect(await store.exists(key)).toBe(true);
    expect(new TextDecoder().decode((await store.get(key))!)).toBe('checkpoint bytes');
    expect(await store.list(objectKeys.checkpoints(t, d))).toEqual([key]);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
  });

  it('writes a sealed PDF once; a second write is refused (criterion 3)', async () => {
    const t = randomUUID();
    const d = randomUUID();
    const key = objectKeys.final(t, d, 'wf1');
    await store.put(key, new TextEncoder().encode('%PDF-1.7 sealed'), {
      ifAbsent: true,
      contentType: 'application/pdf',
    });
    await expect(
      store.put(key, new TextEncoder().encode('%PDF-1.7 other'), { ifAbsent: true }),
    ).rejects.toThrow(ObjectExistsError);
    expect(new TextDecoder().decode((await store.get(key))!)).toBe('%PDF-1.7 sealed');
  });

  it('keeps every object under its tenant prefix (criterion 2 of BE-003)', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const objects = new TenantObjects(store, a);
    await expect(
      objects.put(objectKeys.asset(b, '0'.repeat(64)), new Uint8Array([1])),
    ).rejects.toThrow();
    await objects.put(objectKeys.quarantine(a, randomUUID()), new Uint8Array([2]));
    expect(await store.list(objectKeys.prefix(a))).toHaveLength(1);
    expect(await store.list(objectKeys.prefix(b))).toHaveLength(0);
  });

  it('returns a signed URL that reads without credentials, and refuses a changed one', async () => {
    const t = randomUUID();
    const d = randomUUID();
    const key = objectKeys.final(t, d, 'wf2');
    await store.put(key, new TextEncoder().encode('%PDF-1.7 readable'));
    const url = store.signedUrl(key, Date.now() + 60_000);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7 readable');
    const tampered = url.replace(/sig=([^&]+)/, (_m, sig: string) => `sig=${sig.slice(0, -2)}AA`);
    expect((await fetch(tampered)).status).toBe(403);
    await store.delete(key);
  });

  it('passes the CheckpointStore contract (BE-003 criterion 4, Azure)', async () => {
    const cps = new ObjectCheckpointStore(store as ObjectStore);
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
    expect(await cps.get({ tenant: randomUUID(), doc: ref.doc }, 0)).toBeNull();
  });

  it('passes the AssetStore sealed-PDF contract (BE-003 criterion 4, Azure)', async () => {
    const assets = new AssetStore(store as ObjectStore);
    const t = randomUUID();
    const d = randomUUID();
    await assets.putSealed(t, d, 'wf1', Buffer.from('%PDF-1.7 sealed'));
    await expect(assets.putSealed(t, d, 'wf1', Buffer.from('%PDF-1.7 other'))).rejects.toThrow(
      ObjectExistsError,
    );
    expect(Buffer.from((await assets.getSealed(t, d, 'wf1'))!).toString()).toBe('%PDF-1.7 sealed');
  });

  it('passes the AssetStore contract: quarantine, content-addressed finals, exports (criterion 1)', async () => {
    const assets = new AssetStore(store as ObjectStore);
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
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF');
    expect((await fetch(url.replace('output.pdf', 'other.pdf'))).status).toBe(403);
  });
});
