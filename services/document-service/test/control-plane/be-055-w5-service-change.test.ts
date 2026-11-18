// BE-055 criterion 2 through the composed service (05 section 7; lane w5): with `config.webhooks`
// the one debounced sink sits between everything that raises `dep.document.changed.v1` (the rooms and
// the REST routes) and the dispatcher. Two content replacements over HTTP in one window make one
// delivery at once, with `seq` and the hash-chain head; the second waits for the window, and stopping
// the service raises it, so the last state of a burst is not lost. The transport is the real
// `EgressProxy` over a fake resolver and connector. Test values only.
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import {
  MemoryDeliveryStore,
  type DeliveryRow,
} from '../../src/control-plane/webhook-dispatcher.ts';
import type { ConnectInput, ConnectResult } from '../../src/control-plane/webhook-egress.ts';
import { documentWithRegions, startHarness } from './support.ts';

function edited(text: string): Record<string, unknown> {
  const env = structuredClone(documentWithRegions()) as Record<string, unknown>;
  const walk = (n: unknown): boolean => {
    if (n === null || typeof n !== 'object') return false;
    const o = n as Record<string, unknown>;
    if (typeof o['text'] === 'string') {
      o['text'] = text;
      return true;
    }
    return Object.values(o).some(walk);
  };
  walk(env['doc']);
  return env;
}

describe('the composed service debounces dep.document.changed (BE-055 criterion 2)', () => {
  it('delivers the first change at once with seq and chainHead, holds the next, and raises it when the service stops', async () => {
    const deliveries = new MemoryDeliveryStore();
    const bodies: Record<string, unknown>[] = [];
    const settings = configFromEnv({
      DOCEDIT_WEBHOOKS: 'true',
      DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
      DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
      DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
      DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
    }).webhooks;
    const h = await startHarness('memory', {
      realDataPlane: true,
      config: { webhooks: settings },
      webhooks: {
        deliveries,
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
    let closed = false;
    try {
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/hook', events: ['dep.document.changed.v1'] },
      });
      expect(sub.status, sub.text).toBe(201);
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'BE-055' });

      const replace = async (text: string): Promise<void> => {
        const etag = (
          await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })
        ).headers.get('etag');
        const put = await h.call('PUT', `/v1/documents/${doc}/content`, {
          token: h.apiKey,
          body: edited(text),
          headers: { 'If-Match': etag! },
        });
        expect(put.status, put.text).toBe(204);
      };
      const rows = async (): Promise<DeliveryRow[]> => {
        await h.service.webhooks?.drain();
        return deliveries.ofSubscription(h.tenant, sub.json.id as string);
      };

      await replace('first replacement');
      expect(await rows()).toHaveLength(1);
      await replace('second replacement');
      expect(await rows()).toHaveLength(1);
      expect(bodies).toHaveLength(1);
      const first = bodies[0]!;
      expect(first['type']).toBe('dep.document.changed.v1');
      expect(first['subject']).toBe(doc);
      const data = first['data'] as Record<string, unknown>;
      expect(data['seq']).toBeTypeOf('number');
      expect(data['chainHead']).toMatch(/^[0-9a-f]{64}$/);

      // Stopping the service raises the change that waits for its window.
      await h.close();
      closed = true;
      const all = await deliveries.ofSubscription(h.tenant, sub.json.id as string);
      expect(all).toHaveLength(2);
      expect(bodies).toHaveLength(2);
      const second = bodies[1]!['data'] as Record<string, unknown>;
      expect(second['seq'] as number).toBeGreaterThan(data['seq'] as number);
      expect(second['chainHead']).toMatch(/^[0-9a-f]{64}$/);
      expect(second['chainHead']).not.toBe(data['chainHead']);
    } finally {
      if (!closed) await h.close();
    }
  });
});
