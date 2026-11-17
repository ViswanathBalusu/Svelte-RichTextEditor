// PRO-068 criterion 6 (05 section 6.2 and 7; lane w5): a subscription made over HTTP whose URL
// resolves to a private or link-local address is refused when a delivery is attempted, and no
// request leaves. The service is the composed one (`startService` with `config.webhooks`): the
// routes create the subscription, the event is raised by a real route (document creation), and the
// transport is the real `EgressProxy`; only the resolver and the connector are fakes. A public target
// is the control: it is sent, signed, with the same `webhook-id` on its row. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import {
  MemoryDeliveryStore,
  type DeliveryRow,
} from '../../src/control-plane/webhook-dispatcher.ts';
import type {
  ConnectInput,
  ConnectResult,
  Connector,
  Resolver,
} from '../../src/control-plane/webhook-egress.ts';
import { startHarness, type Harness } from './support.ts';

const ADDRESSES: Record<string, string[]> = {
  'public.example.test': ['93.184.216.34'],
  'internal.example.test': ['10.0.0.5'],
  'metadata.example.test': ['169.254.169.254'],
  'linklocal6.example.test': ['fe80::1'],
  'rebinding.example.test': ['93.184.216.34', '192.168.1.20'],
};
const EVENTS = ['dep.document.created.v1'];

describe('a webhook subscription whose URL resolves to a private address (PRO-068 criterion 6)', () => {
  let h: Harness;
  const deliveries = new MemoryDeliveryStore();
  const sent: { host: string; address: string; headers: Record<string, string> }[] = [];

  beforeAll(async () => {
    const resolver: Resolver = {
      resolve: (host: string) => Promise.resolve(ADDRESSES[host] ?? []),
    };
    const connector: Connector = {
      send(input: ConnectInput): Promise<ConnectResult> {
        sent.push({ host: input.url.hostname, address: input.address, headers: input.headers });
        return Promise.resolve({ remoteAddress: input.address, status: 204, location: undefined });
      },
    };
    const settings = configFromEnv({
      DOCEDIT_WEBHOOKS: 'true',
      DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
      DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
      DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
      DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
    }).webhooks;
    h = await startHarness('memory', {
      config: { webhooks: settings },
      webhooks: { deliveries, egress: { resolver, connector } },
    });
  });

  afterAll(async () => {
    await h?.close();
  });

  const subscribe = async (host: string): Promise<string> => {
    const created = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: { url: `https://${host}/hook`, events: EVENTS },
    });
    expect(created.status, created.text).toBe(201);
    return created.json.id as string;
  };

  const rowsOf = async (id: string): Promise<DeliveryRow[]> => {
    await h.service.webhooks?.drain();
    return deliveries.ofSubscription(h.tenant, id);
  };

  it('sends to a public target, signed, as the control', async () => {
    const id = await subscribe('public.example.test');
    await h.createDocument();
    const rows = await rowsOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'delivered', attempts: 1, lastReason: null });
    const request = sent.find((s) => s.host === 'public.example.test');
    expect(request?.address).toBe('93.184.216.34');
    expect(request?.headers['webhook-id']).toBe(rows[0]?.messageId);
    expect(request?.headers['webhook-signature']).toMatch(/^v1,/);
  });

  it.each([
    ['a private IPv4 address', 'internal.example.test'],
    ['the cloud metadata address', 'metadata.example.test'],
    ['an IPv6 link-local address', 'linklocal6.example.test'],
    ['a name with one private address among public ones', 'rebinding.example.test'],
  ])(
    'refuses %s: the delivery fails with its reason and no request leaves',
    async (_what, host) => {
      const before = sent.length;
      const id = await subscribe(host);
      await h.createDocument();
      const rows = await rowsOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('failed');
      expect(rows[0]?.lastReason).toBeTruthy();
      expect(rows[0]?.lastStatus).toBeNull();
      expect(sent.slice(before).filter((s) => s.host === host)).toEqual([]);
    },
  );
});
