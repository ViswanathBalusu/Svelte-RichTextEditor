/**
 * SEC-020 criterion 6, the metrics and service-log half (lane V-SEC-017-032): after webhook
 * deliveries have been made by the real service, neither its `/metrics` text nor its structured
 * log lines contain a webhook secret or a signature. The delivery target is a recording transport
 * (the seam the dispatcher sends through), so the signed headers are read from what was sent.
 *
 * Runs over memory and PostgreSQL through the security harness. The dispatcher's own log entries
 * are covered by sec-020-webhook-logs.test.ts (memory only).
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
import type {
  Transport,
  TransportResult,
} from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

const TARGET = 'https://hooks.example.test/sec-020-metrics';
const SOURCE = 'urn:docedit:sec-020-metrics-test';
const METRICS_TOKEN = 'metrics-token-V-SEC-017-032-not-a-secret';
const OPEN = 'rOpen00000000001';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

class Recorder implements Transport {
  readonly sent: Sent[] = [];
  async deliver(req: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult> {
    this.sent.push({ url: req.url, headers: { ...req.headers }, body: req.body });
    return { ok: true, status: 204, hops: 0 };
  }
}

/** Every string value in a JSON value, at any depth. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection (SEC harness)
  describe(`SEC-020 metrics and service logs carry no webhook secret (${storage})`, () => {
    let h: Harness;
    let transport: Recorder;
    let doc: string;
    let secrets: string[] = [];

    beforeAll(async () => {
      if (skip) return;
      const subs = new MemorySubscriptionStore();
      transport = new Recorder();
      const dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: new MemoryDeliveryStore(),
        transport,
        source: SOURCE,
        now: () => Date.now(),
        rejectedThrottle: { windowMs: 60_000, max: 5 },
      });
      h = await startHarness(storage, {
        events: dispatcher,
        env: { DOCEDIT_METRICS_TOKEN: METRICS_TOKEN },
        parts: { webhooks: new WebhookSubscriptions({ store: subs, now: () => Date.now() }) },
      });
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: { url: TARGET, events: ['dep.grants.changed.v1'] },
      });
      expect(sub.status, sub.text).toBe(201);
      // Every string the subscription answer carries that could be a secret, by its length.
      secrets = strings(sub.json).filter((s) => s.length >= 16 && !s.startsWith('http'));
      expect(secrets.length).toBeGreaterThan(0);
      doc = await h.createDocument(h.a, documentWithRegions());
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    t()(
      'no delivery secret, signature or payload marker appears in /metrics or the service logs',
      async () => {
        const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.a.apiKey,
          headers: { 'If-Match': g.headers.get('etag')! },
          body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
        });
        expect(r.status, r.text).toBe(200);

        // Wait for the delivery to reach the recording transport.
        const deadline = Date.now() + 5000;
        while (!transport.sent.some((s) => s.url === TARGET) && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 25));
        }
        const sent = transport.sent.filter((s) => s.url === TARGET);
        expect(sent.length).toBeGreaterThan(0);
        const signatures = sent.flatMap((s) =>
          Object.entries(s.headers)
            .filter(([k]) => k.toLowerCase().startsWith('webhook-signature'))
            .map(([, v]) => v),
        );
        expect(signatures.length).toBeGreaterThan(0);

        const metrics = await fetch(`${h.base}/metrics`, {
          headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
        });
        expect(metrics.status).toBe(200);
        const text = await metrics.text();
        expect(text.length).toBeGreaterThan(0);

        const logText = h.logs.join('\n');
        for (const secret of secrets) {
          expect(text, 'metrics text carries a secret').not.toContain(secret);
          expect(logText, 'service logs carry a secret').not.toContain(secret);
        }
        for (const sig of signatures) {
          expect(text, 'metrics text carries a signature').not.toContain(sig);
          expect(logText, 'service logs carry a signature').not.toContain(sig);
        }
      },
    );
  });
}
