// FRW-009 criterion 5 over PostgreSQL (lane U-FRW-001-018): a server-set value request that is
// claimed by a node, applied to the log, and then the node stops before it settles the item. After
// the lease expires another node claims the item again and delivers it; the deterministic commit
// identifier makes the effect exactly once. Skips when PostgreSQL is not up:
// pwsh -NoProfile -File infra/test-env.ps1 up
import { uuid7 } from '@docedit/model';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { OutboxDelivery, opOf } from '../../src/data-plane/outbox.ts';
import { PgOutbox } from '../../src/data-plane/pg/outbox.ts';
import { Metrics } from '../../src/data-plane/metrics.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { Tracer } from '../../src/data-plane/tracing.ts';
import type { NewOutboxItem } from '../../src/storage/types.ts';
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
  'FRW-009 criterion 5 over PostgreSQL: the node stops between the outbox and the log (U-FRW-001-018)',
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

    function prefill(tenant: string, doc: string, commitId: string, text: string): NewOutboxItem {
      return {
        tenant,
        doc,
        commitId,
        kind: 'author',
        request: {
          origin: 'prefill',
          actor: 'system',
          base: 0,
          steps: [insertText(intro(), text)],
          preconditions: { head: 0 },
        },
      };
    }

    it('stores the commit once when the first node stops after the log write and before settling', async () => {
      const tenant = newTenant();
      const p = await pgPlane(tenant);
      const doc = await p.createDocument();
      const ref = p.ref(doc);
      const commitId = uuid7();
      const item = await outbox.enqueue(prefill(tenant, doc, commitId, 'Crashed once'));

      // Node A claims the item with a short lease, applies it to the log, and stops: no settle.
      const claimed = await outbox.claim('node-a', 50, 20);
      expect(claimed.map((i) => i.id)).toEqual([item.id]);
      const op = opOf(claimed[0]!);
      expect(op).not.toBeNull();
      const applied = await p.plane.host.apply(ref, op!);
      expect(applied.seq).toBe(1);
      expect(await outbox.get(tenant, item.id)).toMatchObject({ state: 'pending' });

      // The lease runs out; node B takes the item over and delivers it again.
      await new Promise((r) => setTimeout(r, 150));
      await deliveryFor(p, 'node-b').poll();

      expect(await outbox.get(tenant, item.id)).toMatchObject({
        state: 'done',
        result: { seq: 1 },
      });
      const stored = await p.stores.logs.read(ref);
      expect(stored.filter((c) => c.id === commitId)).toHaveLength(1);
      expect(stored).toHaveLength(1);
      expect(p.errors).toEqual([]);
    });
  },
);
