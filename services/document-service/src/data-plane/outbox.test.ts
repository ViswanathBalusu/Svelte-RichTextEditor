/**
 * Delivery of the outbox (BE-039; 06 §3 second bullet, §4.1 `outbox`) against a stand-in room.
 * The room's own checks (its step 2, the log's unique key and the re-check of the room's state)
 * are exercised by the room tests; here the outbox alone is driven: what it hands the room, how it
 * settles an item, what it does after a crash and after the room refuses or cannot take an item.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DocRef, NewOutboxItem, OutboxItem } from '../storage/types.ts';
import { MemoryOutbox } from './memory-ports.ts';
import { Metrics } from './metrics.ts';
import { OutboxDelivery } from './outbox.ts';
import type { RoomHost, ServerOp } from './room-host.ts';
import { settingsFrom } from './settings.ts';
import { Tracer } from './tracing.ts';
import { DataPlaneError, RequestRefused } from './wire.ts';

const REF: DocRef = { tenant: 'tenant-a', doc: 'doc-1' };

/**
 * A room in one function: it appends an author commit when the operation's precondition (the
 * grants revision it was checked against) still holds, refuses it otherwise, and can be told to be
 * unavailable for the next calls. Its log is what the tests look at.
 */
class StandInRoom {
  readonly log: Array<{ id: string; seq: number }> = [];
  readonly ops: ServerOp[] = [];
  revision = 1;
  unavailableFor = 0;

  async apply(_ref: DocRef, op: ServerOp): Promise<{ seq: number }> {
    this.ops.push(op);
    if (this.unavailableFor > 0) {
      this.unavailableFor--;
      throw new DataPlaneError('unavailable', 'the room is busy');
    }
    if (op.kind !== 'author') throw new Error('this stand-in only applies author commits');
    const want = (op.preconditions as { revision?: number } | undefined)?.revision;
    if (want !== undefined && want !== this.revision)
      throw new RequestRefused({
        code: 'conflict',
        action: 'reload',
        reason: 'the grants changed after the request was made',
      });
    const seq = this.log.length + 1;
    this.log.push({ id: op.id, seq });
    return { seq };
  }
}

function restoreItem(commitId: string, revision: number): NewOutboxItem {
  return {
    tenant: REF.tenant,
    doc: REF.doc,
    commitId,
    kind: 'author',
    request: {
      origin: 'restore',
      actor: 'system',
      base: 0,
      steps: [],
      preconditions: { revision },
    },
  };
}

/** A delivery over `store` for `node`; the clock is the store's, so a test moves time itself. */
function deliveryFor(
  store: MemoryOutbox,
  room: StandInRoom,
  node: string,
  onError: (e: unknown, where: string) => void = () => undefined,
): OutboxDelivery {
  return new OutboxDelivery({
    store,
    host: room as unknown as RoomHost,
    node,
    settings: settingsFrom({
      onError,
      outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
    }),
    metrics: new Metrics(node),
    tracer: new Tracer(undefined),
  });
}

const started: OutboxDelivery[] = [];
afterEach(async () => {
  for (const d of started.splice(0)) await d.stop();
});

describe('delivering the outbox (BE-039)', () => {
  it('hands the room a server-authored author commit with its reserved origin, actor and preconditions, and settles it done', async () => {
    const t = 0;
    const store = new MemoryOutbox(() => t);
    const room = new StandInRoom();
    const d = deliveryFor(store, room, 'node-a');
    started.push(d);
    const item = await store.enqueue(restoreItem('0190f0a0-0000-7000-8000-000000000001', 1));

    await d.poll();

    expect(room.ops).toHaveLength(1);
    expect(room.ops[0]).toMatchObject({
      kind: 'author',
      id: '0190f0a0-0000-7000-8000-000000000001',
      origin: 'restore',
      actor: 'system',
      base: 0,
      preconditions: { revision: 1 },
    });
    const settled = await store.get(REF.tenant, item.id);
    expect(settled).toMatchObject({ state: 'done', result: { seq: 1 } });
    expect(d.stats).toMatchObject({ delivered: 1, failed: 0 });
  });

  it('keeps one item per commit identifier and applies it once while it is in flight', async () => {
    const t = 0;
    const store = new MemoryOutbox(() => t);
    const room = new StandInRoom();
    const d = deliveryFor(store, room, 'node-a');
    started.push(d);
    const id = '0190f0a0-0000-7000-8000-000000000002';
    const first = await store.enqueue(restoreItem(id, 1));
    const again = await store.enqueue(restoreItem(id, 1));
    expect(again.id).toBe(first.id);

    await Promise.all([d.poll(), d.poll(), d.deliver((await store.get(REF.tenant, first.id))!)]);

    expect(room.ops).toHaveLength(1);
    expect(room.log).toHaveLength(1);
  });

  it('delivers an item whose node crashed after claiming it, once the lease has run out, and not before', async () => {
    let t = 0;
    const store = new MemoryOutbox(() => t);
    const room = new StandInRoom();
    // Node A wrote the item, claimed it and crashed before it applied or settled the item.
    const item = await store.enqueue(restoreItem('0190f0a0-0000-7000-8000-000000000003', 1));
    const claimed = await store.claim('node-a', 1_000, 20);
    expect(claimed.map((i: OutboxItem) => i.id)).toEqual([item.id]);

    // The restarted node B finds the item locked while the lease runs.
    const b = deliveryFor(store, room, 'node-b');
    started.push(b);
    t = 500;
    await b.poll();
    expect(room.ops).toHaveLength(0);
    expect((await store.get(REF.tenant, item.id))?.state).toBe('pending');

    // After the lease, node B delivers it: none is lost, and the room sees it once.
    t = 1_001;
    await b.poll();
    expect(room.ops).toHaveLength(1);
    expect(room.log).toHaveLength(1);
    expect(await store.get(REF.tenant, item.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
    });
  });

  it('settles an item the room refuses as failed with the rejection, and the requester reads that outcome', async () => {
    const t = 0;
    const store = new MemoryOutbox(() => t);
    const room = new StandInRoom();
    const d = deliveryFor(store, room, 'node-a');
    started.push(d);
    // The request was checked against revision 1; the grants have moved on to revision 2.
    room.revision = 2;
    const item = await store.enqueue(restoreItem('0190f0a0-0000-7000-8000-000000000004', 1));

    const outcome = await d.outcome(item, 2_000);

    expect(outcome).toMatchObject({
      state: 'failed',
      code: 'conflict',
      syncCode: 'conflict',
      action: 'reload',
      message: 'the grants changed after the request was made',
    });
    expect(room.log).toHaveLength(0);
    expect(await store.get(REF.tenant, item.id)).toMatchObject({ state: 'failed' });
  });

  it('gives an item back when the room cannot take it now, and delivers it on the next attempt', async () => {
    const t = 0;
    const store = new MemoryOutbox(() => t);
    const room = new StandInRoom();
    room.unavailableFor = 1;
    const d = deliveryFor(store, room, 'node-a');
    started.push(d);
    const item = await store.enqueue(restoreItem('0190f0a0-0000-7000-8000-000000000005', 1));

    await d.poll();
    expect(await store.get(REF.tenant, item.id)).toMatchObject({ state: 'pending', attempts: 1 });
    expect(room.log).toHaveLength(0);
    expect(d.stats.retried).toBe(1);

    await d.poll();
    expect(await store.get(REF.tenant, item.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
      attempts: 2,
    });
    expect(room.log).toHaveLength(1);
  });
});
