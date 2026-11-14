// PRO-121 criterion 4: given a subscription to a private address, when a delivery is attempted,
// then no request reaches the target. This test uses the real egress proxy, the real Node.js
// connector and the system resolver. The target is a loopback server that counts every request it
// receives. The policy is not faked here (the fakes of webhook-egress.test.ts test the other rules).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from './events.ts';
import { MemoryDeliveryStore, WebhookDispatcher } from './webhook-dispatcher.ts';
import {
  EgressProxy,
  nodeConnector,
  systemResolver,
  type ConnectInput,
  type Connector,
  type Resolver,
} from './webhook-egress.ts';
import { MemorySubscriptionStore, type SubscriptionRecord } from './webhook-subscriptions.ts';
import { generateSecret } from './webhook-signing.ts';

const TENANT = 't-pro-121-private-target';
const T0 = 1_700_000_000_000;
const SOURCE = 'https://docs.example.test/events';
const EVENT = 'dep.document.changed.v1';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A loopback server that counts each request it receives. */
async function countingTarget(): Promise<{ port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(204);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { port: (server.address() as AddressInfo).port, hits: () => hits };
}

function rig(resolver: Resolver) {
  const attempts: ConnectInput[] = [];
  const real = nodeConnector(2000);
  const connector: Connector = {
    send(input: ConnectInput) {
      attempts.push(input);
      return real.send(input);
    },
  };
  const subs = new MemorySubscriptionStore();
  const rows = new MemoryDeliveryStore();
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: rows,
    transport: new EgressProxy({ resolver: resolver, connector, maxRedirects: 3 }),
    source: SOURCE,
    now: () => T0,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
  });
  return { subs, rows, dispatcher, attempts };
}

async function subscribe(subs: MemorySubscriptionStore, url: string): Promise<SubscriptionRecord> {
  const record: SubscriptionRecord = {
    id: uuid7(),
    tenant: TENANT,
    url,
    events: [EVENT],
    secrets: [generateSecret()],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  await subs.insert(record);
  return record;
}

const event: DepEvent = {
  type: EVENT,
  tenant: TENANT,
  subject: uuid7(),
  data: { seq: 1, chainHead: 'ab'.repeat(32) },
  time: T0,
};

// The system resolver is used for `localhost`, which is refused without being resolved.
// `hooks.lan.test` resolves (through a fixed answer) to a private address.
const noNames: Resolver = {
  resolve(host: string) {
    return Promise.reject(new Error(`unexpected lookup of ${host}`));
  },
};
const privateName: Resolver = {
  resolve(host: string) {
    if (host === 'hooks.lan.test') return Promise.resolve(['10.20.30.40']);
    return Promise.reject(new Error(`unexpected lookup of ${host}`));
  },
};

describe('PRO-121 criterion 4: a subscription to a private address receives no request', () => {
  it('refuses a loopback IP literal, with no request reaching the loopback target', async () => {
    const target = await countingTarget();
    const r = rig(systemResolver);
    const sub = await subscribe(r.subs, `http://127.0.0.1:${target.port}/hook`);
    await r.dispatcher.raise(event);
    await r.dispatcher.drain();
    const rows = await r.rows.ofSubscription(TENANT, sub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.lastReason).toBe('loopback');
    expect(r.attempts).toHaveLength(0);
    expect(target.hits()).toBe(0);
  });

  it('refuses the name localhost without resolving it, and sends nothing', async () => {
    const target = await countingTarget();
    const r = rig(noNames);
    const sub = await subscribe(r.subs, `http://localhost:${target.port}/hook`);
    await r.dispatcher.raise(event);
    await r.dispatcher.drain();
    const rows = await r.rows.ofSubscription(TENANT, sub.id);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.lastReason).toBe('loopback');
    expect(r.attempts).toHaveLength(0);
    expect(target.hits()).toBe(0);
  });

  it('refuses a name that resolves to a private address, and never connects to it', async () => {
    const r = rig(privateName);
    const sub = await subscribe(r.subs, 'http://hooks.lan.test/hook');
    await r.dispatcher.raise(event);
    await r.dispatcher.drain();
    const rows = await r.rows.ofSubscription(TENANT, sub.id);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.lastReason).toBe('private');
    expect(r.attempts).toHaveLength(0);
  });

  it('refuses the cloud metadata address as a literal, and never connects to it', async () => {
    const r = rig(noNames);
    const sub = await subscribe(r.subs, 'http://169.254.169.254/latest/meta-data/');
    await r.dispatcher.raise(event);
    await r.dispatcher.drain();
    const rows = await r.rows.ofSubscription(TENANT, sub.id);
    expect(rows[0]?.state).toBe('failed');
    expect(rows[0]?.lastReason).toBe('metadata');
    expect(r.attempts).toHaveLength(0);
  });
});
