/**
 * SEC-045 criteria 4 and 6 at the object layer (10 §3.7, §1; 06 §4.2, §12). The objects of one
 * tenant are sealed under that tenant's key (BE-041), so an operator or an attacker with write access
 * to the bucket who moves tenant A's sealed bytes under tenant B's prefix gains no plaintext: B's
 * key cannot unwrap A's data key, and the object key is bound to the sealed bytes as additional
 * data. The encrypted adapter is imported from its source because the document service's index does
 * not export it (ADR 0121 asks for the export).
 *
 * Criterion 4 (signed URLs) is not ticked: the in-memory and S3 stores sign URLs but no verifier
 * exists in the service to check that a URL for tenant A's key fails on tenant B's key. See the
 * story's Notes.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryObjectStore, objectKeys, TenantObjects } from '@docedit/document-service';
import {
  EncryptedObjectStore,
  tenantKeyId,
} from '../../../services/document-service/src/objects/encrypted-store.ts';
import { MemoryKeyService } from '../../../services/document-service/src/storage/key-service.ts';

const enc = new TextEncoder();

describe('SEC-045 sealed objects of one tenant do not open under another (memory)', () => {
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

  it("tenant A's sealed object moved under tenant B's prefix cannot be opened with B's key", async () => {
    const doc = randomUUID();
    const keyA = objectKeys.checkpoint(a, doc, 3);
    const keyB = objectKeys.checkpoint(b, doc, 3);
    const secret = enc.encode('tenant A: the private contract text');
    await store.put(keyA, secret);
    // The attacker copies the sealed bytes of A's object to a key of B, bypassing the adapter.
    const sealed = await raw.get(keyA);
    await raw.put(keyB, sealed ?? new Uint8Array());
    // Reading it as B fails: B's key cannot unwrap A's data key, so nothing is returned.
    await expect(store.get(keyB)).rejects.toThrow();
    // A still reads its own object, so the attack changed nothing for A.
    expect(await store.get(keyA)).toEqual(secret);
  });

  it('the object key is bound to the sealed bytes, so moving an object within a tenant fails too', async () => {
    const doc = randomUUID();
    const keyA = objectKeys.checkpoint(a, doc, 4);
    const otherA = objectKeys.checkpoint(a, doc, 5);
    await store.put(keyA, enc.encode('one object'));
    await raw.put(otherA, (await raw.get(keyA)) ?? new Uint8Array());
    await expect(store.get(otherA)).rejects.toThrow();
  });

  it("tenant B's unwrap key refuses A's wrapped data key directly", async () => {
    const keyA = objectKeys.checkpoint(a, randomUUID(), 1);
    await store.put(keyA, enc.encode('x'));
    const sealed = (await raw.get(keyA)) ?? new Uint8Array();
    // Layout of encrypted-store.ts: version (1), wrapped length (2), wrapped data key, IV, ciphertext.
    const wrappedLength = new DataView(
      sealed.buffer,
      sealed.byteOffset,
      sealed.byteLength,
    ).getUint16(1);
    const wrapped = sealed.subarray(3, 3 + wrappedLength);
    await expect(keys.unwrap(tenantKeyId(b), wrapped)).rejects.toThrow();
    expect(await keys.unwrap(tenantKeyId(a), wrapped)).toBeInstanceOf(Uint8Array);
  });

  it('for any body and any pair of tenants, a moved object yields no plaintext (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.integer({ min: 0, max: 1000 }),
        async (body, seq) => {
          const doc = randomUUID();
          const keyA = objectKeys.checkpoint(a, doc, seq);
          const keyB = objectKeys.checkpoint(b, doc, seq);
          await store.put(keyA, body);
          await raw.put(keyB, (await raw.get(keyA)) ?? new Uint8Array());
          let opened: Uint8Array | null;
          try {
            opened = await store.get(keyB);
          } catch {
            opened = null;
          }
          expect(opened).toBeNull();
        },
      ),
      { numRuns: 25 },
    );
  });

  it('a disabled key of tenant B leaves tenant A readable (the other direction of criterion 6)', async () => {
    const keyA = objectKeys.checkpoint(a, randomUUID(), 2);
    const body = enc.encode('still A');
    await store.put(keyA, body);
    await keys.disable(tenantKeyId(b));
    expect(await store.get(keyA)).toEqual(body);
  });

  it('a tenant prefix cannot be reached through TenantObjects with another tenant key (criterion 2 guard)', async () => {
    const view = new TenantObjects(store, a);
    await expect(
      view.put(objectKeys.checkpoint(b, randomUUID(), 0), enc.encode('x')),
    ).rejects.toThrow();
    expect(raw.calls.filter((c) => c.includes(`tenants/${b}/`))).toEqual([]);
  });
});
