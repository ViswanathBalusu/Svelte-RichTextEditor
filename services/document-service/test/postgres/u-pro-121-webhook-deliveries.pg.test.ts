// PRO-071 and PRO-121 on PostgreSQL (lane U-PRO-120-131): the delivery store of the webhook
// dispatcher, against a database this test creates (docedit_u_pro_120_131_<hex>) and drops after.
// Criterion 1: the store keeps the exact body and returns the rows of one subscription oldest
// first. Criterion 2 of PRO-071: a failed send is retried under the same `webhook-id`, and the row
// that holds it ends delivered. The retry timers are held by the test and fired in order.
// Skips, with the reason, when the integration environment is not up (infra/test-env.ps1 up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from '../../src/control-plane/events.ts';
import {
  PgDeliveryStore,
  WEBHOOK_DELIVERIES_DDL,
} from '../../src/control-plane/webhook-deliveries-pg.ts';
import {
  RETRY_WINDOW_MS,
  WebhookDispatcher,
  type DeliveryRow,
} from '../../src/control-plane/webhook-dispatcher.ts';
import type { Transport, TransportResult } from '../../src/control-plane/webhook-egress.ts';
import { generateSecret } from '../../src/control-plane/webhook-signing.ts';
import { MemorySubscriptionStore } from '../../src/control-plane/webhook-subscriptions.ts';
import { ADMIN, postgresUnavailable } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const TENANT = 't-u-pro-120-131-webhooks';
const URL_A = 'https://hooks.example.test/u-pro-120-131';
const SOURCE = 'https://docs.example.test/events';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;

function row(over: Partial<DeliveryRow> & { id: string }): DeliveryRow {
  return {
    messageId: `msg_${over.id}`,
    tenant: TENANT,
    subscription: 'sub-a',
    eventType: 'dep.document.changed.v1',
    eventId: uuid7(),
    body: '{"type":"dep.document.changed.v1"}',
    test: false,
    state: 'pending',
    attempts: 0,
    lastStatus: null,
    lastReason: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

describe.skipIf(unavailable !== null)(
  'PRO-071 and PRO-121 on PostgreSQL: the delivery store',
  () => {
    const name = `docedit_u_pro_120_131_${randomBytes(6).toString('hex')}`;
    let pool: pg.Pool;

    beforeAll(async () => {
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`CREATE DATABASE ${name}`);
      } finally {
        await root.end();
      }
      pool = new pg.Pool({ ...ADMIN, database: name, max: 4 });
      await pool.query(WEBHOOK_DELIVERIES_DDL);
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await root.end();
      }
    }, 120_000);

    it('keeps the exact body and returns one subscription oldest first', async () => {
      const store = new PgDeliveryStore(pool);
      const body = '{"data":{"text":"line one\\nline two é ☃"},"id":"x"}';
      await store.insert(row({ id: 'r-late', createdAt: T0 + 5, body }));
      await store.insert(row({ id: 'r-early', createdAt: T0 + 1 }));
      await store.insert(row({ id: 'r-other', subscription: 'sub-b' }));

      const got = await store.get('r-late');
      expect(got?.body).toBe(body);
      expect(got?.lastReason).toBeNull();
      expect(got?.lastStatus).toBeNull();
      expect(got?.createdAt).toBe(T0 + 5);
      expect(await store.get('no-such-row')).toBeNull();

      const listed = await store.ofSubscription(TENANT, 'sub-a');
      expect(listed.map((r) => r.id)).toEqual(['r-early', 'r-late']);
      expect((await store.ofSubscription(TENANT, 'sub-b')).map((r) => r.id)).toEqual(['r-other']);
    });

    it('refuses a repeated identifier and an update of a row that does not exist', async () => {
      const store = new PgDeliveryStore(pool);
      await expect(store.insert(row({ id: 'r-early' }))).rejects.toThrow();
      await expect(store.update(row({ id: 'r-missing' }))).rejects.toThrow('no such delivery');
    });

    it('writes an update through and keeps the state, attempts and reason', async () => {
      const store = new PgDeliveryStore(pool);
      const before = await store.get('r-early');
      expect(before).not.toBeNull();
      await store.update({
        ...(before as DeliveryRow),
        state: 'failed',
        attempts: 2,
        lastStatus: 503,
        lastReason: null,
        updatedAt: T0 + 9,
      });
      const after = await store.get('r-early');
      expect(after).toMatchObject({
        state: 'failed',
        attempts: 2,
        lastStatus: 503,
        updatedAt: T0 + 9,
      });
    });

    it('retries a failed send under the same webhook-id, and the row ends delivered', async () => {
      const store = new PgDeliveryStore(pool);
      const clock = { now: T0 + 1000 };
      const timers: Array<{ due: number; run: () => void }> = [];
      const sends: Array<Record<string, string>> = [];
      const answers: TransportResult[] = [
        { ok: false, reason: 'timeout' },
        { ok: true, status: 204, hops: 0 },
      ];
      const transport: Transport = {
        deliver(req) {
          sends.push({ ...req.headers });
          return Promise.resolve(answers[sends.length - 1] ?? { ok: true, status: 204, hops: 0 });
        },
      };
      const subs = new MemorySubscriptionStore();
      const subId = uuid7();
      await subs.insert({
        id: subId,
        tenant: TENANT,
        url: URL_A,
        events: ['dep.document.changed.v1'],
        secrets: [generateSecret()],
        version: 1,
        createdAt: T0,
        updatedAt: T0,
      });
      const dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: store,
        transport,
        source: SOURCE,
        now: () => clock.now,
        rejectedThrottle: { windowMs: 60_000, max: 3 },
        retry: { baseMs: 1000, factor: 2, maxAgeMs: RETRY_WINDOW_MS },
        schedule: (run, delayMs) => {
          timers.push({ due: clock.now + delayMs, run });
        },
      });
      const event: DepEvent = {
        type: 'dep.document.changed.v1',
        tenant: TENANT,
        subject: SUBJECT,
        data: { seq: 1, chainHead: CHAIN },
        time: T0,
      };

      await dispatcher.raise(event);
      await dispatcher.drain();
      for (let i = 0; i < 10 && timers.length > 0; i++) {
        timers.sort((a, b) => a.due - b.due);
        const next = timers.shift();
        if (next === undefined) break;
        clock.now = next.due;
        next.run();
        await dispatcher.drain();
      }

      expect(sends.length).toBe(2);
      expect(sends[1]?.['webhook-id']).toBe(sends[0]?.['webhook-id']);
      const rows = await store.ofSubscription(TENANT, subId);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ state: 'delivered', messageId: sends[0]?.['webhook-id'] });
    });
  },
);
