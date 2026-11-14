// The webhook subscription routes over real HTTP, through the request pipeline and the router, with
// in-memory storage (UX-079 criteria 2 and 3, the parts that are built; 05 section 6.2 and 7;
// 13 section 10). Test values only. PostgreSQL is not run here.
//
// Not claimed here: the test ping and the replay of deliveries (no route is defined for them in
// the protocol), font administration (no write path exists), and the audit of administration
// changes (the audit trail records no webhook change).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { startHarness, type Harness } from './support.ts';

const EVENTS = ['dep.document.changed.v1'];

describe('/webhooks over HTTP (UX-079)', () => {
  let h: Harness;
  let other: string;

  beforeAll(async () => {
    h = await startHarness('memory', {
      parts: {
        webhooks: new WebhookSubscriptions({
          store: new MemorySubscriptionStore(),
          now: () => Date.now(),
        }),
      },
    });
    // A second tenant with its own API key, to check that its subscriptions stay its own.
    const tenant = randomUUID();
    await h.parts.registry.putTenant(tenant, 'Other tenant');
    const key = newApiKey(tenant);
    await h.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    other = key.credential;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('creates a subscription with one secret shown once, and lists it without secrets', async () => {
    const created = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/docs', events: EVENTS },
    });
    expect(created.status).toBe(201);
    expect(created.json.secret).toMatch(/^whsec_/);
    expect(created.json.activeSecrets).toBe(1);
    expect(created.headers.get('etag')).toBe('"1"');
    const location = created.headers.get('location')!;
    expect(location).toBe(`${h.base}/v1/webhooks/${created.json.id}`);

    // A client that follows Location reaches the new subscription.
    const followed = await h.call('GET', location.slice(h.base.length), { token: h.apiKey });
    expect(followed.status).toBe(200);
    expect(followed.json.id).toBe(created.json.id);

    const list = await h.call('GET', '/v1/webhooks', { token: h.apiKey });
    expect(list.status).toBe(200);
    const row = (list.json.items as Array<Record<string, unknown>>).find(
      (r) => r['id'] === created.json.id,
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('secret');
    expect(row).not.toHaveProperty('secrets');
  });

  it('reads one subscription with its ETag, and refuses a stale or missing If-Match', async () => {
    const id = (
      await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/a', events: EVENTS },
      })
    ).json.id as string;

    const got = await h.call('GET', `/v1/webhooks/${id}`, { token: h.apiKey });
    expect(got.status).toBe(200);
    const etag = got.headers.get('etag')!;

    const noMatch = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/b' },
    });
    expect(noMatch.status).toBe(428);

    const stale = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/b' },
      headers: { 'If-Match': '"stale"' },
    });
    expect(stale.status).toBe(412);

    const fresh = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/b' },
      headers: { 'If-Match': etag },
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json.url).toBe('https://hooks.example.test/b');
  });

  it('rotates the secret: two secrets are active, a second rotation conflicts, and retire ends the old one', async () => {
    const id = (
      await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/rot', events: EVENTS },
      })
    ).json.id as string;
    let etag = (await h.call('GET', `/v1/webhooks/${id}`, { token: h.apiKey })).headers.get(
      'etag',
    )!;

    const rotated = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { rotate: true },
      headers: { 'If-Match': etag },
    });
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).toMatch(/^whsec_/);
    expect(rotated.json.activeSecrets).toBe(2);
    etag = rotated.headers.get('etag')!;

    const again = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { rotate: true },
      headers: { 'If-Match': etag },
    });
    expect(again.status).toBe(409);

    const retired = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { retire: true },
      headers: { 'If-Match': etag },
    });
    expect(retired.status).toBe(200);
    expect(retired.json).not.toHaveProperty('secret');
    expect(retired.json.activeSecrets).toBe(1);
  });

  it('deletes with If-Match (204), and the subscription is then not found', async () => {
    const id = (
      await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/del', events: EVENTS },
      })
    ).json.id as string;
    const etag = (await h.call('GET', `/v1/webhooks/${id}`, { token: h.apiKey })).headers.get(
      'etag',
    )!;

    const deleted = await h.call('DELETE', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      headers: { 'If-Match': etag },
    });
    expect(deleted.status).toBe(204);
    const gone = await h.call('GET', `/v1/webhooks/${id}`, { token: h.apiKey });
    expect(gone.status).toBe(404);
  });

  it('refuses a user token on every /webhooks route, with forbidden', async () => {
    const user = h.userToken({});
    const created = await h.call('POST', '/v1/webhooks', {
      token: user,
      body: { url: 'https://hooks.example.test/u', events: EVENTS },
    });
    expect(created.status).toBe(403);
    expect((await h.call('GET', '/v1/webhooks', { token: user })).status).toBe(403);
  });

  it("does not show another tenant's subscription: it is not found, not forbidden", async () => {
    const id = (
      await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: { url: 'https://hooks.example.test/t', events: EVENTS },
      })
    ).json.id as string;

    const list = await h.call('GET', '/v1/webhooks', { token: other });
    expect(list.status).toBe(200);
    expect(list.json.items).toEqual([]);
    expect((await h.call('GET', `/v1/webhooks/${id}`, { token: other })).status).toBe(404);
  });
});

describe('/webhooks when the server keeps no subscription store', () => {
  it('does not offer the routes', async () => {
    const bare = await startHarness('memory');
    try {
      const res = await bare.call('GET', '/v1/webhooks', { token: bare.apiKey });
      expect(res.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
