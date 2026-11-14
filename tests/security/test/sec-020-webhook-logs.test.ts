/**
 * SEC-020 criterion 6 (logs, part): when the dispatcher's log entries are read, no webhook secret,
 * no signature and no body appears. Lane U-SEC-017-032. Memory only: the dispatcher's rows and its
 * log sink are the in-memory implementations; no PostgreSQL or container is involved.
 *
 * Metrics are not covered: the dispatcher writes no webhook metric (see the story Notes), so the
 * metrics half of the criterion stays unticked.
 */
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from '../../../services/document-service/src/control-plane/events.ts';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
  type DispatcherLogEntry,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import type {
  Transport,
  TransportResult,
} from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  MemorySubscriptionStore,
  type SubscriptionRecord,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import { generateSecret } from '../../../services/document-service/src/control-plane/webhook-signing.ts';

const TENANT = 't-u-sec-017-032-logs';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const SOURCE = 'https://docs.example.test/events';
const CHAIN = 'cd'.repeat(32);
const T0 = 1_700_000_000_000;
const MARKER = 'PRIVATE-PAYLOAD-MARKER-U-SEC-017-032';

interface Run {
  dispatcher: WebhookDispatcher;
  subs: MemorySubscriptionStore;
  logs: DispatcherLogEntry[];
  sent: Array<{ url: string; headers: Record<string, string>; body: string }>;
  status: { value: number };
}

function run(): Run {
  const subs = new MemorySubscriptionStore();
  const logs: DispatcherLogEntry[] = [];
  const sent: Run['sent'] = [];
  const status = { value: 204 };
  const transport: Transport = {
    async deliver(req): Promise<TransportResult> {
      sent.push({ url: req.url, headers: { ...req.headers }, body: req.body });
      return { ok: true, status: status.value, hops: 0 };
    },
  };
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: new MemoryDeliveryStore(),
    transport,
    source: SOURCE,
    now: () => T0,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
    log: (e) => logs.push(e),
  });
  return { dispatcher, subs, logs, sent, status };
}

async function subscribe(r: Run, secret: string): Promise<SubscriptionRecord> {
  const record: SubscriptionRecord = {
    id: uuid7(),
    tenant: TENANT,
    url: 'https://hooks.example.test/u-sec-017-032',
    events: ['dep.document.changed.v1'],
    secrets: [secret],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  await r.subs.insert(record);
  return record;
}

function changed(seq: number): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant: TENANT,
    subject: SUBJECT,
    data: { seq, chainHead: CHAIN, title: MARKER },
    time: T0,
  } as unknown as DepEvent;
}

describe('SEC-020 criterion 6 (logs): no secret, signature or body in the dispatcher log', () => {
  it('a successful and a failing delivery leave no secret, signature or body in the log entries', async () => {
    const r = run();
    const secret = generateSecret();
    const keyPart = secret.slice('whsec_'.length);
    await subscribe(r, secret);

    await r.dispatcher.raise(changed(1));
    await r.dispatcher.drain();
    r.status.value = 500;
    await r.dispatcher.raise(changed(2));
    await r.dispatcher.drain();

    expect(r.sent).toHaveLength(2);
    expect(r.logs.length).toBeGreaterThan(0);
    const logText = JSON.stringify(r.logs);
    const signature = r.sent[0]!.headers['webhook-signature'] ?? '';
    expect(signature).not.toBe('');

    expect(logText).not.toContain(secret);
    expect(logText).not.toContain(keyPart);
    expect(logText).not.toContain(signature);
    expect(logText).not.toContain(MARKER);
    expect(logText).not.toContain(CHAIN);
    for (const sentRequest of r.sent) {
      expect(logText).not.toContain(sentRequest.body);
    }
  });
});
