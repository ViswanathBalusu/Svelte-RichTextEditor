// BE-041 criterion 1 for the tenants that opt in (owner decision 274 of
// docs/owner-decisions-2026-11-26.md): an object of an opted-in tenant that only the service reads is
// sealed with that tenant's key from KeyService, and nothing else changes. Adapter tests over memory
// stores, then the whole service in one process over memory storage.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { tenantKeyId } from '../../src/objects/encrypted-store.ts';
import { OptInTenantSealStore, sealedPrefixTenant } from '../../src/objects/opt-in-seal-store.ts';
import { MemoryObjectStore, objectKeys } from '../../src/objects/store.ts';
import { startService, type Service } from '../../src/server.ts';
import { KeyDisabledError, MemoryKeyService } from '../../src/storage/key-service.ts';
import { documentWithRegions } from '../control-plane/support.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PLAIN = 'the canonical document, in plain words';

describe('OptInTenantSealStore', () => {
  it('seals the service-only objects of an opted-in tenant with its own key and no one else', async () => {
    const raw = new MemoryObjectStore();
    const keys = new MemoryKeyService();
    const a = randomUUID();
    const b = randomUUID();
    const store = new OptInTenantSealStore(raw, keys, [a]);
    await store.provision();

    const doc = randomUUID();
    const aKey = objectKeys.checkpoint(a, doc, 3);
    const bKey = objectKeys.checkpoint(b, doc, 3);
    await store.put(aKey, enc.encode(PLAIN));
    await store.put(bKey, enc.encode(PLAIN));

    // A's object is sealed in the bucket; B, which did not opt in, is stored as given.
    expect(dec.decode((await raw.get(aKey))!)).not.toContain('canonical');
    expect(dec.decode((await raw.get(bKey))!)).toBe(PLAIN);
    expect(dec.decode((await store.get(aKey))!)).toBe(PLAIN);
    expect(dec.decode((await store.get(bKey))!)).toBe(PLAIN);

    // The seal uses the tenant's own key, not a shared one: B has no key at all.
    await expect(keys.enabled(tenantKeyId(a))).resolves.toBe(true);
    await expect(keys.publicJwk(tenantKeyId(b))).rejects.toThrow();
  });

  it('seals cold segments and set-aside checkpoints, and leaves the objects other readers use', async () => {
    const raw = new MemoryObjectStore();
    const keys = new MemoryKeyService();
    const a = randomUUID();
    const store = new OptInTenantSealStore(raw, keys, [a]);
    await store.provision();
    const doc = randomUUID();
    const sealed = [
      objectKeys.segments(a, doc) + '1-9.payloads.zst',
      objectKeys.checkpointAside(a, doc, 4, 'recovery'),
    ];
    // The client writes quarantine through a pre-signed URL, the asset origin reads assets, and
    // downloads use signed URLs: these stay as written.
    const open = [
      `tenants/${a}/quarantine/${randomUUID()}`,
      `tenants/${a}/assets/${'0'.repeat(64)}`,
      `tenants/${a}/exports/${randomUUID()}/out.pdf`,
      `tenants/${a}/final/${doc}/${randomUUID()}.pdf`,
    ];
    for (const key of [...sealed, ...open]) await store.put(key, enc.encode(PLAIN));
    for (const key of sealed) expect(dec.decode((await raw.get(key))!)).not.toBe(PLAIN);
    for (const key of open) expect(dec.decode((await raw.get(key))!)).toBe(PLAIN);
    for (const key of [...sealed, ...open]) expect(dec.decode((await store.get(key))!)).toBe(PLAIN);
  });

  it('makes the tenant unreadable and unwritable when its key is disabled, and leaves another opted-in tenant alone', async () => {
    const raw = new MemoryObjectStore();
    const keys = new MemoryKeyService();
    const a = randomUUID();
    const b = randomUUID();
    const store = new OptInTenantSealStore(raw, keys, [a, b]);
    await store.provision();
    const doc = randomUUID();
    const aKey = objectKeys.checkpoint(a, doc, 1);
    const bKey = objectKeys.checkpoint(b, doc, 1);
    await store.put(aKey, enc.encode('a'));
    await store.put(bKey, enc.encode('b'));
    await keys.disable(tenantKeyId(a));
    await expect(store.get(aKey)).rejects.toThrow(KeyDisabledError);
    await expect(store.put(aKey, enc.encode('again'))).rejects.toThrow();
    expect(dec.decode((await store.get(bKey))!)).toBe('b');
  });

  it('reads the tenant from the key', () => {
    const t = randomUUID();
    expect(sealedPrefixTenant(`tenants/${t.toUpperCase()}/docs/x`)).toBe(t);
    expect(sealedPrefixTenant(`tenants/${t}/assets/x`)).toBeNull();
    expect(sealedPrefixTenant('elsewhere')).toBeNull();
  });
});

describe('a service with an opted-in tenant (BE-041)', () => {
  let s: Service;
  let raw: MemoryObjectStore;
  let keys: MemoryKeyService;
  const sealedTenant = randomUUID();
  const plainTenant = randomUUID();
  const credentials = new Map<string, string>();

  beforeAll(async () => {
    raw = new MemoryObjectStore();
    keys = new MemoryKeyService();
    s = await startService({
      config: { ...configFromEnv({}), port: 0, workers: 1 },
      parts: { objects: raw, keyService: keys, sealedTenants: [sealedTenant] },
    });
    for (const tenant of [sealedTenant, plainTenant]) {
      await s.parts.registry.putTenant(tenant, 'be-041 opt-in');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      credentials.set(tenant, key.credential);
    }
  });
  afterAll(async () => {
    await s?.close();
  });

  it('provisions the key of the tenant that opted in and no other', async () => {
    await expect(keys.enabled(tenantKeyId(sealedTenant))).resolves.toBe(true);
    await expect(keys.publicJwk(tenantKeyId(plainTenant))).rejects.toThrow();
  });

  it('writes a checkpoint of the opted-in tenant sealed and one of the other tenant plain', async () => {
    const doc = randomUUID();
    const body = enc.encode(PLAIN);
    // `parts.objects` is the store the service writes through.
    await s.parts.objects.put(objectKeys.checkpoint(sealedTenant, doc, 1), body);
    await s.parts.objects.put(objectKeys.checkpoint(plainTenant, doc, 1), body);
    expect(dec.decode((await raw.get(objectKeys.checkpoint(sealedTenant, doc, 1)))!)).not.toBe(PLAIN);
    expect(dec.decode((await raw.get(objectKeys.checkpoint(plainTenant, doc, 1)))!)).toBe(PLAIN);
    expect(await s.parts.objects.get(objectKeys.checkpoint(sealedTenant, doc, 1))).toEqual(body);
  });

  it('still creates and reads a document of the opted-in tenant over HTTP', async () => {
    const auth = { Authorization: `Bearer ${credentials.get(sealedTenant)!}` };
    const created = await fetch(`${s.url}/v1/documents`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: documentWithRegions() }),
    });
    expect(created.status).toBeLessThan(300);
    const { id } = (await created.json()) as { id: string };
    const read = await fetch(`${s.url}/v1/documents/${id}/content`, { headers: auth });
    expect(read.status).toBe(200);
    // Whatever the service wrote under the tenant's docs/ prefix is sealed in the bucket.
    for (const key of await raw.list(`tenants/${sealedTenant}/docs/`))
      expect(dec.decode((await raw.get(key))!)).not.toContain('Hello');
  });
});
