// PRO-068 criteria 4 and 5 with a real HTTP receiver (lane w5): the composed service sends the test
// ping and the replays through the real `EgressProxy`; the connector makes a real HTTP request to
// a receiver that listens on an ephemeral loopback port (the policy resolver is a fake, because the
// policy refuses a loopback address by design), and the receiver verifies the signature as a
// subscriber would. Test values only.
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { MemoryDeliveryStore } from '../../src/control-plane/webhook-dispatcher.ts';
import type { ConnectInput, ConnectResult } from '../../src/control-plane/webhook-egress.ts';
import { verifyDelivery } from '../../src/control-plane/webhook-signing.ts';
import { startHarness } from './support.ts';

interface Received {
  headers: Record<string, string>;
  body: string;
}

const settings = configFromEnv({
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '5000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
}).webhooks;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

describe('a signed test delivery and a replay reach a real receiver (PRO-068 criteria 4 and 5)', () => {
  it('delivers the ping signed, and the replay again under the original webhook-id', async () => {
    const received: Received[] = [];
    const receiver = createServer((req, res) => {
      void readBody(req).then((body) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
        received.push({ headers, body });
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const port = (receiver.address() as AddressInfo).port;

    const h = await startHarness('memory', {
      config: { webhooks: settings },
      webhooks: {
        deliveries: new MemoryDeliveryStore(),
        egress: {
          resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
          connector: {
            // The request goes to the receiver; the address the policy approved is not used.
            send(input: ConnectInput): Promise<ConnectResult> {
              return new Promise((resolve, reject) => {
                const req = request(
                  {
                    host: '127.0.0.1',
                    port,
                    path: input.url.pathname,
                    method: 'POST',
                    headers: { ...input.headers, 'content-length': Buffer.byteLength(input.body) },
                  },
                  (res) => {
                    res.resume();
                    resolve({
                      remoteAddress: input.address,
                      status: res.statusCode ?? 0,
                      location: undefined,
                    });
                  },
                );
                req.on('error', reject);
                req.end(input.body);
              });
            },
          },
        },
      },
    });
    try {
      const created = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/receiver', events: ['dep.document.changed.v1'] },
      });
      expect(created.status, created.text).toBe(201);
      const id = created.json.id as string;
      const secret = created.json.secret as string;

      const ping = await h.call('POST', `/v1/webhooks/${id}/ping`, { token: h.apiKey });
      expect(ping.status, ping.text).toBe(202);
      expect(received).toHaveLength(1);
      const first = received[0]!;
      const verified = (r: Received) =>
        verifyDelivery({
          headers: r.headers,
          body: r.body,
          secrets: [secret],
          now: Number(r.headers['webhook-timestamp']),
        }).ok;
      expect(verified(first)).toBe(true);
      expect(JSON.parse(first.body)).toMatchObject({ type: 'dep.webhook.test.v1', test: true });

      const deliveryId = ping.json.deliveryId as string;
      const replay = await h.call('POST', `/v1/webhooks/${id}/deliveries/${deliveryId}/replay`, {
        token: h.apiKey,
      });
      expect(replay.status, replay.text).toBe(202);
      expect(received).toHaveLength(2);
      const again = received[1]!;
      expect(again.headers['webhook-id']).toBe(first.headers['webhook-id']);
      expect(again.body).toBe(first.body);
      expect(verified(again)).toBe(true);

      // A tampered body does not verify: the receiver's check is a real one.
      expect(verified({ headers: again.headers, body: again.body + ' ' })).toBe(false);
    } finally {
      await h.close();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });
});
