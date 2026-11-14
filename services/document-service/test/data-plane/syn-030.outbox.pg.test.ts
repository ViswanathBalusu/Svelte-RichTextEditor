// SYN-030 criterion 3 over PostgreSQL (lane U-SYN-019-036): the request the control plane writes to
// the outbox carries a deterministic commit id and the preconditions it relied on; the room that
// applies it re-checks those preconditions. The memory version is be-039-outbox-room.test.ts. Here
// the outbox is the PostgreSQL table (pg/outbox.ts), delivered into a room over the PostgreSQL log.
// Skips when PostgreSQL is not up: pwsh -NoProfile -File infra/test-env.ps1 up
import { uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { OutboxDelivery } from '../../src/data-plane/outbox.ts';
import { PgOutbox } from '../../src/data-plane/pg/outbox.ts';
import { Metrics } from '../../src/data-plane/metrics.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { Tracer } from '../../src/data-plane/tracing.ts';
import type { DocRef, NewOutboxItem } from '../../src/storage/types.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'SYN-030 criterion 3 over PostgreSQL: the outbox into a room (U-SYN-019-036)',
  () => {
    let db: TestDatabase;
    let outbox: PgOutbox;
    let plane: Plane | undefined;
    const deliveries: OutboxDelivery[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
      outbox = new PgOutbox(db.service);
    });
    afterEach(async () => {
      for (const d of deliveries.splice(0)) await d.stop();
      await plane?.close();
      plane = undefined;
    });
    afterAll(async () => {
      await db?.drop();
    });

    async function pgPlane(tenant: string): Promise<Plane> {
      const s = pgStores(db.service);
      plane = await startPlane({
        stores: { logs: s.logs, ownership: s.logs, grants: s.grants, documents: s.docs },
        tenant,
      });
      return plane;
    }

    function deliveryFor(p: Plane, node: string): OutboxDelivery {
      const d = new OutboxDelivery({
        store: outbox,
        host: p.plane.host,
        node,
        settings: settingsFrom({
          onError: (e) => p.errors.push(e),
          outbox: { pollMs: 60_000, leaseMs: 1_000, batch: 20 },
        }),
        metrics: new Metrics(node),
        tracer: new Tracer(undefined),
      });
      deliveries.push(d);
      return d;
    }

    /** A control-plane request: a prefill commit with its id and the preconditions relied on. */
    function prefill(
      ref: DocRef,
      commitId: string,
      text: string,
      preconditions: { head?: number },
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
          preconditions,
        },
      };
    }

    it('applies the request with its id, origin and preconditions, and settles it done; the preconditions are stored as requested', async () => {
      const tenant = newTenant();
      const p = await pgPlane(tenant);
      const doc = await p.createDocument();
      const ref = p.ref(doc);
      const commitId = uuid7();
      const item = await outbox.enqueue(prefill(ref, commitId, 'Prefilled', { head: 0 }));
      expect(item.request).toMatchObject({ preconditions: { head: 0 } });

      await deliveryFor(p, 'node-a').poll();

      expect(await outbox.get(tenant, item.id)).toMatchObject({
        state: 'done',
        result: { seq: 1 },
      });
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

    it('re-checks a precondition the control plane relied on: when the head has moved, nothing is stored and the requester reads the failure', async () => {
      const tenant = newTenant();
      const p = await pgPlane(tenant);
      const doc = await p.createDocument();
      const ref = p.ref(doc);
      // A client commit moves the head to 1 after the control plane looked at head 0.
      const alice = await p.client('alice', { [doc]: 'owner' });
      await alice.open(1, doc);
      expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'typed')] })).t).toBe(
        'sync.ack',
      );
      const commitId = uuid7();
      const item = await outbox.enqueue(prefill(ref, commitId, 'Prefilled', { head: 0 }));

      await deliveryFor(p, 'node-a').poll();

      const settled = await outbox.get(tenant, item.id);
      expect(settled?.state).toBe('failed');
      expect(settled?.result).toMatchObject({ code: 'conflict' });
      // Only the client's commit is stored; the server-authored one is not.
      const stored = await p.stores.logs.read(ref);
      expect(stored.map((c) => c.id)).not.toContain(commitId);
      expect(stored).toHaveLength(1);
    });

    it('stores one commit when the same request is delivered twice, by the poll and again, with the same deterministic id', async () => {
      const tenant = newTenant();
      const p = await pgPlane(tenant);
      const doc = await p.createDocument();
      const ref = p.ref(doc);
      const commitId = uuid7();
      const item = await outbox.enqueue(prefill(ref, commitId, 'Once', { head: 0 }));

      // The control plane's retry after a crash enqueues the same deterministic commit: same item.
      const again = await outbox.enqueue(prefill(ref, commitId, 'Once', { head: 0 }));
      expect(again.id).toBe(item.id);

      await deliveryFor(p, 'node-a').poll();
      // Delivered again directly, as a redelivery after a lost answer: the room answers it as stored.
      const settled = (await outbox.get(tenant, item.id))!;
      await deliveryFor(p, 'node-b').deliver(settled);

      expect(await outbox.get(tenant, item.id)).toMatchObject({
        state: 'done',
        result: { seq: 1 },
      });
      const stored = await p.stores.logs.read(ref);
      expect(stored.filter((c) => c.id === commitId)).toHaveLength(1);
      expect(stored).toHaveLength(1);
    });
  },
);
