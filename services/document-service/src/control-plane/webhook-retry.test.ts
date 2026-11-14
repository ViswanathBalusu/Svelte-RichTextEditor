// PRO-071 criteria 1 and 2: a failed delivery is retried with exponential delay for up to 24 hours
// and then abandoned, and each retry keeps the `webhook-id` of its row. The schedule is a fake: the
// test holds the timers and fires them in order, moving the clock to each one's due time.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from './events.ts';
import {
  MemoryDeliveryStore,
  RETRY_WINDOW_MS,
  WebhookDispatcher,
  type RetryPolicy,
} from './webhook-dispatcher.ts';
import type { Transport, TransportResult } from './webhook-egress.ts';
import { generateSecret } from './webhook-signing.ts';
import { MemorySubscriptionStore } from './webhook-subscriptions.ts';

const TENANT = 't-retry';
const URL_A = 'https://hooks.example.test/retry';
const SOURCE = 'https://docs.example.test/events';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
const OK: TransportResult = { ok: true, status: 204, hops: 0 };

interface Timer {
  due: number;
  run: () => void;
}

interface Rig {
  dispatcher: WebhookDispatcher;
  rows: MemoryDeliveryStore;
  clock: { now: number };
  timers: Timer[];
  sends: { at: number; headers: Record<string, string> }[];
}

async function rig(
  retry: RetryPolicy | undefined,
  answer: (sendNumber: number) => TransportResult,
): Promise<Rig> {
  const clock = { now: T0 };
  const timers: Timer[] = [];
  const sends: Rig['sends'] = [];
  const subs = new MemorySubscriptionStore();
  const rows = new MemoryDeliveryStore();
  const transport: Transport = {
    deliver(req) {
      sends.push({ at: clock.now, headers: { ...req.headers } });
      return Promise.resolve(answer(sends.length));
    },
  };
  await subs.insert({
    id: uuid7(),
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
    deliveries: rows,
    transport,
    source: SOURCE,
    now: () => clock.now,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
    ...(retry === undefined ? {} : { retry }),
    schedule: (run, delayMs) => {
      timers.push({ due: clock.now + delayMs, run });
    },
  });
  return { dispatcher, rows, clock, timers, sends };
}

function changed(): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant: TENANT,
    subject: SUBJECT,
    data: { seq: 1, chainHead: CHAIN },
    time: T0,
  };
}

/** Fires the held timers in due order, letting each send finish before the next. */
async function fireAll(r: Rig, limit = 500): Promise<void> {
  for (let i = 0; i < limit && r.timers.length > 0; i++) {
    r.timers.sort((a, b) => a.due - b.due);
    const next = r.timers.shift();
    if (next === undefined) break;
    r.clock.now = next.due;
    next.run();
    await r.dispatcher.drain();
  }
}

const TIMEOUT: TransportResult = { ok: false, reason: 'timeout' };

describe('PRO-071 criterion 1: a failed delivery is retried with exponential delay, then delivered', () => {
  it('waits base, base x factor, base x factor squared between sends, and stops once it is delivered', async () => {
    const r = await rig({ baseMs: 1000, factor: 2, maxAgeMs: RETRY_WINDOW_MS }, (n) =>
      n <= 3 ? TIMEOUT : OK,
    );
    const ids = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);
    expect(r.sends.map((s) => s.at - T0)).toEqual([0, 1000, 3000, 7000]);
    const row = await r.rows.get(ids[0] ?? '');
    expect(row?.state).toBe('delivered');
    expect(row?.attempts).toBe(4);
    expect(r.timers).toHaveLength(0);
  });

  it('a row that is refused by the egress policy is not retried', async () => {
    const r = await rig({ baseMs: 1000, factor: 2, maxAgeMs: RETRY_WINDOW_MS }, () => ({
      ok: false,
      reason: 'private',
    }));
    const ids = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);
    expect(r.sends).toHaveLength(1);
    const row = await r.rows.get(ids[0] ?? '');
    expect(row?.state).toBe('failed');
    expect(row?.lastReason).toBe('private');
  });

  it('without a retry policy a failed send is recorded as failed and not retried', async () => {
    const r = await rig(undefined, () => TIMEOUT);
    const ids = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    expect(r.timers).toHaveLength(0);
    expect(r.sends).toHaveLength(1);
    expect((await r.rows.get(ids[0] ?? ''))?.state).toBe('failed');
  });

  it('a receiver that answers 500 is retried too, and the retry is not a new row', async () => {
    const r = await rig({ baseMs: 500, factor: 1, maxAgeMs: RETRY_WINDOW_MS }, (n) =>
      n <= 2 ? { ok: true, status: 500, hops: 0 } : OK,
    );
    const ids = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);
    expect(r.sends).toHaveLength(3);
    expect(r.sends.map((s) => s.at - T0)).toEqual([0, 500, 1000]);
    expect((await r.rows.get(ids[0] ?? ''))?.state).toBe('delivered');
  });
});

describe('PRO-071 criterion 2: every send of a row carries the same webhook-id', () => {
  it('keeps the webhook-id across retries while the timestamp moves on', async () => {
    const r = await rig({ baseMs: 1000, factor: 3, maxAgeMs: RETRY_WINDOW_MS }, (n) =>
      n < 4 ? TIMEOUT : OK,
    );
    await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);
    expect(r.sends).toHaveLength(4);
    const ids = new Set(r.sends.map((s) => s.headers['webhook-id']));
    expect(ids.size).toBe(1);
    expect(r.sends[0]?.headers['webhook-id']).toMatch(/^msg_/);
    const stamps = new Set(r.sends.map((s) => s.headers['webhook-timestamp']));
    expect(stamps.size).toBe(4);
  });
});

describe('PRO-071 criterion 1: retries stop when the 24-hour window would close, then the row is abandoned', () => {
  it('property: the last send is inside the window and the next one would fall outside it', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 3_600_000 }),
        fc.integer({ min: 2, max: 3 }),
        async (baseMs, factor) => {
          const r = await rig({ baseMs, factor, maxAgeMs: RETRY_WINDOW_MS }, () => TIMEOUT);
          const ids = await r.dispatcher.raise(changed());
          await r.dispatcher.drain();
          await fireAll(r);
          const n = r.sends.length;
          const last = r.sends[n - 1];
          expect(last).toBeDefined();
          if (last === undefined) return;
          const elapsed = last.at - T0;
          const nextGap = baseMs * factor ** (n - 1);
          expect(elapsed).toBeLessThanOrEqual(RETRY_WINDOW_MS);
          expect(elapsed + nextGap).toBeGreaterThan(RETRY_WINDOW_MS);
          expect(r.timers).toHaveLength(0);
          expect((await r.rows.get(ids[0] ?? ''))?.state).toBe('failed');
        },
      ),
      { numRuns: 60 },
    );
  });

  it('rejects a policy whose base delay, factor or window is not usable', async () => {
    const subs = new MemorySubscriptionStore();
    const rows = new MemoryDeliveryStore();
    const base = {
      subscriptions: subs,
      deliveries: rows,
      transport: { deliver: () => Promise.resolve(OK) },
      source: SOURCE,
      now: () => T0,
      rejectedThrottle: { windowMs: 60_000, max: 3 },
    };
    expect(
      () => new WebhookDispatcher({ ...base, retry: { baseMs: 0, factor: 2, maxAgeMs: 1 } }),
    ).toThrow(RangeError);
    expect(
      () => new WebhookDispatcher({ ...base, retry: { baseMs: 1, factor: 0.5, maxAgeMs: 1 } }),
    ).toThrow(RangeError);
    expect(
      () => new WebhookDispatcher({ ...base, retry: { baseMs: 1, factor: 2, maxAgeMs: 0 } }),
    ).toThrow(RangeError);
  });
});
