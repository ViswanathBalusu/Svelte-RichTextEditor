// Idempotency keys on the creating routes that exist beyond documents and exports (05 §6.1; PRO-043
// criterion 1): a retried POST with the same key replays the first response and creates nothing,
// for assets and webhook subscriptions, in memory and with PostgreSQL. Versions, threads, comments
// and imports are not built yet, so criterion 1 stays open (see the story's Notes).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const EVENTS = ['dep.document.changed.v1'];

// Webhook subscriptions have only a memory store (no PostgreSQL subscription store is built), so
// the PostgreSQL run exercises the PostgreSQL idempotency store with the memory subscriptions.
for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`idempotent creating routes, assets and webhooks (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          parts: {
            webhooks: new WebhookSubscriptions({
              store: new MemorySubscriptionStore(),
              now: () => Date.now(),
            }),
          },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)(
      'replays a webhook create with the same key and creates one subscription (PRO-043 criterion 1, webhooks)',
      async () => {
        const key = `k-${randomUUID()}`;
        const url = `https://hooks.example.test/${randomUUID()}`;
        const body = { url, events: EVENTS };
        const headers = { 'Idempotency-Key': key };
        const first = await h.call('POST', '/v1/webhooks', { token: h.apiKey, body, headers });
        expect(first.status).toBe(201);
        const second = await h.call('POST', '/v1/webhooks', { token: h.apiKey, body, headers });
        expect(second.status).toBe(201);
        expect(second.json).toEqual(first.json);
        expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
        const listed = await h.call('GET', '/v1/webhooks', { token: h.apiKey });
        const same = (listed.json.items as Array<{ url: string }>).filter((w) => w.url === url);
        expect(same).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      'replays an asset create with the same key and returns the first upload (PRO-043 criterion 1, assets)',
      async () => {
        const doc = await h.createDocument();
        const key = `k-${randomUUID()}`;
        const body = { filename: 'dot.png', mime: 'image/png', size: 68 };
        const path = `/v1/documents/${doc}/assets`;
        const headers = { 'Idempotency-Key': key };
        const first = await h.call('POST', path, { token: h.apiKey, body, headers });
        expect(first.status).toBe(201);
        const second = await h.call('POST', path, { token: h.apiKey, body, headers });
        expect(second.status).toBe(201);
        expect(second.json).toEqual(first.json);
        expect(second.json.asset).toBe(first.json.asset);
        expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
      },
    );
  });
}
