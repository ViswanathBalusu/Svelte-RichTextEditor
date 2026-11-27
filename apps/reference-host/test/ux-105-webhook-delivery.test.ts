// UX-105 criteria 1 to 4: the document service delivers its workflow webhooks to the reference host
// in the demo stack's configuration. The service is the real one in memory (`startService`) with the
// webhook settings the stack gives it (`roleEnv('service')`), including the one exception of the
// egress proxy; its dispatcher signs, the real `EgressProxy` connects to a loopback server that runs
// the host's receiver (`composeWebhookEndpoint`, as the route `POST /webhooks/dep` does), and the
// host's own `handleWorkflowEvent` sends the invitation. Mail is captured. The same flow with the
// exception removed is refused by the egress proxy: no mail, and the delivery row says `loopback`.
// The run against the running stack and its Mailpit is `ux-105-mailpit.stack.test.ts`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../../services/document-service/src/config.ts';
import { MemoryDeliveryStore } from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import {
  roleEnv,
  stackSettings,
  WEBHOOK_EVENTS,
  WEBHOOK_PATH,
  webhookAllow,
} from '../scripts/lib/stack.ts';
import { serviceTemplateContent } from '../src/lib/server/documents.ts';
import {
  WorkflowStore,
  handleWorkflowEvent,
  sendForCompletion,
  type EventDeps,
} from '../src/lib/server/send-for-completion.ts';
import { composeWebhookEndpoint } from '../src/lib/server/webhook-endpoint.ts';
import { MemoryNotificationSink } from '../src/lib/server/webhook-notifications.ts';
import { ensureSubscription } from '../src/lib/server/webhook-registration.ts';
import { startHarness, type Harness } from './support.ts';

interface Mail {
  to: string;
  subject: string;
  text: string;
}

interface World {
  h: Harness;
  receiver: Server;
  dir: string;
  mails: Mail[];
  deliveries: MemoryDeliveryStore;
  /** The address of the receiver, `127.0.0.1:port`. */
  endpoint: string;
  secretRef: { value: string | undefined };
  subscription: string;
  doc: string;
  deps: EventDeps;
}

const open: World[] = [];
afterEach(async () => {
  for (const w of open.splice(0)) {
    await w.h.close();
    await new Promise<void>((r) => w.receiver.close(() => r()));
    await rm(w.dir, { recursive: true, force: true });
  }
});

/** The webhook settings the demo stack gives the service, with the exception for `endpoint`. */
function stackWebhookSettings(endpoint: string, withException: boolean) {
  const s = stackSettings({});
  const env = roleEnv('service', s, {
    serviceSigning: { kid: 'x' },
    viewKey: 'x',
    cursorSecret: 'x',
  });
  const picked = Object.fromEntries(
    Object.entries(env).filter(
      ([k]) => k.startsWith('DOCEDIT_WEBHOOK') || k === 'DOCEDIT_WEBHOOKS',
    ),
  );
  const cfg = configFromEnv({
    ...picked,
    DOCEDIT_ENVIRONMENT: env['DOCEDIT_ENVIRONMENT'] ?? 'production',
    ...(withException ? { DOCEDIT_DEMO_WEBHOOK_ALLOW: endpoint } : {}),
  });
  if (!cfg.webhooks) throw new Error('the stack gives the service no webhook settings');
  // Retries are off here: the first refusal is the final one, and a test does not wait for the schedule.
  const { retry: _retry, ...webhooks } = cfg.webhooks;
  return { webhooks, environment: cfg.environment };
}

async function world(withException: boolean): Promise<World> {
  const mails: Mail[] = [];
  const secretRef: { value: string | undefined } = { value: undefined };
  let endpointRef: ReturnType<typeof composeWebhookEndpoint> | null = null;
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers))
        if (typeof v === 'string') headers.set(k, v);
      const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(chunks));
      if (req.url !== WEBHOOK_PATH || endpointRef === null) {
        res.writeHead(404).end();
        return;
      }
      const outcome = endpointRef.receiver.receive(headers, body);
      if (outcome.status === 202 && !outcome.duplicate) endpointRef.schedule();
      res.writeHead(outcome.status).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
  const port = (receiver.address() as AddressInfo).port;
  const endpoint = `127.0.0.1:${port}`;

  const deliveries = new MemoryDeliveryStore();
  const { webhooks, environment } = stackWebhookSettings(endpoint, withException);
  const h = await startHarness({
    serviceConfig: { environment, webhooks },
    service: { webhooks: { deliveries } },
  });
  const dir = await mkdtemp(join(tmpdir(), 'docedit-ux105-'));
  const st = h.host.seed.serviceTemplates![0]!;
  const created = await h.host.service.createDocument(
    { content: await serviceTemplateContent(h.host.seedDir, st), title: 'Lease (UX-105)' },
    'ux105-doc',
    'u-olivia',
  );
  await h.host.catalogue.put({
    id: created.id,
    externalId: 'ux105-doc',
    title: 'Lease (UX-105)',
    template: 'lease',
    createdBy: 'u-olivia',
    createdAt: new Date().toISOString(),
    roles: { 'u-olivia': 'owner' },
    accessSince: {},
    deletedAt: null,
  });
  const deps: EventDeps = {
    host: { ...h.host, config: { dataDir: dir } },
    store: await WorkflowStore.open(dir),
    mail: (m) => {
      mails.push(m);
      return Promise.resolve();
    },
    publicUrl: `http://127.0.0.1:${port}`,
  };
  endpointRef = composeWebhookEndpoint({
    secrets: () => (secretRef.value ? [secretRef.value] : []),
    sink: new MemoryNotificationSink(),
    onEvent: (event) => handleWorkflowEvent(deps, event),
  });
  // The registration the seed step makes, with the events and the URL the stack uses.
  const registration = await ensureSubscription(h.host.service, {
    url: `http://${endpoint}${WEBHOOK_PATH}`,
    events: WEBHOOK_EVENTS,
    knownSecret: undefined,
  });
  secretRef.value = registration.secret;
  const w: World = {
    h,
    receiver,
    dir,
    mails,
    deliveries,
    endpoint,
    secretRef,
    subscription: registration.id,
    doc: created.id,
    deps,
  };
  open.push(w);
  return w;
}

const PEOPLE = [
  { role: 'tenant', name: 'Tess Tenant', email: 'tess@people.example.test' },
  { role: 'landlord', name: 'Larry Landlord', email: 'larry@people.example.test' },
];

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  for (let i = 0; i < 100; i++) {
    const v = await read();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

describe('the stack gives the service a subscription for the host (UX-105 criterion 1)', () => {
  it('names the host receiver and the workflow, comment and task events', () => {
    const s = stackSettings({});
    const env = roleEnv('service', s, {
      serviceSigning: { kid: 'x' },
      viewKey: 'x',
      cursorSecret: 'x',
    });
    expect(env['DOCEDIT_DEMO_WEBHOOK_ALLOW']).toBe(webhookAllow(s));
    expect(env['DOCEDIT_DEMO_WEBHOOK_ALLOW']).toBe(`127.0.0.1:${s['DOCEDIT_DEMO_HOST_PORT']}`);
    expect(WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        'dep.workflow.participant_activated.v1',
        'dep.workflow.reminder_due.v1',
        'dep.workflow.completed.v1',
        'dep.workflow.finalised.v1',
        'dep.comment.mentioned.v1',
        'dep.task.assigned.v1',
      ]),
    );
  });

  it('hands the secret the service issued to the host through DOCEDIT_HOST_WEBHOOK_SECRETS', () => {
    const s = stackSettings({});
    const host = roleEnv('host', s, {
      apiKey: { id: 'i', secret: 's', credential: 'c' },
      hostSigning: { kid: 'k' },
      webhookSecret: 'whsec_demo',
    });
    expect(host['DOCEDIT_HOST_WEBHOOK_SECRETS']).toBe('whsec_demo');
    expect(
      roleEnv('host', s, {
        apiKey: { id: 'i', secret: 's', credential: 'c' },
        hostSigning: { kid: 'k' },
      }),
    ).not.toHaveProperty('DOCEDIT_HOST_WEBHOOK_SECRETS');
    expect(
      roleEnv('service', s, { serviceSigning: { kid: 'x' }, viewKey: 'x', cursorSecret: 'x' }),
    ).not.toHaveProperty('DOCEDIT_HOST_WEBHOOK_SECRETS');
  });

  it('registers once, keeps the subscription when the secret is known and replaces it when it is not', async () => {
    const w = await world(true);
    const client = w.h.host.service;
    const url = `http://${w.endpoint}${WEBHOOK_PATH}`;
    const again = await ensureSubscription(client, {
      url,
      events: WEBHOOK_EVENTS,
      knownSecret: w.secretRef.value,
    });
    expect(again).toMatchObject({ action: 'kept', id: w.subscription, secret: w.secretRef.value });
    const lost = await ensureSubscription(client, {
      url,
      events: WEBHOOK_EVENTS,
      knownSecret: undefined,
    });
    expect(lost.action).toBe('created');
    expect(lost.id).not.toBe(w.subscription);
    expect(lost.secret).not.toBe(w.secretRef.value);
    const all = await client.listWebhooks();
    expect(all.filter((x) => x.url === url)).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain('whsec_');
  });
});

describe('"send for completion" reaches the host (UX-105 criteria 2 and 4)', () => {
  it('mails the first participant an invitation through the egress exception, with a link and no token', async () => {
    const w = await world(true);
    await sendForCompletion(w.deps.host, w.deps.store, {
      doc: w.doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    const mail = await until(() => w.mails[0]);
    expect(mail, 'an invitation arrives').toBeDefined();
    expect(mail?.to).toBe('tess@people.example.test');
    expect(mail?.subject).toContain('You are asked to complete');
    expect(mail?.text).toMatch(/\/fill\/[A-Za-z0-9_-]{20,}/);
    expect(mail?.text).not.toMatch(/token|bearer|eyJ/i);
    const rows = await w.deliveries.ofSubscription(w.h.tenant, w.subscription);
    expect(rows.some((r) => r.eventType === 'dep.workflow.participant_activated.v1')).toBe(true);
    expect(rows.every((r) => r.state === 'delivered' && r.lastReason === null)).toBe(true);
  });

  it('delivers nothing and records the refusal when the exception is not configured (criterion 3)', async () => {
    const w = await world(false);
    await sendForCompletion(w.deps.host, w.deps.store, {
      doc: w.doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    const row = await until(async () => {
      const rows = await w.deliveries.ofSubscription(w.h.tenant, w.subscription);
      return rows.find((r) => r.state !== 'pending');
    });
    expect(row?.state).toBe('failed');
    expect(row?.lastReason).toBe('loopback');
    await new Promise((r) => setTimeout(r, 300));
    expect(w.mails).toEqual([]);
  });

  it('does not reach another port of the same address', async () => {
    // The exception names the receiver's port only: a subscription for the receiver's neighbour
    // (here the service's own port) is refused as before.
    const w = await world(true);
    const own = new URL(w.h.service.url);
    const other = await w.h.host.service.createWebhook({
      url: `http://127.0.0.1:${own.port}/webhooks/dep`,
      events: ['dep.workflow.participant_activated.v1'],
    });
    await sendForCompletion(w.deps.host, w.deps.store, {
      doc: w.doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    const row = await until(async () => {
      const rows = await w.deliveries.ofSubscription(w.h.tenant, other.id);
      return rows.find((r) => r.state !== 'pending');
    });
    expect(row?.lastReason).toBe('loopback');
  });
});
