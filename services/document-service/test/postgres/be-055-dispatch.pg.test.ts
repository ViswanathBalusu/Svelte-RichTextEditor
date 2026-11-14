// BE-055 criterion 1 on PostgreSQL (lane U-BE-043-056): an event that matches two subscriptions
// creates one delivery row per subscription in the `webhook_deliveries` table, and each row ends
// delivered with the webhook-id the request carried; the request is a CloudEvents 1.0 structured
// JSON body signed with the subscription's secret. The delivery store is PgDeliveryStore over a
// database this test creates and drops; the subscriptions are in memory (their table is not part of
// this criterion) and the transport is a fake that stands for the egress proxy of BE-056.
// Skips, with the reason, when PostgreSQL is not up (infra/test-env.ps1 up).
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from '../../src/control-plane/events.ts';
import {
  PgDeliveryStore,
  WEBHOOK_DELIVERIES_DDL,
} from '../../src/control-plane/webhook-deliveries-pg.ts';
import { WebhookDispatcher } from '../../src/control-plane/webhook-dispatcher.ts';
import type { Transport, TransportResult } from '../../src/control-plane/webhook-egress.ts';
import { generateSecret, verifyDelivery } from '../../src/control-plane/webhook-signing.ts';
import {
  MemorySubscriptionStore,
  type SubscriptionRecord,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`be-055-dispatch: skipped: ${unavailable}`);

const TENANT = 't-u-be-043-056-dispatch';
const SOURCE = 'https://docs.example.test/events';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

describe.skipIf(unavailable !== null)(
  'BE-055 criterion 1 on PostgreSQL: a delivery row per matching subscription',
  () => {
    let db: TestDatabase;
    let store: PgDeliveryStore;

    beforeAll(async () => {
      db = await createTestDatabase();
      await db.admin.query(WEBHOOK_DELIVERIES_DDL);
      store = new PgDeliveryStore(db.admin);
    }, 120_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('writes one row per matching subscription and sends the signed envelope for each', async () => {
      const subs = new MemorySubscriptionStore();
      const sent: Sent[] = [];
      const transport: Transport = {
        async deliver(req) {
          sent.push({ url: req.url, headers: { ...req.headers }, body: req.body });
          const r: TransportResult = { ok: true, status: 204, hops: 0 };
          return r;
        },
      };
      const make = (url: string, events: string[]): SubscriptionRecord => ({
        id: uuid7(),
        tenant: TENANT,
        url,
        events,
        secrets: [generateSecret()],
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const a = make('https://hooks.example.test/u-be-055-a', ['dep.document.changed.v1']);
      const b = make('https://hooks.example.test/u-be-055-b', ['dep.document.changed.v1']);
      const other = make('https://hooks.example.test/u-be-055-c', ['dep.export.completed.v1']);
      for (const s of [a, b, other]) await subs.insert(s);

      const dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: store,
        transport,
        source: SOURCE,
        now: () => T0,
        rejectedThrottle: { windowMs: 60_000, max: 3 },
      });
      const event: DepEvent = {
        type: 'dep.document.changed.v1',
        tenant: TENANT,
        subject: SUBJECT,
        data: { seq: 7, chainHead: CHAIN },
        time: T0,
      };

      const ids = await dispatcher.raise(event);
      await dispatcher.drain();

      expect(ids).toHaveLength(2);
      expect(sent.map((s) => s.url).sort()).toEqual([a.url, b.url].sort());
      // The other subscription listens for another event: no row, no request.
      expect(await store.ofSubscription(TENANT, other.id)).toEqual([]);

      for (const s of [a, b]) {
        const rows = await store.ofSubscription(TENANT, s.id);
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        const req = sent.find((x) => x.url === s.url)!;
        expect(row).toMatchObject({ state: 'delivered', lastStatus: 204, tenant: TENANT });
        expect(row.messageId).toBe(req.headers['webhook-id']);
        // The stored body is the body sent: the log and the replay keep what went out.
        expect(row.body).toBe(req.body);
        expect(req.headers['content-type']).toMatch(/cloudevents/);
        const envelope = JSON.parse(req.body) as Record<string, unknown>;
        expect(envelope['specversion']).toBe('1.0');
        expect(envelope['type']).toBe('dep.document.changed.v1');
        expect(envelope['subject']).toBe(SUBJECT);
        expect((envelope['data'] as Record<string, unknown>)['seq']).toBe(7);
        expect(
          verifyDelivery({
            headers: req.headers,
            body: req.body,
            secrets: s.secrets,
            now: Math.floor(T0 / 1000),
          }),
        ).toEqual({ ok: true });
      }
    });
  },
);
