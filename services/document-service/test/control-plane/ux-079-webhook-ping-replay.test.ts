// The test ping and the replay of a delivery over HTTP, through the composed service with the real
// `EgressProxy` over a fake resolver and connector (UX-079 criterion 2; ADR 0330 §2, accepted by
// owner decision 177; 05 section 6.2 and 7). Test values only.
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { MemoryDeliveryStore } from '../../src/control-plane/webhook-dispatcher.ts';
import type { ConnectInput, ConnectResult } from '../../src/control-plane/webhook-egress.ts';
import { startHarness } from './support.ts';

describe('POST /webhooks/{id}/ping and /deliveries/{deliveryId}/replay (UX-079 criterion 2)', () => {
  it('sends a marked test delivery, replays it under the same subscription only, and refuses others', async () => {
    const bodies: Record<string, unknown>[] = [];
    const settings = configFromEnv({
      DOCEDIT_WEBHOOKS: 'true',
      DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
      DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
      DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
      DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
    }).webhooks;
    const h = await startHarness('memory', {
      config: { webhooks: settings },
      webhooks: {
        deliveries: new MemoryDeliveryStore(),
        egress: {
          resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
          connector: {
            send(input: ConnectInput): Promise<ConnectResult> {
              bodies.push(JSON.parse(input.body) as Record<string, unknown>);
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
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/ping', events: ['dep.document.changed.v1'] },
      });
      expect(sub.status, sub.text).toBe(201);
      const id = sub.json.id as string;

      // A second subscription, to check that a delivery of one is not replayed under the other.
      const other = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/other', events: ['dep.document.changed.v1'] },
      });
      const otherId = other.json.id as string;

      const ping = await h.call('POST', `/v1/webhooks/${id}/ping`, { token: h.apiKey });
      expect(ping.status, ping.text).toBe(202);
      const deliveryId = ping.json.deliveryId as string;
      expect(typeof deliveryId).toBe('string');
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({ type: 'dep.webhook.test.v1', test: true });

      const replay = await h.call('POST', `/v1/webhooks/${id}/deliveries/${deliveryId}/replay`, {
        token: h.apiKey,
      });
      expect(replay.status, replay.text).toBe(202);
      expect(replay.json.deliveryId).toBe(deliveryId);
      expect(bodies).toHaveLength(2);

      // Another subscription does not own this delivery: not found, nothing sent.
      const foreign = await h.call(
        'POST',
        `/v1/webhooks/${otherId}/deliveries/${deliveryId}/replay`,
        { token: h.apiKey },
      );
      expect(foreign.status).toBe(404);
      expect(bodies).toHaveLength(2);

      // An unknown subscription is not found before any send.
      const unknown = await h.call(
        'POST',
        '/v1/webhooks/00000000-0000-7000-8000-000000000000/ping',
        { token: h.apiKey },
      );
      expect(unknown.status).toBe(404);
      expect(bodies).toHaveLength(2);

      // A user token is refused with forbidden on both routes.
      const user = h.userToken({});
      expect((await h.call('POST', `/v1/webhooks/${id}/ping`, { token: user })).status).toBe(403);
      expect(
        (
          await h.call('POST', `/v1/webhooks/${id}/deliveries/${deliveryId}/replay`, {
            token: user,
          })
        ).status,
      ).toBe(403);
      expect(bodies).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
