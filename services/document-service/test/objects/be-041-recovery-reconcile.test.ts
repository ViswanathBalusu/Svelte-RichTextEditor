// BE-041 criterion 4: a database recovery and an object store that disagree are reconciled from the
// log by the procedure of BE-078, for a tenant whose objects are sealed with its own key. The log is
// the source of truth: what the store holds past the restored head is set aside, still sealed, and
// the document is rebuilt from the log and the checkpoints below the head. Memory stores and the real
// data plane, with the object store behind `OptInTenantSealStore`.
import { randomUUID } from 'node:crypto';
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { affectedAmong, rebuild, runIncarnation } from '../../src/data-plane/recovery.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { OptInTenantSealStore } from '../../src/objects/opt-in-seal-store.ts';
import { ObjectSegmentStore } from '../../src/objects/segments.ts';
import { MemoryObjectStore, objectKeys } from '../../src/objects/store.ts';
import { MemoryKeyService } from '../../src/storage/key-service.ts';
import type { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from '../data-plane/client.ts';
import { BASE_JSON, REQUIRES, startPlane, type Plane } from '../data-plane/support.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('database recovery against sealed objects (BE-041 criterion 4, BE-078)', () => {
  it('reconciles from the log: objects past the restored head are set aside, sealed, and the document is rebuilt from the log', async () => {
    const tenant = randomUUID();
    const raw = new MemoryObjectStore();
    const sealed = new OptInTenantSealStore(raw, new MemoryKeyService(), [tenant]);
    await sealed.provision();
    const checkpoints = new ObjectCheckpointStore(sealed);
    const segments = new ObjectSegmentStore(sealed);

    const p = await startPlane({ tenant, deps: { checkpoints } });
    planes.push(p);
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    await checkpoints.put(ref, 0, (await p.checkpoints.get(ref, 0))!);
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    for (let i = 0; i < 3; i++) {
      const r = await a.submit(1, { base: i, steps: [insertText(intro(), `t${i}`)] });
      expect(r.t).toBe('sync.ack');
    }
    await p.close();
    planes = [];

    // The database was restored to seq 1, but the object store still holds what was written up to
    // seq 3: a checkpoint at 3 and a cold segment of 1 to 3, both sealed with the tenant's key.
    const content: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    };
    await checkpoints.put(ref, 3, content);
    await sealed.put(
      objectKeys.segment(tenant, doc, 1, 3),
      enc.encode('segment bytes, in plain words'),
    );
    const logs = p.stores.logs as unknown as Parameters<typeof rebuild>[0]['logs'];
    const stores = { logs, checkpoints, segments };
    const hashAt1 = (await rebuild(stores, ref, 1)).hash;
    (p.stores.logs as MemoryStore).rewindForTest(ref, 1);

    // In the bucket the objects past the head are sealed, not plain.
    const rawCheckpoint = await raw.get(objectKeys.checkpoint(tenant, doc, 3));
    expect(
      Buffer.compare(rawCheckpoint!, (await sealed.get(objectKeys.checkpoint(tenant, doc, 3)))!),
    ).not.toBe(0);
    const rawSegment = await raw.get(objectKeys.segment(tenant, doc, 1, 3));
    expect(dec.decode(rawSegment!)).not.toContain('segment bytes');

    // The store and the database disagree; the dry run names the document and changes nothing.
    const selected = await affectedAmong(stores, [ref]);
    expect(selected).toEqual([
      { tenant, doc, head: 1, checkpoint: 3, segments: [{ from: 1, to: 3 }] },
    ]);
    expect(await runIncarnation(stores, selected, { dryRun: true })).toEqual([]);
    expect(await raw.exists(objectKeys.checkpoint(tenant, doc, 3))).toBe(true);

    const before = (await p.stores.logs.head(ref)).incarnation;
    const audit = new MemoryAudit();
    const [change] = await runIncarnation({ ...stores, audit }, selected, {
      dryRun: false,
      actor: 'operator',
    });
    expect(change!.setAside).toEqual([3]);
    expect(change!.segmentsSetAside).toEqual([{ from: 1, to: 3 }]);
    expect((await p.stores.logs.head(ref)).incarnation).not.toBe(before);

    // Nothing past the head is used any more: the store lists no checkpoint 3 and no segment 1-3.
    expect(await checkpoints.get(ref, 3)).toBeNull();
    expect(await raw.exists(objectKeys.checkpoint(tenant, doc, 3))).toBe(false);
    expect(await raw.exists(objectKeys.segment(tenant, doc, 1, 3))).toBe(false);
    // What was set aside is kept under `aside`, still sealed in the bucket and readable with the key.
    const aside = (await raw.list(`tenants/${tenant}/docs/${doc}/aside/`)).sort();
    // The checkpoint (body and side file) and the segment.
    expect(aside).toHaveLength(3);
    for (const key of aside) {
      const bytes = (await raw.get(key))!;
      // The bucket holds the sealed form, which is not what the tenant's key opens it to.
      const opened = (await sealed.get(key))!;
      expect(opened).not.toBeNull();
      expect(Buffer.compare(bytes, opened)).not.toBe(0);
    }
    const segmentAside = aside.find((k) => k.includes('/segments/'))!;
    expect(dec.decode((await sealed.get(segmentAside))!)).toBe('segment bytes, in plain words');

    // The log decides: the document is rebuilt to the restored head, with the hash it had at seq 1.
    const rebuilt = await rebuild(stores, ref);
    expect(rebuilt.seq).toBe(1);
    expect(rebuilt.hash).toBe(hashAt1);
    // And the incarnation change is audited.
    const events = await audit.query(tenant, { doc, limit: 10 });
    expect(events.map((e) => e.kind)).toContain('incarnation.changed');
  });
});
