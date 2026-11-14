/**
 * SEC-042 criterion 3: a sealed PDF is stored once. The store is the document service's object
 * store (`MemoryObjectStore` behind `AssetStore.putSealed`, the write that holds the final PDF under
 * `tenants/{tenant}/docs/{doc}/final/...`). The write is `ifAbsent`, so a second write to the same
 * key is refused with `ObjectExistsError` and the first bytes stay.
 *
 * Not proved here: criteria 1, 2, 4 and 5 (the bundle pinned to the completion `seq` and chain head,
 * the two-worker comparison, the hash handed to the signing service, and incremental long-term
 * validation data), which need the completion log, two compiling workers and the signing service.
 */
import { randomUUID } from 'node:crypto';
import { AssetStore, MemoryObjectStore, ObjectExistsError } from '@docedit/document-service';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

describe('SEC-042 criterion 3: a second write to the key of a sealed PDF is refused', () => {
  it('refuses the second write with ObjectExistsError and keeps the first bytes', async () => {
    const assets = new AssetStore(new MemoryObjectStore());
    const tenant = randomUUID();
    const doc = randomUUID();
    const workflow = randomUUID();
    const first = new TextEncoder().encode('%PDF-1.7 first sealed output');
    const second = new TextEncoder().encode('%PDF-1.7 a changed page');

    await assets.putSealed(tenant, doc, workflow, first);
    await expect(assets.putSealed(tenant, doc, workflow, second)).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
    expect(await assets.getSealed(tenant, doc, workflow)).toEqual(first);
  });

  it('refuses a second write of any bytes, the same bytes included, under the same key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        async (a, b) => {
          const assets = new AssetStore(new MemoryObjectStore());
          const tenant = randomUUID();
          const doc = randomUUID();
          const workflow = randomUUID();
          await assets.putSealed(tenant, doc, workflow, a);
          await expect(assets.putSealed(tenant, doc, workflow, b)).rejects.toBeInstanceOf(
            ObjectExistsError,
          );
          expect(await assets.getSealed(tenant, doc, workflow)).toEqual(a);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('control: the refusal is by key, so another workflow or another tenant may hold its own sealed PDF', async () => {
    const assets = new AssetStore(new MemoryObjectStore());
    const tenant = randomUUID();
    const other = randomUUID();
    const doc = randomUUID();
    const workflow = randomUUID();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    await assets.putSealed(tenant, doc, workflow, a);
    await expect(assets.putSealed(tenant, doc, randomUUID(), b)).resolves.toBeUndefined();
    await expect(assets.putSealed(other, doc, workflow, b)).resolves.toBeUndefined();
    expect(await assets.getSealed(tenant, doc, workflow)).toEqual(a);
  });
});
