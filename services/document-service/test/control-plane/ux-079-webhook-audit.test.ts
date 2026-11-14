// UX-079 criterion 3 (webhook part): a change to a webhook subscription is written to the audit
// trail with its identifier and the operation, never the secret, and a refused change is not
// audited. The audit kind `webhook.changed` is a proposed name (docs/adr/0330-lane-V-UX-076-090.md).
// In memory only; lane V-UX-076-090, round 1.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../src/control-plane/webhook-subscriptions.ts';
import { startHarness, type Harness } from './support.ts';

const EVENTS = ['dep.document.changed.v1'];

describe('/webhooks changes are audited (UX-079 criterion 3)', () => {
  let h: Harness;

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

  it('audits create, update and delete, with the identifier and the operation, and no secret', async () => {
    const tag = randomUUID();
    const created = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: { url: `https://hooks.example.test/${tag}`, events: EVENTS },
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const secret = created.json.secret as string;
    expect(secret).toMatch(/^whsec_/);

    const updated = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { url: `https://hooks.example.test/${tag}-b` },
      headers: { 'If-Match': created.headers.get('etag')! },
    });
    expect(updated.status).toBe(200);

    const deleted = await h.call('DELETE', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      headers: { 'If-Match': updated.headers.get('etag')! },
    });
    expect(deleted.status).toBe(204);

    const events = (
      await h.parts.audit!.query(h.tenant, { kind: 'webhook.changed', limit: 1000 })
    ).filter((e) => e.data['subscription'] === id);
    expect(events.map((e) => e.data['operation'])).toEqual(['created', 'updated', 'deleted']);
    expect(events.every((e) => e.doc === null && e.kind === 'webhook.changed')).toBe(true);
    // The secret is never on the trail.
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('does not audit a refused change', async () => {
    const created = await h.call('POST', '/v1/webhooks', {
      token: h.apiKey,
      body: { url: `https://hooks.example.test/${randomUUID()}`, events: EVENTS },
    });
    const id = created.json.id as string;

    // A stale If-Match is refused with 412, and a delete of a missing subscription with 404.
    const stale = await h.call('PATCH', `/v1/webhooks/${id}`, {
      token: h.apiKey,
      body: { url: 'https://hooks.example.test/stale' },
      headers: { 'If-Match': '"999"' },
    });
    expect(stale.status).toBe(412);
    const missing = await h.call('DELETE', `/v1/webhooks/${randomUUID()}`, {
      token: h.apiKey,
      headers: { 'If-Match': '"1"' },
    });
    expect(missing.status).toBe(404);

    const events = (
      await h.parts.audit!.query(h.tenant, { kind: 'webhook.changed', limit: 1000 })
    ).filter((e) => e.data['subscription'] === id);
    expect(events.map((e) => e.data['operation'])).toEqual(['created']);
  });
});
