// SYN-032 criterion 6: the side object of a checkpoint in object storage (06 §8
// `checkpoints/{seq}.side.json.zst`), against the in-memory object store: it is stored under its
// key, read back, and set aside with its checkpoint after a database recovery (BE-078).
import { describe, expect, it } from 'vitest';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { MemoryObjectStore, objectKeys, TenantObjects } from '../../src/objects/store.ts';
import { emptyDocument } from '../../src/control-plane/content.ts';
import { decodeSide, encodeSide } from '../../src/storage/codec.ts';

const ref = {
  tenant: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a00',
  doc: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
};
const side = (seq: number) => ({
  seq,
  threads: [
    {
      id: 'tComment00000001',
      author: 'alice',
      target: { range: { from: 3, to: 9 } },
      seq,
      detached: false,
    },
  ],
});

describe('the side object of a checkpoint in object storage (SYN-032 criterion 6)', () => {
  it('is stored under the side key of its checkpoint and read back', async () => {
    const objects = new MemoryObjectStore();
    const store = new ObjectCheckpointStore(objects);
    await store.put(ref, 4, emptyDocument());
    await store.putSide(ref, 4, encodeSide(side(4)));
    const keys = await new TenantObjects(objects, ref.tenant).list(
      objectKeys.checkpoints(ref.tenant, ref.doc),
    );
    expect(keys).toContain(objectKeys.checkpointSide(ref.tenant, ref.doc, 4));
    expect(decodeSide((await store.getSide(ref, 4))!)).toEqual(side(4));
    expect(await store.getSide(ref, 5)).toBeNull();
    // The checkpoints themselves are still listed by their content objects alone.
    expect((await store.latest(ref, 10))?.seq).toBe(4);
  });

  it('is set aside with its checkpoint, and stays with the checkpoints at or below the head', async () => {
    const objects = new MemoryObjectStore();
    const store = new ObjectCheckpointStore(objects);
    for (const seq of [2, 6]) {
      await store.put(ref, seq, emptyDocument());
      await store.putSide(ref, seq, encodeSide(side(seq)));
    }
    expect(await store.setAside(ref, 3)).toEqual([6]);
    expect(await store.getSide(ref, 6)).toBeNull();
    expect(await store.getSide(ref, 2)).not.toBeNull();
    const aside = await new TenantObjects(objects, ref.tenant).list(
      `${objectKeys.prefix(ref.tenant)}docs/${ref.doc}/aside/`,
    );
    expect(aside.filter((k) => k.endsWith('.side.json.zst'))).toHaveLength(1);
    expect(aside.filter((k) => k.endsWith('.cdm.json.zst'))).toHaveLength(1);
  });
});
