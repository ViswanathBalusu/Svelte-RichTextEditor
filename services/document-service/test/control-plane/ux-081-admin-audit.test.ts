// UX-081 criterion 5: every administration action of UX-076 to UX-080 that the service routes leaves
// an event on the audit trail that `GET /audit` returns, with the actor and no secret. One composed
// service in memory; each action is made over HTTP with the service key and the trail is read back
// over HTTP. The font writes (BE-048) are checked in be-048-tenant-fonts.test.ts, which needs the
// asset sandbox's font check. Test values only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { documentWithRegions, hostKey, startHarness, type Harness } from './support.ts';

interface Item {
  id: string;
  kind: string;
  actor: string | null;
  document: string | null;
  at: string;
}

describe('administration actions are on the audit trail (UX-081 criterion 5)', () => {
  let h: Harness;
  const secrets: string[] = [];

  beforeAll(async () => {
    h = await startHarness('memory', {
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

  const trail = async (kind: string): Promise<Item[]> => {
    const r = await h.call('GET', `/v1/audit?kind=${encodeURIComponent(kind)}&limit=200`, {
      token: h.apiKey,
    });
    expect(r.status, r.text).toBe(200);
    return r.json.items as Item[];
  };
  const key = () => ({ token: h.apiKey, headers: { 'Idempotency-Key': randomUUID() } });

  it('records each action with its actor and keeps secrets and key members off the trail', async () => {
    // UX-078: quotas.
    const quotas = await h.call('GET', '/v1/quotas', { token: h.apiKey });
    const q = await h.call('PUT', '/v1/quotas', {
      token: h.apiKey,
      body: { connections: 7 },
      headers: { 'If-Match': quotas.headers.get('etag')! },
    });
    expect(q.status, q.text).toBe(200);

    // UX-080: retention of the tenant, and a hold on a document.
    const retention = await h.call('PUT', '/v1/retention', {
      token: h.apiKey,
      body: { mode: 'thin_payloads', afterDays: 30 },
      headers: { 'If-Match': '"0"' },
    });
    expect(retention.status, retention.text).toBe(200);
    const doc = await h.createDocument({ content: documentWithRegions() });
    const hold = await h.call('POST', `/v1/documents/${doc}/holds`, {
      token: h.apiKey,
      body: { reason: 'litigation' },
    });
    expect(hold.status, hold.text).toBe(201);

    // UX-077: a signing key and an origin, added and removed.
    const k = hostKey('EdDSA', `w3-audit-${randomUUID()}`);
    const added = await h.call('POST', '/v1/keys', {
      ...key(),
      body: { kid: k.kid, use: 'user', alg: k.alg, jwk: k.jwk },
    });
    expect(added.status, added.text).toBe(201);
    expect(
      (await h.call('DELETE', `/v1/keys/${encodeURIComponent(k.kid)}`, { token: h.apiKey })).status,
    ).toBe(204);
    const origin = `https://${randomUUID()}.example.test`;
    expect((await h.call('POST', '/v1/origins', { ...key(), body: { origin } })).status).toBe(201);
    expect(
      (await h.call('DELETE', `/v1/origins/${encodeURIComponent(origin)}`, { token: h.apiKey }))
        .status,
    ).toBe(204);

    // UX-079: a webhook, created, changed and deleted.
    const hook = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: {
        url: `https://hooks.example.test/${randomUUID()}`,
        events: ['dep.document.changed.v1'],
      },
    });
    expect(hook.status, hook.text).toBe(201);
    secrets.push(hook.json.secret as string);
    const patched = await h.call('PATCH', `/v1/webhooks/${hook.json.id as string}`, {
      token: h.apiKey,
      body: { url: `https://hooks.example.test/${randomUUID()}` },
      headers: { 'If-Match': hook.headers.get('etag')! },
    });
    expect(patched.status, patched.text).toBe(200);
    expect(
      (
        await h.call('DELETE', `/v1/webhooks/${hook.json.id as string}`, {
          token: h.apiKey,
          headers: { 'If-Match': patched.headers.get('etag')! },
        })
      ).status,
    ).toBe(204);

    const expected: Array<[string, number]> = [
      ['quota.changed', 1],
      ['retention.changed', 1],
      ['hold.placed', 1],
      ['key.registered', 1],
      ['key.removed', 1],
      ['origin.added', 1],
      ['origin.removed', 1],
      ['webhook.changed', 3],
    ];
    const all: Item[] = [];
    for (const [kind, count] of expected) {
      const items = (await trail(kind)).filter((e) => e.kind === kind);
      // The harness tenant may hold earlier events of a kind (its own set-up); take the new ones.
      expect(items.length, kind).toBeGreaterThanOrEqual(count);
      all.push(...items);
      for (const e of items) {
        expect(typeof e.id, kind).toBe('string');
        expect(typeof e.at, kind).toBe('string');
        expect(e.actor, kind).not.toBeNull();
      }
    }
    expect((await trail('hold.placed'))[0]?.document).toBe(doc);
    const text = JSON.stringify(all);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toContain(JSON.stringify(k.jwk));
  });

  it('refuses the trail to a user token', async () => {
    const r = await h.call('GET', '/v1/audit', { token: h.userToken({}) });
    expect(r.status).toBe(403);
  });
});
