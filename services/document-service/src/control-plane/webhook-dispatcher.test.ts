// BE-055 (the dispatcher raises, signs, sends and logs deliveries), BE-057 (rotation, retired
// secrets, test pings, replay with the same webhook-id, filters). The transport is a fake that
// stands for the egress proxy of BE-056; the rows are the in-memory store (no PostgreSQL here).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from './events.ts';
import { DocumentChangeDebounce } from './event-throttle.ts';
import {
  COMMIT_REJECTED,
  CLOUDEVENTS_JSON,
  MemoryDeliveryStore,
  WebhookDispatcher,
  type DispatcherLogEntry,
} from './webhook-dispatcher.ts';
import type { Transport, TransportResult } from './webhook-egress.ts';
import { MemorySubscriptionStore, type SubscriptionRecord } from './webhook-subscriptions.ts';
import { generateSecret, verifyDelivery } from './webhook-signing.ts';

const TENANT = 't-search';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const SOURCE = 'https://docs.example.test/events';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface Harness {
  dispatcher: WebhookDispatcher;
  subs: MemorySubscriptionStore;
  rows: MemoryDeliveryStore;
  sent: Sent[];
  logs: DispatcherLogEntry[];
  clock: { now: number };
  /** Lets a test hold or change the answer for one URL. */
  answer: Map<string, (sent: Sent) => Promise<TransportResult>>;
}

function harness(rejected = { windowMs: 60_000, max: 3 }): Harness {
  const subs = new MemorySubscriptionStore();
  const rows = new MemoryDeliveryStore();
  const sent: Sent[] = [];
  const logs: DispatcherLogEntry[] = [];
  const clock = { now: T0 };
  const answer = new Map<string, (sent: Sent) => Promise<TransportResult>>();
  const transport: Transport = {
    async deliver(req) {
      const record: Sent = { url: req.url, headers: { ...req.headers }, body: req.body };
      sent.push(record);
      const custom = answer.get(req.url);
      if (custom !== undefined) return custom(record);
      return { ok: true, status: 204, hops: 0 };
    },
  };
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: rows,
    transport,
    source: SOURCE,
    now: () => clock.now,
    rejectedThrottle: rejected,
    log: (e) => logs.push(e),
  });
  return { dispatcher, subs, rows, sent, logs, clock, answer };
}

async function subscribe(
  h: Harness,
  url: string,
  events: string[],
  secrets: string[] = [generateSecret()],
): Promise<SubscriptionRecord> {
  const record: SubscriptionRecord = {
    id: uuid7(),
    tenant: TENANT,
    url,
    events,
    secrets,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  await h.subs.insert(record);
  return record;
}

function changed(seq: number, time = T0): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant: TENANT,
    subject: SUBJECT,
    data: { seq, chainHead: CHAIN },
    time,
  };
}

function headerOf(sent: Sent, name: string): string {
  const v = sent.headers[name];
  if (v === undefined) throw new Error(`no ${name} header`);
  return v;
}

describe('BE-055 a matching event becomes a delivery row and a signed CloudEvents request', () => {
  it('creates one row per matching subscription and sends the envelope with the three headers', async () => {
    const h = harness();
    const sub = await subscribe(h, 'https://hooks.example.test/a', ['dep.document.changed.v1']);
    const ids = await h.dispatcher.raise(changed(7));
    await h.dispatcher.drain();
    expect(ids).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    const req = h.sent[0];
    expect(req).toBeDefined();
    if (req === undefined) return;
    expect(req.url).toBe('https://hooks.example.test/a');
    expect(req.headers['content-type']).toBe(CLOUDEVENTS_JSON);
    const body = JSON.parse(req.body) as Record<string, unknown>;
    expect(body['specversion']).toBe('1.0');
    expect(body['type']).toBe('dep.document.changed.v1');
    expect(body['subject']).toBe(SUBJECT);
    expect((body['data'] as Record<string, unknown>)['seq']).toBe(7);
    const check = verifyDelivery({
      headers: req.headers,
      body: req.body,
      secrets: sub.secrets,
      now: Math.floor(T0 / 1000),
    });
    expect(check).toEqual({ ok: true });
    const row = (await h.rows.ofSubscription(TENANT, sub.id))[0];
    expect(row?.state).toBe('delivered');
    expect(row?.lastStatus).toBe(204);
    expect(row?.messageId).toBe(headerOf(req, 'webhook-id'));
  });

  it('sends nothing to a subscription whose filter does not list the event', async () => {
    const h = harness();
    await subscribe(h, 'https://hooks.example.test/b', ['dep.export.completed.v1']);
    expect(await h.dispatcher.raise(changed(1))).toEqual([]);
    await h.dispatcher.drain();
    expect(h.sent).toHaveLength(0);
  });

  it('records a refused target with the refusal reason and no status', async () => {
    const h = harness();
    h.answer.set('https://hooks.example.test/c', () =>
      Promise.resolve({ ok: false, reason: 'private' }),
    );
    const sub = await subscribe(h, 'https://hooks.example.test/c', ['dep.document.changed.v1']);
    await h.dispatcher.raise(changed(2));
    await h.dispatcher.drain();
    const row = (await h.rows.ofSubscription(TENANT, sub.id))[0];
    expect(row?.state).toBe('failed');
    expect(row?.lastReason).toBe('private');
    expect(row?.lastStatus).toBeNull();
  });

  it('records a non-2xx answer as failed with its status', async () => {
    const h = harness();
    h.answer.set('https://hooks.example.test/d', () =>
      Promise.resolve({ ok: true, status: 500, hops: 0 }),
    );
    const sub = await subscribe(h, 'https://hooks.example.test/d', ['dep.document.changed.v1']);
    await h.dispatcher.raise(changed(3));
    await h.dispatcher.drain();
    const row = (await h.rows.ofSubscription(TENANT, sub.id))[0];
    expect(row?.state).toBe('failed');
    expect(row?.lastStatus).toBe(500);
  });

  it('refuses an event that breaks the envelope rules, with no row', async () => {
    const h = harness();
    await subscribe(h, 'https://hooks.example.test/e', ['dep.document.changed.v1']);
    const bad = { ...changed(4), data: { seq: 4 } };
    expect(await h.dispatcher.raise(bad)).toEqual([]);
    expect(h.logs.some((e) => e.event === 'envelope_refused')).toBe(true);
  });

  it('does not hold back other targets while one target is slow (criterion 3)', async () => {
    const h = harness();
    const slowUrl = 'https://slow.example.test/x';
    const fastUrl = 'https://fast.example.test/x';
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.answer.set(slowUrl, async () => {
      await held;
      return { ok: true, status: 204, hops: 0 };
    });
    const slow = await subscribe(h, slowUrl, ['dep.document.changed.v1']);
    const fast = await subscribe(h, fastUrl, ['dep.document.changed.v1']);
    await h.dispatcher.raise(changed(5));
    for (let i = 0; i < 50; i += 1) await new Promise((r) => setTimeout(r, 0));
    expect(h.sent.map((s) => s.url)).toContain(fastUrl);
    const fastRow = (await h.rows.ofSubscription(TENANT, fast.id))[0];
    const slowRow = (await h.rows.ofSubscription(TENANT, slow.id))[0];
    expect(fastRow?.state).toBe('delivered');
    expect(slowRow?.state).toBe('pending');
    release();
    await h.dispatcher.drain();
    expect((await h.rows.ofSubscription(TENANT, slow.id))[0]?.state).toBe('delivered');
  });

  it('keeps the debounce of dep.document.changed: one raised at once, the latest after the window (criterion 2)', async () => {
    const h = harness();
    const sub = await subscribe(h, 'https://hooks.example.test/f', ['dep.document.changed.v1']);
    const debounce = new DocumentChangeDebounce(h.dispatcher);
    for (let i = 0; i < 6; i += 1) debounce.offer(changed(10 + i, T0 + i * 1000), T0 + i * 1000);
    await h.dispatcher.drain();
    expect(h.sent).toHaveLength(1);
    debounce.flush(T0 + 10_000);
    await h.dispatcher.drain();
    expect(h.sent).toHaveLength(2);
    const last = JSON.parse(h.sent[1]?.body ?? '{}') as {
      data: { seq: number; chainHead: string };
    };
    expect(last.data.seq).toBe(15);
    expect(last.data.chainHead).toBe(CHAIN);
    expect((await h.rows.ofSubscription(TENANT, sub.id)).length).toBe(2);
  });

  it('throttles dep.commit.rejected.v1 and admits it again after the window (criterion 4)', async () => {
    const h = harness({ windowMs: 60_000, max: 3 });
    await subscribe(h, 'https://hooks.example.test/g', ['dep.commit.rejected.v1']);
    const rejection: DepEvent = {
      type: COMMIT_REJECTED,
      tenant: TENANT,
      subject: SUBJECT,
      data: { seq: 9 },
      time: T0,
    };
    const counts: number[] = [];
    for (let i = 0; i < 5; i += 1) counts.push((await h.dispatcher.raise(rejection)).length);
    expect(counts).toEqual([1, 1, 1, 0, 0]);
    expect(h.logs.filter((e) => e.event === 'suppressed')).toHaveLength(2);
    h.clock.now = T0 + 60_001;
    expect((await h.dispatcher.raise(rejection)).length).toBe(1);
    await h.dispatcher.drain();
  });

  it('logs identifiers and status but never the body or a secret (criterion 5)', async () => {
    const h = harness();
    const secret = generateSecret();
    await subscribe(h, 'https://hooks.example.test/h', ['dep.document.changed.v1'], [secret]);
    await h.dispatcher.raise(changed(21));
    await h.dispatcher.drain();
    const sentBody = h.sent[0]?.body ?? '';
    expect(sentBody).toContain(CHAIN);
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(CHAIN);
    expect(logged).not.toContain('specversion');
    expect(logged).not.toContain(secret);
    expect(h.logs.some((e) => e.event === 'attempt' && e.status === 204)).toBe(true);
  });

  it('keeps the event sink face: emit raises in the background and drain waits for it', async () => {
    const h = harness();
    await subscribe(h, 'https://hooks.example.test/i', ['dep.document.changed.v1']);
    h.dispatcher.emit(changed(30));
    await h.dispatcher.drain();
    expect(h.sent).toHaveLength(1);
  });

  it('property: every raised delivery is signed with exactly the secrets active when it was sent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 50 }), async (seq) => {
        const h = harness();
        const secret = generateSecret();
        await subscribe(h, 'https://hooks.example.test/p', ['dep.document.changed.v1'], [secret]);
        await h.dispatcher.raise(changed(seq));
        await h.dispatcher.drain();
        const req = h.sent[0];
        expect(req).toBeDefined();
        if (req === undefined) return;
        expect(
          verifyDelivery({
            headers: req.headers,
            body: req.body,
            secrets: [secret],
            now: Math.floor(T0 / 1000),
          }),
        ).toEqual({ ok: true });
      }),
      { numRuns: 25 },
    );
  });
});

describe('BE-057 rotation, retirement, test pings, replay and filters', () => {
  it('during a rotation a receiver holding either secret verifies the delivery (criterion 1)', async () => {
    const h = harness();
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    await subscribe(
      h,
      'https://hooks.example.test/r',
      ['dep.document.changed.v1'],
      [oldSecret, newSecret],
    );
    await h.dispatcher.raise(changed(40));
    await h.dispatcher.drain();
    const req = h.sent[0];
    expect(req).toBeDefined();
    if (req === undefined) return;
    expect(req.headers['webhook-signature']?.split(' ')).toHaveLength(2);
    const now = Math.floor(T0 / 1000);
    expect(
      verifyDelivery({ headers: req.headers, body: req.body, secrets: [oldSecret], now }),
    ).toEqual({ ok: true });
    expect(
      verifyDelivery({ headers: req.headers, body: req.body, secrets: [newSecret], now }),
    ).toEqual({ ok: true });
  });

  it('after the old secret is retired a receiver holding only it fails verification (criterion 2)', async () => {
    const h = harness();
    const retired = generateSecret();
    const current = generateSecret();
    await subscribe(h, 'https://hooks.example.test/s', ['dep.document.changed.v1'], [current]);
    await h.dispatcher.raise(changed(41));
    await h.dispatcher.drain();
    const req = h.sent[0];
    expect(req).toBeDefined();
    if (req === undefined) return;
    const now = Math.floor(T0 / 1000);
    expect(
      verifyDelivery({ headers: req.headers, body: req.body, secrets: [retired], now }),
    ).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(
      verifyDelivery({ headers: req.headers, body: req.body, secrets: [current], now }),
    ).toEqual({ ok: true });
  });

  it('a test ping uses the same signing and transport and is marked as a test (criterion 3)', async () => {
    const h = harness();
    const secret = generateSecret();
    const sub = await subscribe(
      h,
      'https://hooks.example.test/t',
      ['dep.export.completed.v1'],
      [secret],
    );
    const rowId = await h.dispatcher.ping(TENANT, sub.id);
    await h.dispatcher.drain();
    const req = h.sent[0];
    expect(req).toBeDefined();
    if (req === undefined) return;
    expect((JSON.parse(req.body) as { test: boolean }).test).toBe(true);
    expect(
      verifyDelivery({
        headers: req.headers,
        body: req.body,
        secrets: [secret],
        now: Math.floor(T0 / 1000),
      }),
    ).toEqual({ ok: true });
    const row = await h.rows.get(rowId);
    expect(row?.test).toBe(true);
    expect(row?.state).toBe('delivered');
  });

  it('a test ping to an unknown subscription is not found', async () => {
    const h = harness();
    await expect(h.dispatcher.ping(TENANT, uuid7())).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a replay sends the same webhook-id again (criterion 4)', async () => {
    const h = harness();
    const sub = await subscribe(h, 'https://hooks.example.test/y', ['dep.document.changed.v1']);
    const [rowId] = await h.dispatcher.raise(changed(50));
    await h.dispatcher.drain();
    h.clock.now = T0 + 120_000;
    const again = await h.dispatcher.replay(TENANT, rowId ?? '');
    await h.dispatcher.drain();
    expect(h.sent).toHaveLength(2);
    expect(headerOf(h.sent[1] as Sent, 'webhook-id')).toBe(
      headerOf(h.sent[0] as Sent, 'webhook-id'),
    );
    expect(headerOf(h.sent[1] as Sent, 'webhook-timestamp')).not.toBe(
      headerOf(h.sent[0] as Sent, 'webhook-timestamp'),
    );
    expect(again.attempts).toBe(2);
    expect(again.subscription).toBe(sub.id);
  });

  it('a replay of another tenant’s delivery is not found', async () => {
    const h = harness();
    await subscribe(h, 'https://hooks.example.test/z', ['dep.document.changed.v1']);
    const [rowId] = await h.dispatcher.raise(changed(51));
    await h.dispatcher.drain();
    await expect(h.dispatcher.replay('t-other', rowId ?? '')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a subscription that is not listed for an event gets no delivery for it (criterion 5)', async () => {
    const h = harness();
    await subscribe(h, 'https://hooks.example.test/w', [
      'dep.export.completed.v1',
      'dep.document.changed.v1',
    ]);
    await subscribe(h, 'https://hooks.example.test/v', ['dep.export.failed.v1']);
    await h.dispatcher.raise(changed(60));
    await h.dispatcher.drain();
    expect(h.sent.map((s) => s.url)).toEqual(['https://hooks.example.test/w']);
  });
});
