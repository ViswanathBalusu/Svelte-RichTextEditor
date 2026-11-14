// The webhook route of the reference host (UX-098 criteria 1, 2, 4 and 6), driven by the document
// service's own dispatcher: `WebhookDispatcher` builds the CloudEvents body and signs it with the
// service's `signDelivery` (webhook-signing.ts); its transport posts the request to the route's
// `POST` handler instead of the egress proxy. Only `webhookEndpoint()` is replaced, so that the
// route uses the test's receiver, clock and notification sink.
import {
  generateSecret,
  signDelivery,
} from '../../../services/document-service/src/control-plane/webhook-signing.ts';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
  type DeliveryRow,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import type { Transport } from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  MemorySubscriptionStore,
  type SubscriptionRecord,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import type { DepEvent } from '../../../services/document-service/src/control-plane/events.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  composeWebhookEndpoint,
  secretsFromEnv,
  type WebhookEndpoint,
} from '../src/lib/server/webhook-endpoint.ts';
import type * as EndpointModule from '../src/lib/server/webhook-endpoint.ts';
import {
  MemoryNotificationSink,
  type Notification,
  type NotificationSink,
} from '../src/lib/server/webhook-notifications.ts';

const current = vi.hoisted(() => ({ endpoint: null as unknown }));

vi.mock('../src/lib/server/webhook-endpoint.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointModule>()),
  webhookEndpoint: () => current.endpoint,
}));

// Loaded by path at run time: its `./$types` import is SvelteKit's generated types, which this
// project's Node type-check does not see (as in routes.test.ts).
const WEBHOOK_ROUTE = '../src/routes/webhooks/dep/+server.ts';
interface WebhookRoute {
  POST(event: { request: Request }): Promise<Response>;
}

const TENANT = 't-host';
const URL_ = 'https://host.test/webhooks/dep';
const DOC = '0192f0a1-0000-7000-8000-000000000001';
const T0 = 1_800_000_000_000;

afterEach(() => {
  current.endpoint = null;
});

async function post(headers: Record<string, string>, body: string): Promise<Response> {
  const route = (await import(/* @vite-ignore */ WEBHOOK_ROUTE)) as WebhookRoute;
  return route.POST({ request: new Request(URL_, { method: 'POST', headers, body }) });
}

interface Stack {
  dispatcher: WebhookDispatcher;
  subs: MemorySubscriptionStore;
  rows: MemoryDeliveryStore;
  endpoint: WebhookEndpoint;
  sink: MemoryNotificationSink;
  /** What the receiver knows; changed by a test to rotate. */
  receiverSecrets: string[];
  /** Milliseconds; the dispatcher reads it as is and the receiver in whole seconds. */
  clock: { service: number; host: number };
  /** Status of every request the route answered, in order. */
  answers: number[];
  sub: SubscriptionRecord;
}

async function stack(
  opts: { secrets?: string[]; sink?: NotificationSink; events?: string[] } = {},
): Promise<Stack> {
  const secrets = opts.secrets ?? [generateSecret()];
  const sink = new MemoryNotificationSink();
  const clock = { service: T0, host: T0 };
  const answers: number[] = [];
  const s: Partial<Stack> & { receiverSecrets: string[] } = { receiverSecrets: [...secrets] };
  const endpoint = composeWebhookEndpoint({
    secrets: () => s.receiverSecrets,
    sink: opts.sink ?? sink,
    now: () => Math.floor(clock.host / 1000),
  });
  current.endpoint = endpoint;
  const transport: Transport = {
    async deliver(req) {
      const res = await post({ ...req.headers }, req.body);
      answers.push(res.status);
      return { ok: true, status: res.status, hops: 0 };
    },
  };
  const subs = new MemorySubscriptionStore();
  const rows = new MemoryDeliveryStore();
  const sub: SubscriptionRecord = {
    id: 'sub-1',
    tenant: TENANT,
    url: URL_,
    events: opts.events ?? [
      'dep.comment.mentioned.v1',
      'dep.task.assigned.v1',
      'dep.document.changed.v1',
    ],
    secrets,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  await subs.insert(sub);
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: rows,
    transport,
    source: 'https://docs.example.test/events',
    now: () => clock.service,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
  });
  return Object.assign(s, { dispatcher, subs, rows, endpoint, sink, clock, answers, sub });
}

/** A sink that holds every notification until `release` is called. */
function gatedSink(): { sink: NotificationSink; sent: Notification[]; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: Notification[] = [];
  return {
    sink: {
      async send(n) {
        await gate;
        sent.push(n);
      },
    },
    sent,
    release: () => release(),
  };
}

function mentioned(seq: number): DepEvent {
  return {
    type: 'dep.comment.mentioned.v1',
    tenant: TENANT,
    subject: DOC,
    data: { seq },
    time: T0,
  };
}

/** Changes the subscription's active secrets, as the service's rotation does (BE-057). */
async function setServiceSecrets(s: Stack, secrets: string[]): Promise<void> {
  const now = await s.subs.get(TENANT, s.sub.id);
  if (!now) throw new Error('no subscription');
  const ok = await s.subs.replace({ ...now, secrets, version: now.version + 1 }, now.version);
  if (!ok) throw new Error('replace failed');
}

async function deliver(s: Stack, event: DepEvent): Promise<DeliveryRow> {
  const [id] = await s.dispatcher.raise(event);
  await s.dispatcher.drain();
  const row = id === undefined ? null : await s.rows.get(id);
  if (!row) throw new Error('no delivery row');
  return row;
}

describe('criterion 1: the route verifies what the service signs, and refuses the rest', () => {
  it("accepts a delivery the service's dispatcher signed, and the row is delivered", async () => {
    const s = await stack();
    const row = await deliver(s, mentioned(1));
    expect(s.answers).toEqual([202]);
    expect(row.state).toBe('delivered');
    expect(row.lastStatus).toBe(202);
  });

  it('refuses a delivery signed with a secret the host does not know (401)', async () => {
    const s = await stack();
    s.receiverSecrets = [generateSecret()];
    const row = await deliver(s, mentioned(1));
    expect(s.answers).toEqual([401]);
    expect(row.state).toBe('failed');
    await s.endpoint.settled();
    expect(s.sink.sent).toEqual([]);
  });

  it('applies the five-minute tolerance to the service clock against the host clock', async () => {
    const s = await stack();
    s.clock.service = T0 - 300_000;
    await deliver(s, mentioned(1));
    s.clock.service = T0 - 301_000;
    await deliver(s, mentioned(2));
    s.clock.service = T0 + 301_000;
    await deliver(s, mentioned(3));
    expect(s.answers).toEqual([202, 400, 400]);
  });

  it('refuses a tampered body, a changed webhook-id and missing headers', async () => {
    const secret = generateSecret();
    const s = await stack({ secrets: [secret] });
    const body = JSON.stringify({
      type: 'dep.comment.mentioned.v1',
      subject: DOC,
      data: { seq: 1 },
    });
    const ts = Math.floor(T0 / 1000);
    const signed = { ...signDelivery({ id: 'msg_t', timestamp: ts, body, secrets: [secret] }) };
    expect((await post(signed, body.replace('"seq":1', '"seq":2'))).status).toBe(401);
    expect((await post({ ...signed, 'webhook-id': 'msg_other' }, body)).status).toBe(401);
    const noSignature: Record<string, string> = { ...signed };
    delete noSignature['webhook-signature'];
    const refused = await post(noSignature, body);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'missing-headers' });
    await s.endpoint.settled();
    expect(s.sink.sent).toEqual([]);
  });

  it('verifies the raw bytes: whitespace and a byte-order mark that a re-serialisation would drop', async () => {
    const secret = generateSecret();
    await stack({ secrets: [secret] });
    const BOM = String.fromCharCode(0xfeff);
    const body = `${BOM}{ "type" : "dep.task.assigned.v1",\n  "subject": "${DOC}", "data": {"seq": 4} }`;
    const ts = Math.floor(T0 / 1000);
    const headers = { ...signDelivery({ id: 'msg_raw', timestamp: ts, body, secrets: [secret] }) };
    // The signature matches only because the BOM was kept; JSON.parse then refuses the body.
    expect(await (await post(headers, body)).json()).toEqual({ error: 'bad-json' });
    const plain = body.slice(1);
    const plainHeaders = {
      ...signDelivery({ id: 'msg_raw2', timestamp: ts, body: plain, secrets: [secret] }),
    };
    expect((await post(plainHeaders, plain)).status).toBe(202);
  });

  it('answers 401 to every delivery when the host has no secret set', async () => {
    const s = await stack();
    s.receiverSecrets = [];
    await deliver(s, mentioned(1));
    expect(s.answers).toEqual([401]);
    expect(secretsFromEnv({})).toEqual([]);
    expect(secretsFromEnv({ DOCEDIT_HOST_WEBHOOK_SECRETS: 'whsec_a, whsec_b' })).toEqual([
      'whsec_a',
      'whsec_b',
    ]);
  });

  it("answers the dispatcher's test ping with 202 and sends no notification", async () => {
    const s = await stack();
    const id = await s.dispatcher.ping(TENANT, s.sub.id);
    await s.endpoint.settled();
    expect(s.answers).toEqual([202]);
    expect((await s.rows.get(id))?.state).toBe('delivered');
    expect(s.sink.sent).toEqual([]);
  });
});

describe('criterion 2: a repeated webhook-id sends one notification; order is not assumed', () => {
  it('the replay of a delivery (same webhook-id) is answered 202 and notifies no one again', async () => {
    const s = await stack();
    const a = await deliver(s, mentioned(1));
    const b = await deliver(s, {
      type: 'dep.task.assigned.v1',
      tenant: TENANT,
      subject: DOC,
      data: { seq: 2 },
      time: T0,
    });
    // At-least-once: the service sends A again with its own webhook-id, after B.
    s.clock.service += 60_000;
    s.clock.host += 60_000;
    await s.dispatcher.replay(TENANT, a.id);
    await s.dispatcher.replay(TENANT, a.id);
    await s.endpoint.settled();
    expect(s.answers).toEqual([202, 202, 202, 202]);
    expect(s.sink.sent.map((n) => n.webhookId)).toEqual([a.messageId, b.messageId]);
    expect(s.sink.sent.map((n) => n.type)).toEqual([
      'dep.comment.mentioned.v1',
      'dep.task.assigned.v1',
    ]);
    expect(s.sink.sent.every((n) => n.document === DOC)).toBe(true);
  });

  it('a replay that arrives before the first delivery was processed still notifies once', async () => {
    const held = gatedSink();
    const s = await stack({ sink: held.sink });
    const a = await deliver(s, mentioned(1));
    await s.dispatcher.replay(TENANT, a.id);
    expect(held.sent).toEqual([]);
    held.release();
    await s.endpoint.settled();
    expect(s.answers).toEqual([202, 202]);
    expect(held.sent.map((n) => n.webhookId)).toEqual([a.messageId]);
  });

  it('an event that does not notify is accepted and causes no notification', async () => {
    const s = await stack();
    await deliver(s, {
      type: 'dep.document.changed.v1',
      tenant: TENANT,
      subject: DOC,
      data: { seq: 3, chainHead: 'ab'.repeat(32) },
      time: T0,
    });
    await s.endpoint.settled();
    expect(s.answers).toEqual([202]);
    expect(s.sink.sent).toEqual([]);
  });
});

describe('criterion 4: the route answers before the work runs', () => {
  it('answers 202 while the notification is still waiting, and sends it afterwards', async () => {
    const held = gatedSink();
    const s = await stack({ sink: held.sink });
    const row = await deliver(s, mentioned(1));
    // The dispatcher has its answer and the row is delivered; nothing was sent yet.
    expect(row.state).toBe('delivered');
    expect(s.answers).toEqual([202]);
    expect(held.sent).toEqual([]);
    held.release();
    await s.endpoint.settled();
    expect(held.sent.map((n) => n.webhookId)).toEqual([row.messageId]);
  });

  it('a failing sink does not change the answer, and the failure is recorded', async () => {
    const failing: NotificationSink = {
      send: () => Promise.reject(new Error('mail sink down')),
    };
    const s = await stack({ sink: failing });
    const row = await deliver(s, mentioned(1));
    await s.endpoint.settled();
    expect(s.answers).toEqual([202]);
    expect(row.state).toBe('delivered');
    expect(s.endpoint.queue.failures.map((f) => f.webhookId)).toEqual([row.messageId]);
  });
});

describe('criterion 6: a secret rotation on both sides rejects no delivery', () => {
  it('every step of the overlap is accepted, and a retired secret alone is refused', async () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const s = await stack({ secrets: [oldSecret] });
    let seq = 0;
    const step = async () => (await deliver(s, mentioned(++seq))).state;

    expect(await step()).toBe('delivered'); // both sides on the old secret
    await setServiceSecrets(s, [oldSecret, newSecret]); // the service starts the rotation
    expect(await step()).toBe('delivered'); // the host still knows only the old one
    s.receiverSecrets = [oldSecret, newSecret]; // the host adds the new one
    expect(await step()).toBe('delivered');
    await setServiceSecrets(s, [newSecret]); // the service retires the old one
    expect(await step()).toBe('delivered');
    s.receiverSecrets = [newSecret]; // the host drops the old one
    expect(await step()).toBe('delivered');
    expect(s.answers).toEqual([202, 202, 202, 202, 202]);

    // The host's other order: it drops the old secret before the service has the new one.
    s.receiverSecrets = [newSecret];
    await setServiceSecrets(s, [oldSecret]);
    expect(await step()).toBe('failed');
    expect(s.answers.at(-1)).toBe(401);

    await s.endpoint.settled();
    expect(s.sink.sent).toHaveLength(5);
  });
});
