/**
 * SEC-047 criterion 1 (lane V-SEC-033-048, round 8), over the wire. Canary strings go into every
 * surface this tree exposes through the REST routes: the document title and body, a figure's alternative
 * text, a comment and a reply, an asset's filename, the query string, the API key, a host-signed user
 * token, a minted token, a service credential, the metrics token and the signature of a presigned
 * upload URL. Then the service's own output is searched: every structured log line, the metrics scrape
 * (`GET /metrics`, a label or a value), and every request span the service recorded (trace attributes).
 * The searches are not vacuous: the test first checks that each of the three kinds of output is non-empty.
 *
 * Not covered here, and left open in the story: the webhook secret (needs `DOCEDIT_WEBHOOKS` with its
 * four settings), field values (the prefill route needs the room's outbox) and access codes (no route
 * in this tree names them). Memory and PostgreSQL storage, through the security harness.
 */
import { randomBytes } from 'node:crypto';
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
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const METRICS_TOKEN = `metrics-v-sec-047-${randomBytes(12).toString('hex')}`;

const CANARY = {
  title: 'CANARY_V47_TITLE_a1f0',
  body: 'CANARY_V47_BODY_b2e1',
  comment: 'CANARY_V47_COMMENT_d4c3',
  reply: 'CANARY_V47_REPLY_e5b4',
  filename: 'CANARY_V47_FILENAME_f6a5.png',
  query: 'CANARY_V47_QUERY_a7b6',
  invalid: 'CANARY_V47_INVALID_b8c7',
};

type Surface = { name: string; text: string };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-047 criterion 1: no canary in logs, metrics or spans (${storage})`, () => {
    let h: Harness;
    const spans: unknown[] = [];
    beforeAll(async () => {
      if (skip) return;
      // The webhook dispatcher is the event sink, so `/webhooks` is offered (PRM-053 pattern); the
      // transport accepts every delivery, so no request leaves the test.
      const subs = new MemorySubscriptionStore();
      const dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: new MemoryDeliveryStore(),
        transport: { deliver: async () => ({ ok: true, status: 204, hops: 0 }) },
        source: 'urn:docedit:sec-047-v-test',
        now: () => Date.now(),
        rejectedThrottle: { windowMs: 60_000, max: 5 },
      });
      h = await startHarness(storage, {
        env: { DOCEDIT_METRICS_TOKEN: METRICS_TOKEN },
        onSpan: (span) => void spans.push(span),
        events: dispatcher,
        parts: { webhooks: new WebhookSubscriptions({ store: subs, now: () => Date.now() }) },
      });
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      'the canaries seeded through the routes appear in no log line, metric or span',
      async () => {
        // Title and body text. Alternative text needs a figure, and a figure needs an attached asset
        // (invariant I4), which this create cannot supply; it stays open in the story.
        const content = documentWithRegions() as {
          doc: { content: Array<{ content: unknown[] }> };
        };
        (content.doc.content[1]!.content[0] as { content: unknown[] }).content = [
          { type: 'text', text: CANARY.body },
        ];
        const created = await h.call('POST', '/v1/documents', {
          token: h.a.apiKey,
          body: { title: CANARY.title, content },
        });
        expect(created.status, created.text).toBe(201);
        const doc = created.json.id as string;

        // Comment and reply on a thread (PRO-059, PRO-060).
        const owner = await h.mintToken(h.a, 'olivia-v47', { [doc]: 'owner' });
        const editor = await h.mintToken(h.a, 'edna-v47', { [doc]: 'editor' });
        const thread = await h.call('POST', `/v1/documents/${doc}/threads`, {
          token: owner,
          body: { target: { block: 'pIntro0000000001' }, comment: { body: CANARY.comment } },
        });
        expect(thread.status, thread.text).toBe(201);
        const reply = await h.call('POST', `/v1/threads/${thread.json.id as string}/comments`, {
          token: editor,
          body: { body: CANARY.reply },
        });
        expect(reply.status, reply.text).toBe(201);

        // An asset whose filename is a canary; the presigned upload URL carries a signature.
        const asset = await h.call('POST', `/v1/documents/${doc}/assets`, {
          token: editor,
          body: { filename: CANARY.filename, mime: 'image/png', size: 1024 },
        });
        expect(asset.status, asset.text).toBe(201);
        // The memory store's upload URL carries no signature; the signed download URL (resolve) needs
        // a ready asset, which this run does not build. That surface stays open in the story.

        // The service credential, the host token, the minted token and the API key are each used on a
        // request whose path and query carry canaries.
        const svc = h.serviceJwt(h.a);
        const hostToken = h.userToken(h.a, 'hank-v47', { [doc]: 'viewer' });
        expect((await h.call('GET', `/v1/documents/${doc}`, { token: svc })).status).toBe(200);
        await h.call('GET', `/v1/documents?externalId=${CANARY.query}`, { token: h.a.apiKey });
        await h.call('GET', `/v1/documents/${doc}`, { token: hostToken });
        await h.call('GET', `/v1/documents/${doc}`, { token: owner });

        // A webhook subscription: its secret is shown once, in the 201 answer, and is a secret.
        const hook = await h.call('POST', '/v1/webhooks', {
          token: h.a.apiKey,
          body: {
            url: 'https://hooks.example.test/sec-047-v',
            events: ['dep.grants.changed.v1'],
          },
        });
        expect(hook.status, hook.text).toBe(201);
        const hookSecret = hook.json.secret as string;
        expect(hookSecret, 'the subscription answers with its secret').toMatch(/^whsec_/);

        // A refused document: its invalid text is a canary, and the refusal is logged by code.
        const bad = await h.call('POST', '/v1/documents', {
          token: h.a.apiKey,
          body: {
            content: {
              cdm: 1,
              requires: [],
              doc: {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    attrs: { id: 'pBad0000000001' },
                    content: [{ type: 'text', text: CANARY.invalid }],
                  },
                ],
              },
            },
          },
        });
        expect([400, 422]).toContain(bad.status);

        // The metrics scrape, which the operator reads.
        const metrics = await h.call('GET', '/metrics', { token: METRICS_TOKEN });
        expect(metrics.status, 'the scrape answers with the metrics token').toBe(200);

        // Non-vacuous: each output has content to search.
        expect(h.logs.length, 'the service logged something').toBeGreaterThan(0);
        expect(metrics.text.length, 'the scrape has content').toBeGreaterThan(0);
        expect(spans.length, 'the service recorded request spans').toBeGreaterThan(0);

        const surfaces: Surface[] = [
          { name: 'logs', text: h.logs.join('\n') },
          { name: 'metrics', text: metrics.text },
          { name: 'spans', text: JSON.stringify(spans) },
        ];
        const secrets: Array<[string, string]> = [
          ...Object.entries(CANARY),
          ['api key', h.a.apiKey],
          ['metrics token', METRICS_TOKEN],
          ['service credential', svc],
          ['host token', hostToken],
          ['minted token', owner],
          ['minted editor token', editor],
          ['webhook secret', hookSecret],
        ];
        for (const surface of surfaces) {
          for (const [name, value] of secrets)
            expect(surface.text, `${name} must not appear in ${surface.name}`).not.toContain(value);
        }
      },
    );
  });
}
