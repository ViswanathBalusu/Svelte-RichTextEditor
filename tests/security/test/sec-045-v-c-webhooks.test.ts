/**
 * SEC-045 criterion 1, the webhook routes (lane V-SEC-033-048, round 8): tenant A's API key is used
 * on tenant B's webhook identifier with `GET`, `PATCH` and `DELETE /v1/webhooks/{id}`, and on
 * `GET /v1/webhooks`. Each attack is refused (401, 403 or 404), none of B's subscription is changed,
 * and no response carries B's identifier, URL or signing secret. Memory and PostgreSQL storage; the
 * subscription store is in memory in both, as in PRM-053. The webhook dispatcher is the event sink
 * with a transport that accepts every delivery, so no request leaves the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import {
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const B_URL = 'https://hooks.example.test/v-sec-045-tenant-b';
const A_URL = 'https://hooks.example.test/v-sec-045-tenant-a';
const EVENTS = ['dep.grants.changed.v1'];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-045 criterion 1: tenant A cannot reach tenant B's webhooks (${storage})`, () => {
    let h: Harness;
    let idB: string;
    let secretB: string;
    beforeAll(async () => {
      if (skip) return;
      const dispatcher = new WebhookDispatcher({
        subscriptions: new MemorySubscriptionStore(),
        deliveries: new MemoryDeliveryStore(),
        transport: { deliver: async () => ({ ok: true, status: 204, hops: 0 }) },
        source: 'urn:docedit:sec-045-v-c-test',
        now: () => Date.now(),
        rejectedThrottle: { windowMs: 60_000, max: 5 },
      });
      h = await startHarness(storage, {
        events: dispatcher,
        parts: {
          webhooks: new WebhookSubscriptions({
            store: new MemorySubscriptionStore(),
            now: () => Date.now(),
          }),
        },
      });
      const b = await h.call('POST', '/v1/webhooks', {
        token: h.b.apiKey,
        body: { url: B_URL, events: EVENTS },
      });
      expect(b.status, b.text).toBe(201);
      idB = b.json.id as string;
      secretB = b.json.secret as string;
      const a = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: { url: A_URL, events: EVENTS },
      });
      expect(a.status, a.text).toBe(201);
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      "A's API key reads, changes and removes B's subscription by identifier only with refusals",
      async () => {
        const refused = (status: number) => expect([401, 403, 404]).toContain(status);

        const read = await h.call('GET', `/v1/webhooks/${idB}`, { token: h.a.apiKey });
        refused(read.status);
        expect(read.text).not.toContain(B_URL);
        expect(read.text).not.toContain(secretB);

        const patch = await h.call('PATCH', `/v1/webhooks/${idB}`, {
          token: h.a.apiKey,
          headers: { 'If-Match': '"1"', 'Content-Type': 'application/json' },
          body: { url: 'https://evil.example.test/steal' },
        });
        refused(patch.status);
        expect(patch.text).not.toContain(B_URL);
        expect(patch.text).not.toContain(secretB);

        const del = await h.call('DELETE', `/v1/webhooks/${idB}`, {
          token: h.a.apiKey,
          headers: { 'If-Match': '"1"' },
        });
        refused(del.status);

        // B's subscription is unchanged and still readable by B.
        const own = await h.call('GET', `/v1/webhooks/${idB}`, { token: h.b.apiKey });
        expect(own.status, own.text).toBe(200);
        expect(own.json.url).toBe(B_URL);
      },
    );

    t()("A's list of webhooks holds none of B's subscriptions", async () => {
      const list = await h.call('GET', '/v1/webhooks', { token: h.a.apiKey });
      expect(list.status, list.text).toBe(200);
      expect(list.text).toContain(A_URL); // non-vacuous: A sees its own subscription
      expect(list.text).not.toContain(idB);
      expect(list.text).not.toContain(B_URL);
      expect(list.text).not.toContain(secretB);
    });
  });
}
