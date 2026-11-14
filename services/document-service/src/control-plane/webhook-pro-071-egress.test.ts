// PRO-071 criteria 3, 4 and 5 (lane V-PRO-069-085): the egress proxy refuses private, loopback and
// link-local targets with no request sent; a host that resolves to a public address at registration
// and to a private one at delivery is refused; a replay goes through the same egress rules. The
// dispatcher is the real one, with the real EgressProxy as its transport. The connector and the
// resolver are fakes that count what would leave the process. No PostgreSQL is used here.
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type { DepEvent } from './events.ts';
import { MemoryDeliveryStore, WebhookDispatcher } from './webhook-dispatcher.ts';
import {
  EgressProxy,
  type ConnectInput,
  type ConnectResult,
  type Connector,
  type Resolver,
} from './webhook-egress.ts';
import { MemorySubscriptionStore, type SubscriptionRecord } from './webhook-subscriptions.ts';
import { generateSecret } from './webhook-signing.ts';

const TENANT = 't-V-PRO-069-085-egress';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const SOURCE = 'https://docs.example.test/events';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
const PUBLIC = '93.184.216.34';

/** A resolver whose answer for each host can change between calls, as a DNS rebinding would. */
function movableResolver(initial: Record<string, readonly string[]>): Resolver & {
  set(host: string, addresses: readonly string[]): void;
  calls: string[];
} {
  const table: Record<string, readonly string[]> = { ...initial };
  const calls: string[] = [];
  return {
    calls,
    set(host, addresses) {
      table[host] = addresses;
    },
    resolve(host: string): Promise<readonly string[]> {
      calls.push(host);
      const got = table[host];
      return got === undefined ? Promise.reject(new Error('no such host')) : Promise.resolve(got);
    },
  };
}

/** A connector that reports the checked address (an honest socket) and records every connection. */
function recordingConnector(): Connector & { calls: ConnectInput[] } {
  const calls: ConnectInput[] = [];
  return {
    calls,
    send(input: ConnectInput): Promise<ConnectResult> {
      calls.push(input);
      return Promise.resolve({ remoteAddress: input.address, status: 204, location: undefined });
    },
  };
}

function changed(seq: number): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant: TENANT,
    subject: SUBJECT,
    data: { seq, chainHead: CHAIN },
    time: T0,
  };
}

interface Rig {
  dispatcher: WebhookDispatcher;
  subs: MemorySubscriptionStore;
  rows: MemoryDeliveryStore;
  resolver: ReturnType<typeof movableResolver>;
  connector: ReturnType<typeof recordingConnector>;
}

function rig(initial: Record<string, readonly string[]>): Rig {
  const resolver = movableResolver(initial);
  const connector = recordingConnector();
  const transport = new EgressProxy({ resolver, connector, maxRedirects: 3 });
  const subs = new MemorySubscriptionStore();
  const rows = new MemoryDeliveryStore();
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: rows,
    transport,
    source: SOURCE,
    now: () => T0,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
  });
  return { dispatcher, subs, rows, resolver, connector };
}

async function subscribe(r: Rig, url: string): Promise<void> {
  const record: SubscriptionRecord = {
    id: uuid7(),
    tenant: TENANT,
    url,
    events: ['dep.document.changed.v1'],
    secrets: [generateSecret()],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  };
  await r.subs.insert(record);
}

describe('PRO-071 criterion 3: a target on a loopback, private or link-local address is refused with no request', () => {
  const refused: Array<[string, string]> = [
    ['https://127.0.0.1/hook', 'loopback'],
    ['https://10.20.30.40/hook', 'private'],
    ['https://192.168.1.1/hook', 'private'],
    ['https://169.254.169.254/latest/meta-data/', 'metadata'],
    ['https://169.254.10.10/hook', 'link-local'],
    ['https://[::1]/hook', 'loopback'],
    ['https://[fe80::1]/hook', 'link-local'],
    ['https://[fd00:ec2::254]/latest/meta-data/', 'metadata'],
    ['https://localhost/hook', 'loopback'],
  ];
  for (const [url] of refused) {
    it(`refuses ${url} and sends nothing`, async () => {
      const r = rig({});
      const proxy = new EgressProxy({
        resolver: r.resolver,
        connector: r.connector,
        maxRedirects: 3,
      });
      const got = await proxy.deliver({ url, headers: {}, body: '{}' });
      expect(got.ok).toBe(false);
      expect(r.connector.calls).toHaveLength(0);
    });
  }

  it('refuses a name that resolves to an IPv6 link-local address, and sends nothing', async () => {
    const r = rig({ 'v6.example.test': ['fe80::1'] });
    await subscribe(r, 'https://v6.example.test/hook');
    await r.dispatcher.raise(changed(1));
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(0);
  });
});

describe('PRO-071 criterion 4: a name that moves from a public to a private address is refused at delivery', () => {
  it('delivers while the name is public, then refuses the same name once it resolves to a private address', async () => {
    const r = rig({ 'rebind.example.test': [PUBLIC] });
    await subscribe(r, 'https://rebind.example.test/hook');

    await r.dispatcher.raise(changed(1));
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(1);
    expect(r.connector.calls[0]?.address).toBe(PUBLIC);

    r.resolver.set('rebind.example.test', ['10.0.0.5']);
    await r.dispatcher.raise(changed(2));
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(1);
    expect(
      r.resolver.calls.filter((h) => h === 'rebind.example.test').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('refuses a name when any one of its addresses is private, even if the first is public', async () => {
    const r = rig({ 'mixed.example.test': [PUBLIC, '127.0.0.1'] });
    await subscribe(r, 'https://mixed.example.test/hook');
    await r.dispatcher.raise(changed(3));
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(0);
  });
});

describe('PRO-071 criterion 5: a replay goes through the same egress rules', () => {
  it('refuses a replay whose target has moved to a private address, and sends nothing for it', async () => {
    const r = rig({ 'replay.example.test': [PUBLIC] });
    await subscribe(r, 'https://replay.example.test/hook');
    const [rowId] = await r.dispatcher.raise(changed(4));
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(1);

    r.resolver.set('replay.example.test', ['192.168.0.7']);
    await r.dispatcher.replay(TENANT, rowId ?? '');
    await r.dispatcher.drain();
    expect(r.connector.calls).toHaveLength(1);
  });
});
