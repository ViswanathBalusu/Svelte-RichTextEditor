/**
 * The side object of a checkpoint (HIS-014; ADR 0377): stored beside the checkpoint, read back,
 * and set aside with it when a recovery rewinds the log (BE-078). Over the in-memory object store.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emptyDocument } from '../control-plane/content.ts';
import { ObjectCheckpointStore } from './checkpoints.ts';
import { MemoryObjectStore, objectKeys, TenantObjects } from './store.ts';

describe('the side object of a checkpoint', () => {
  it('is stored under the side key, read back, and set aside with its checkpoint', async () => {
    const objects = new MemoryObjectStore();
    const store = new ObjectCheckpointStore(objects);
    const ref = { tenant: randomUUID(), doc: randomUUID() };
    const content = emptyDocument();
    await store.put(ref, 0, content);
    await store.put(ref, 5, content);
    await store.putSide(ref, 5, new Uint8Array([1, 2, 3]));
    expect(await store.getSide(ref, 4)).toBeNull();
    expect([...(await store.getSide(ref, 5))!]).toEqual([1, 2, 3]);
    const tenantObjects = new TenantObjects(objects, ref.tenant);
    expect(await tenantObjects.exists(objectKeys.checkpointSide(ref.tenant, ref.doc, 5))).toBe(
      true,
    );

    expect(await store.setAside(ref, 2)).toEqual([5]);
    expect(await store.getSide(ref, 5)).toBeNull();
    expect(await store.get(ref, 5)).toBeNull();
    // Checkpoint 0 and its listing are untouched.
    expect(await store.get(ref, 0)).not.toBeNull();
  });
});
