/**
 * BE-039 (lane BE-027-039, round 2): the outbox delivered into the real data plane. `outbox.test.ts`
 * drives the outbox against a stand-in room; here `OutboxDelivery` hands each item to the real
 * `RoomHost.apply` over the in-memory stores, so the room's own step 2 (deduplication by commit
 * identifier), its re-check of the preconditions the control plane relied on, and its stored log are
 * what the criteria are checked against. No PostgreSQL and no browser is used.
 */
import { uuid7, type JsonEnvelope } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_JSON, baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText } from '../../test/data-plane/client.ts';
import { REQUIRES, startPlane, type Plane } from '../../test/data-plane/support.ts';
import type { DocRef, NewOutboxItem } from '../storage/types.ts';
import { MemoryOutbox } from './memory-ports.ts';
import { Metrics } from './metrics.ts';
import { OutboxDelivery } from './outbox.ts';
import { settingsFrom } from './settings.ts';
import { Tracer } from './tracing.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(): Promise<Plane> {
  const p = await startPlane();
  planes.push(p);
  return p;
}
const started: OutboxDelivery[] = [];
afterEach(async () => {
  for (const d of started.splice(0)) await d.stop();
  for (const p of planes) await p.close();
  planes = [];
});

/** An outbox item for a server-authored step commit (origin `prefill`, actor `system`). */
function prefillItem(
  ref: DocRef,
  commitId: string,
  text: string,
  preconditions?: { head?: number; revision?: number },
): NewOutboxItem {
  return {
    tenant: ref.tenant,
    doc: ref.doc,
    commitId,
    kind: 'author',
    request: {
      origin: 'prefill',
      actor: 'system',
      base: 0,
      steps: [insertText(intro(), text)],
      ...(preconditions ? { preconditions } : {}),
    },
  };
}

function deliveryFor(store: MemoryOutbox, p: Plane, node: string): OutboxDelivery {
  const d = new OutboxDelivery({
    store,
    host: p.plane.host,
    node,
    settings: settingsFrom({
      onError: (e) => p.errors.push(e),
      outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
    }),
    metrics: new Metrics(node),
    tracer: new Tracer(undefined),
  });
  started.push(d);
  return d;
}

describe('the outbox delivered into the real data plane (BE-039)', () => {
  it('applies a server-authored commit with its reserved origin and the preconditions re-checked, and settles it done', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const store = new MemoryOutbox(() => 0);
    const d = deliveryFor(store, p, 'node-a');
    const commitId = uuid7();
    const item = await store.enqueue(prefillItem(ref, commitId, 'Prefilled', { head: 0 }));

    await d.poll();

    // The head was 0 when the control plane checked, so the room accepts the commit at seq 1.
    expect(await store.get(ref.tenant, item.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
    });
    expect((await p.stores.logs.head(ref)).seq).toBe(1);
    const [stored] = await p.stores.logs.read(ref, 1, 1);
    expect(stored).toMatchObject({
      seq: 1,
      id: commitId,
      kind: 'steps',
      user: 'system',
      origin: 'prefill',
    });
    expect(p.errors).toEqual([]);
  });

  it('stores one commit when the same item is delivered twice, by the poll and by a direct delivery', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const store = new MemoryOutbox(() => 0);
    const d = deliveryFor(store, p, 'node-a');
    const commitId = uuid7();
    // The item carries a head precondition, as server-authored commits usually do. Once it is
    // stored the head is 1, so a redelivery passes only because step 2 (deduplication) comes first.
    const first = await store.enqueue(prefillItem(ref, commitId, 'Once', { head: 0 }));
    // A second enqueue of the same deterministic commit identifier is the same item.
    const again = await store.enqueue(prefillItem(ref, commitId, 'Once', { head: 0 }));
    expect(again.id).toBe(first.id);

    await d.poll();
    expect(await store.get(ref.tenant, first.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
    });
    // The same item is handed to the room again, as a retry after a crash between apply and settle
    // would; the room answers with the stored seq and stores nothing new.
    const settled = await store.get(ref.tenant, first.id);
    const redelivered = await d.deliver(settled!);
    expect(redelivered).toEqual({ state: 'done', seq: 1 });
    await expect(
      p.plane.host.apply(ref, {
        kind: 'author',
        id: commitId,
        origin: 'prefill',
        actor: 'system',
        base: 0,
        steps: [insertText(intro(), 'Once')],
        preconditions: { head: 0 },
      }),
    ).resolves.toMatchObject({ seq: 1 });

    expect((await p.stores.logs.head(ref)).seq).toBe(1);
    expect(await p.stores.logs.read(ref, 1, 5)).toHaveLength(1);
    expect(p.errors).toEqual([]);
  });

  it('stores no commit when a precondition no longer holds, marks the item failed, and the requester reads that outcome', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const store = new MemoryOutbox(() => 0);
    const d = deliveryFor(store, p, 'node-a');
    // The control plane checked the head when it was 5; the document is at 0, so the room refuses.
    const item = await store.enqueue(prefillItem(ref, uuid7(), 'Refused', { head: 5 }));

    const outcome = await d.outcome(item, 2_000);

    expect(outcome).toMatchObject({
      state: 'failed',
      syncCode: 'conflict',
      action: 'drop',
    });
    expect(outcome.state === 'failed' && outcome.message).toContain(
      'a precondition no longer holds',
    );
    expect(await store.get(ref.tenant, item.id)).toMatchObject({ state: 'failed' });
    expect((await p.stores.logs.head(ref)).seq).toBe(0);
    expect(await p.stores.logs.read(ref, 1, 5)).toHaveLength(0);
    expect(p.plane.host.rooms).toHaveLength(0);
  });

  it('settles a redelivered snapshot that carries a head precondition as done at its stored seq', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const ref = p.ref(doc);
    const store = new MemoryOutbox(() => 0);
    const d = deliveryFor(store, p, 'node-a');
    const envelope = {
      cdm: 1,
      requires: [...REQUIRES],
      doc: structuredClone(BASE_JSON),
    } as unknown as JsonEnvelope;
    const encoded = await p.plane.host.encode(envelope);
    const item = await store.enqueue({
      tenant: ref.tenant,
      doc: ref.doc,
      commitId: uuid7(),
      kind: 'snapshot',
      request: { reason: 'import', actor: 'system', preconditions: { head: 0 } },
      payload: encoded.encoded,
    });

    await d.poll();
    expect(await store.get(ref.tenant, item.id)).toMatchObject({
      state: 'done',
      result: { seq: 1 },
    });
    // A crash between apply and settle hands the item to the room again. The snapshot moved the
    // head to 1 itself, so the room must find it in step 2 rather than refuse it with conflict.
    const settled = await store.get(ref.tenant, item.id);
    expect(await d.deliver(settled!)).toEqual({ state: 'done', seq: 1 });
    expect((await p.stores.logs.head(ref)).seq).toBe(1);
    expect(await p.stores.logs.read(ref, 1, 5)).toHaveLength(1);
    expect(p.errors).toEqual([]);
  });
});
