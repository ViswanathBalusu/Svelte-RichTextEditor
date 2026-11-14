/**
 * A new incarnation after a database recovery (BE-078 criteria 2, 3 and 5; 04 §9; 06 §8). The
 * procedure of `recovery.ts` (`affectedAmong`, `runIncarnation`) runs on the in-memory stores of the
 * real data plane. The plane is then closed and started again over the same stores, as after a
 * restart, and a client that holds the old incarnation, or a `seq` above the head, must reload.
 *
 * Not covered here: the dry run over PostgreSQL (`affected`, BE-078 criterion 1), and the ETag over
 * HTTP, which is built by the control plane (`src/control-plane/content.ts`) and whose test needs
 * PostgreSQL (`test/control-plane/routes.content.test.ts`).
 */
import type { JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import {
  BASE_JSON,
  REQUIRES,
  memoryStores,
  startPlane,
  type Plane,
  type Stores,
} from '../../test/data-plane/support.ts';
import { ObjectCheckpointStore } from '../objects/checkpoints.ts';
import { MemoryObjectStore } from '../objects/store.ts';
import { MemoryAudit, MemoryCheckpointIndex } from './memory-ports.ts';
import {
  affectedAmong,
  runIncarnation,
  type Incarnating,
  type RecoveryStores,
} from './recovery.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const NOW = 1_700_000_000_000;

let open: Plane[] = [];
afterEach(async () => {
  for (const p of open) await p.close();
  open = [];
});

/** A plane over `stores` and the object-store checkpoints, started (again) for one test. */
async function start(
  stores: Stores,
  objects: ObjectCheckpointStore,
  tenant?: string,
): Promise<Plane> {
  const p = await startPlane({
    stores,
    deps: { checkpoints: objects },
    ...(tenant !== undefined ? { tenant } : {}),
  });
  open.push(p);
  return p;
}

describe('a new incarnation makes the old clients reload (BE-078 criteria 2, 3 and 5)', () => {
  it('sets the checkpoint past the head aside, audits it, and reloads every old client', async () => {
    const stores = memoryStores();
    const objects = new ObjectCheckpointStore(new MemoryObjectStore());
    const index = new MemoryCheckpointIndex();
    const audit = new MemoryAudit();
    const content: JsonEnvelope = {
      cdm: 1,
      requires: REQUIRES,
      doc: BASE_JSON as JsonEnvelope['doc'],
    };

    // Before the recovery: a document at head 3, read and written by alice.
    const p1 = await startPlane({ stores, deps: { checkpoints: objects } });
    const doc = await p1.createDocument();
    const ref = p1.ref(doc);
    await objects.put(ref, 0, (await p1.checkpoints.get(ref, 0)) as JsonEnvelope);
    const alice1 = await p1.client('alice', { [doc]: 'owner' });
    const first = await alice1.open(1, doc);
    const before = first.d!['incarnation'] as string;
    const view = first.d!['view'] as string;
    for (let i = 0; i < 3; i++) {
      const r = await alice1.submit(1, { base: i, steps: [insertText(intro(), `t${i}`)] });
      expect(r.t).toBe('sync.ack');
    }
    const identity1 = p1.tokens.identity(
      p1.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }),
    );
    const etagBefore = await p1.plane.readContent(identity1, doc, 0).then((c) => {
      return `"${c.incarnation}.${c.seq}.${c.view}"`;
    });
    await p1.close();

    // The restored database still holds a checkpoint at 5 in the object store, past the head 3.
    await objects.put(ref, 5, content);
    await index.record(ref, { seq: 5, key: 'k5', bytes: 1, hash: 'h5' });

    // The incarnation command, with the selection of the documents it changes.
    const recovery: RecoveryStores & { logs: Incarnating } = {
      logs: stores.logs as Incarnating,
      checkpoints: objects,
      index,
      audit,
    };
    const selected = await affectedAmong(recovery, [ref]);
    expect(selected).toEqual([{ tenant: p1.tenant, doc, head: 3, checkpoint: 5 }]);
    const [change] = await runIncarnation(recovery, selected, {
      dryRun: false,
      actor: 'operator',
      now: () => NOW,
    });
    expect(change).toBeDefined();

    // Criterion 2: a new incarnation, the checkpoint past the head set aside, and an audit event.
    expect(change!.before).toBe(before);
    expect(change!.after).not.toBe(before);
    expect((await stores.logs.head(ref)).incarnation).toBe(change!.after);
    expect(change!.setAside).toEqual([5]);
    expect(await objects.get(ref, 5)).toBeNull();
    expect((await index.list(ref)).map((r) => r.seq)).not.toContain(5);
    const events = await audit.query(p1.tenant, { doc, kind: 'incarnation.changed', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: 'operator',
      at: NOW,
      data: { before, after: change!.after, head: 3, setAside: [5] },
    });

    // The service starts again over the same stores.
    const p2 = await start(stores, objects, p1.tenant);
    const alice2 = await p2.client('alice', { [doc]: 'owner' });
    const fresh = await alice2.open(1, doc);
    expect(fresh.d!['incarnation']).toBe(change!.after);
    expect(fresh.d!['head']).toBe(3);

    // Criterion 3: a client with the old incarnation reloads, at its old seq or below the head.
    const oldAtHead = await p2.client('alice', { [doc]: 'owner' });
    const reloadA = await oldAtHead.open(1, doc, { resume: { seq: 3, incarnation: before, view } });
    expect(reloadA.t).toBe('ch.opened');
    expect(reloadA.d!['catchUp']).toBe('reload');
    const oldBelow = await p2.client('alice', { [doc]: 'owner' });
    const reloadB = await oldBelow.open(1, doc, { resume: { seq: 1, incarnation: before, view } });
    expect(reloadB.d!['catchUp']).toBe('reload');

    // A `seq` above the head reloads too, under the new incarnation.
    const above = await p2.client('alice', { [doc]: 'owner' });
    const reloadC = await above.open(1, doc, {
      resume: { seq: 4, incarnation: change!.after, view: fresh.d!['view'] as string },
    });
    expect(reloadC.d!['catchUp']).toBe('reload');

    // Criterion 5: a content read after the change carries the new incarnation, so its ETag
    // (incarnation, seq and view, as content.ts builds it) differs from the one before.
    const identity2 = p2.tokens.identity(
      p2.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }),
    );
    const after = await p2.plane.readContent(identity2, doc, 0);
    expect(after.incarnation).toBe(change!.after);
    expect(`"${after.incarnation}.${after.seq}.${after.view}"`).not.toBe(etagBefore);
  });
});
