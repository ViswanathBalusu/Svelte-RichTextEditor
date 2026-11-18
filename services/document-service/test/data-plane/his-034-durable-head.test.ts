// HIS-034 criterion 4 (lane w7): the head that `dep.document.changed.v1` publishes is the head of a
// durable commit, never of a tentative one. The room is the real one over the in-memory stores, with
// held log writes (GatedLogStore): a commit whose write is held, or whose write fails, is not durable,
// and nothing is raised for it. The event appears only once the log has stored the commit.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { MemoryEventSink } from '../../src/control-plane/events.ts';
import { MemoryStore } from '../../src/storage/memory.ts';
import { insertText } from './client.ts';
import { GatedLogStore, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

describe('a published head is the head of a durable commit (HIS-034 criterion 4)', () => {
  let plane: Plane;
  const mem = new MemoryStore();
  const gated = new GatedLogStore(mem);
  const raised = new MemoryEventSink();

  beforeAll(async () => {
    plane = await startPlane({
      stores: { logs: gated, ownership: mem, grants: mem, documents: mem },
      deps: { events: raised },
    });
  });
  afterAll(async () => {
    await plane?.close().catch(() => {});
  });

  it('raises nothing while the write is held or after it failed, and the stored head once it is durable', async () => {
    const doc = await plane.createDocument();
    const ref = plane.ref(doc);
    const alice = await plane.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    const changed = () => raised.of('dep.document.changed.v1').filter((e) => e.subject === doc);

    // The commit has reached the room and its write is in flight: it is tentative.
    gated.hold = true;
    const tentative = alice.submit(1, { base: 0, steps: [insertText(intro(), 'one')] });
    await until(() => gated.pending === 1, 3000, 'the write to reach the log');
    expect(changed()).toHaveLength(0);

    // The write fails: nothing was stored, so nothing is published.
    await gated.release({ status: 'failed' });
    await tentative.catch(() => {});
    expect((await plane.stores.logs.state!(ref)).seq).toBe(0);
    expect(changed()).toHaveLength(0);

    // The same edit written for real: the event carries the head the log now holds.
    gated.hold = false;
    const retry = await alice.submit(1, { base: 0, steps: [insertText(intro(), 'one')] });
    expect(retry.t).toBe('sync.ack');
    await until(() => changed().length === 1, 3000, 'the event of the durable commit');
    const head = await plane.stores.logs.state!(ref);
    expect(head.seq).toBe(1);
    expect(changed()[0]).toMatchObject({ data: { seq: 1, chainHead: head.chainHead } });
    expect(plane.errors).toEqual([]);
  });
});
