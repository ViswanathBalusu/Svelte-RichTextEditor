// BE-057 over HTTP, through the composed service with the real `EgressProxy` over a fake resolver
// and connector (ux-079-webhook-ping-replay.test.ts holds the route test of UX-079; this one asks
// what BE-057 asks): a rotation, a test ping, a replay and the secrets' home.
//   criterion 3: the test ping is signed with the subscription's secrets (a receiver verifies it)
//     and goes through the egress proxy, and is marked as a test;
//   criterion 4: the replay carries the same `webhook-id` as the delivery it repeats;
//   criterion 6: the secrets are in the secret store, not in the subscription store, and no log
//     line the service wrote holds one.
// Test values only.
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { MemorySecretStore } from '../../src/control-plane/secret-store.ts';
import { MemoryDeliveryStore } from '../../src/control-plane/webhook-dispatcher.ts';
import type { ConnectInput, ConnectResult } from '../../src/control-plane/webhook-egress.ts';
import { verifyDelivery } from '../../src/control-plane/webhook-signing.ts';
import { MemorySubscriptionStore } from '../../src/control-plane/webhook-subscriptions.ts';
import type { LogFields } from '../../src/log.ts';
import { startHarness } from './support.ts';

const settings = configFromEnv({
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
}).webhooks;

describe('webhook rotation, ping, replay and secrets (BE-057)', () => {
  it('signs the ping for every active secret, repeats the webhook-id on replay, and keeps secrets out of the store and the logs', async () => {
    const sent: ConnectInput[] = [];
    const logged: LogFields[] = [];
    const inner = new MemorySubscriptionStore();
    const secrets = new MemorySecretStore();
    const h = await startHarness('memory', {
      config: { webhooks: settings },
      parts: { webhookStore: inner, secretStore: secrets },
      logger: {
        info: (f) => logged.push(f),
        warn: (f) => logged.push(f),
        error: (f) => logged.push(f),
      },
      webhooks: {
        deliveries: new MemoryDeliveryStore(),
        egress: {
          resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
          connector: {
            send(input: ConnectInput): Promise<ConnectResult> {
              sent.push(input);
              return Promise.resolve({
                remoteAddress: input.address,
                status: 204,
                location: undefined,
              });
            },
          },
        },
      },
    });
    try {
      const created = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/be057', events: ['dep.document.changed.v1'] },
      });
      expect(created.status, created.text).toBe(201);
      const id = created.json.id as string;
      const first = created.json.secret as string;
      const etag1 = created.headers.get('etag')!;

      // Rotate: two secrets are active; the ping is signed so that either verifies it.
      const rotated = await h.call('PATCH', `/v1/webhooks/${id}`, {
        token: h.apiKey,
        body: { rotate: true },
        headers: { 'If-Match': etag1 },
      });
      expect(rotated.status, rotated.text).toBe(200);
      const second = rotated.json.secret as string;
      expect(second).not.toBe(first);

      const ping = await h.call('POST', `/v1/webhooks/${id}/ping`, { token: h.apiKey });
      expect(ping.status, ping.text).toBe(202);
      expect(sent).toHaveLength(1);
      const pinged = sent[0]!;
      const verifies = (secret: string, input: ConnectInput) =>
        verifyDelivery({
          headers: input.headers,
          body: input.body,
          secrets: [secret],
          now: Number(input.headers['webhook-timestamp']),
        }).ok;
      expect(verifies(first, pinged)).toBe(true);
      expect(verifies(second, pinged)).toBe(true);
      expect(verifies('whsec_' + Buffer.alloc(32, 7).toString('base64'), pinged)).toBe(false);
      expect(JSON.parse(pinged.body)).toMatchObject({ test: true });
      // It went through the egress proxy: the connector got the address the policy resolved.
      expect(pinged.address).toBe('93.184.216.34');

      // The replay repeats the delivery under the same webhook-id.
      const deliveryId = ping.json.deliveryId as string;
      const replay = await h.call('POST', `/v1/webhooks/${id}/deliveries/${deliveryId}/replay`, {
        token: h.apiKey,
      });
      expect(replay.status, replay.text).toBe(202);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.headers['webhook-id']).toBe(pinged.headers['webhook-id']);
      expect(verifies(first, sent[1]!)).toBe(true);

      // Retire the first: a receiver with only that one now fails on the next delivery.
      const etag2 = rotated.headers.get('etag')!;
      const retired = await h.call('PATCH', `/v1/webhooks/${id}`, {
        token: h.apiKey,
        body: { retire: true },
        headers: { 'If-Match': etag2 },
      });
      expect(retired.status, retired.text).toBe(200);
      await h.call('POST', `/v1/webhooks/${id}/ping`, { token: h.apiKey });
      expect(verifies(first, sent[2]!)).toBe(false);
      expect(verifies(second, sent[2]!)).toBe(true);

      // The secrets are in the secret store; the subscription store holds references only.
      const tenant = h.tenant;
      const row = await inner.get(tenant, id);
      expect(row?.secrets).toHaveLength(1);
      expect(row?.secrets[0]).toMatch(/^webhook-secret\//);
      expect(JSON.stringify(row)).not.toContain(first);
      expect(JSON.stringify(row)).not.toContain(second);
      expect(await secrets.get(tenant, row!.secrets[0]!)).toBe(second);
      // No log line of the run holds a secret.
      const everything = JSON.stringify(logged);
      expect(everything).not.toContain(first);
      expect(everything).not.toContain(second);
      expect(everything).not.toContain('whsec_');
    } finally {
      await h.close();
    }
  });
});
