// Per-tenant envelope encryption of objects (BE-041 criteria 1 and 2 at the adapter; 06 §4.2):
// each object is sealed under its tenant's key from KeyService, a disabled key makes that tenant's
// objects unreadable and leaves the other tenant unaffected, and sealed bytes do not open under
// another key or another object key.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { KeyDisabledError, MemoryKeyService } from '../storage/key-service.ts';
import {
  EncryptedObjectStore,
  KeyDisabledWrite,
  SealError,
  tenantKeyId,
  tenantOf,
} from './encrypted-store.ts';
import { MemoryObjectStore, objectKeys } from './store.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('EncryptedObjectStore', () => {
  let raw: MemoryObjectStore;
  let keys: MemoryKeyService;
  let store: EncryptedObjectStore;
  let a: string;
  let b: string;

  beforeEach(async () => {
    raw = new MemoryObjectStore();
    keys = new MemoryKeyService();
    store = new EncryptedObjectStore(raw, keys);
    a = randomUUID();
    b = randomUUID();
    await store.provision(a);
    await store.provision(b);
  });

  it('stores sealed bytes that do not contain the plaintext and reads them back', async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 7);
    const body = enc.encode('the canonical document, in plain words');
    await store.put(key, body, { contentType: 'application/zstd' });
    const stored = await raw.get(key);
    expect(stored).not.toBeNull();
    expect(dec.decode(stored ?? new Uint8Array())).not.toContain('canonical document');
    expect(await store.get(key)).toEqual(body);
  });

  it('seals every object with a fresh data key and IV', async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 1);
    await store.put(key, enc.encode('same'));
    const first = await raw.get(key);
    await store.put(key, enc.encode('same'));
    const second = await raw.get(key);
    expect(Buffer.from(first ?? [])).not.toEqual(Buffer.from(second ?? []));
  });

  it('round-trips arbitrary bodies under arbitrary tenant objects (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 4096 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (body, seq) => {
          const key = objectKeys.checkpoint(a, randomUUID(), seq);
          await store.put(key, body);
          expect(Buffer.from((await store.get(key)) ?? [])).toEqual(Buffer.from(body));
        },
      ),
      { numRuns: 30 },
    );
  });

  it('reads null for a missing object and keeps exists, list and delete on the raw store', async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 2);
    expect(await store.get(key)).toBeNull();
    await store.put(key, enc.encode('x'));
    expect(await store.exists(key)).toBe(true);
    expect(await store.list(objectKeys.prefix(a))).toEqual([key]);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });

  it("gives each tenant its own key: another tenant's key cannot open an object", async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 3);
    await store.put(key, enc.encode('tenant A secret'));
    // The same bytes placed under tenant B's prefix are opened with B's key and refused.
    const moved = objectKeys.checkpoint(b, randomUUID(), 3);
    await raw.put(moved, (await raw.get(key)) ?? new Uint8Array());
    await expect(store.get(moved)).rejects.toThrow();
  });

  it('an envelope copied to another object key of the same tenant does not open', async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 4);
    const other = objectKeys.checkpoint(a, randomUUID(), 4);
    await store.put(key, enc.encode('bound to its key'));
    await raw.put(other, (await raw.get(key)) ?? new Uint8Array());
    await expect(store.get(other)).rejects.toBeInstanceOf(SealError);
  });

  it('a tampered or truncated envelope is refused', async () => {
    const key = objectKeys.checkpoint(a, randomUUID(), 5);
    await store.put(key, enc.encode('integrity'));
    const sealed = (await raw.get(key)) ?? new Uint8Array();
    const flipped = new Uint8Array(sealed);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    await raw.put(key, flipped);
    await expect(store.get(key)).rejects.toBeInstanceOf(SealError);
    await raw.put(key, sealed.subarray(0, 10));
    await expect(store.get(key)).rejects.toBeInstanceOf(SealError);
  });

  it("disabling tenant A's key makes A's objects unreadable and leaves tenant B unaffected", async () => {
    const aKey = objectKeys.checkpoint(a, randomUUID(), 6);
    const bKey = objectKeys.checkpoint(b, randomUUID(), 6);
    await store.put(aKey, enc.encode('A'));
    await store.put(bKey, enc.encode('B'));
    await keys.disable(tenantKeyId(a));
    await expect(store.get(aKey)).rejects.toBeInstanceOf(KeyDisabledError);
    expect(dec.decode((await store.get(bKey)) ?? new Uint8Array())).toBe('B');
    // A new write under the disabled key is refused, and nothing is sent.
    const writesBefore = raw.calls.length;
    await expect(
      store.put(objectKeys.checkpoint(a, randomUUID(), 7), enc.encode('x')),
    ).rejects.toBeInstanceOf(KeyDisabledWrite);
    expect(raw.calls.length).toBe(writesBefore);
  });

  it('refuses a key with no tenant prefix', async () => {
    await expect(store.put('docs/x', enc.encode('x'))).rejects.toThrow('no tenant prefix');
    expect(() => tenantOf('tenants/not-a-uuid/x')).toThrow();
  });

  it('provision is idempotent and keeps a disabled key disabled', async () => {
    await store.provision(a);
    expect(await keys.enabled(tenantKeyId(a))).toBe(true);
    await keys.disable(tenantKeyId(a));
    await store.provision(a);
    expect(await keys.enabled(tenantKeyId(a))).toBe(false);
  });
});
