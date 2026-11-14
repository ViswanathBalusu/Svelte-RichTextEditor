/**
 * PRM-051 criterion 4 (lane V-PRM-035-051): under a flood of refusals the throttled webhook
 * (PRM-053, the composed dispatcher) delivers only the window maximum, and every refused commit still
 * has its audit entry. Memory and PostgreSQL storage; the PostgreSQL run skips when the shared
 * container is not reachable.
 *
 * The throttle window (60 s) and maximum (5) are test values; the spec gives no figure (ADR 0146).
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import type {
  Transport,
  TransportResult,
} from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import { at, loadDoc, stepsJson } from './support/cdm.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const OPEN = 'rOpen00000000001';
const TARGET = 'https://hooks.example.test/prm-051-v-throttle';
const REJECTED = 'dep.commit.rejected.v1';
const MAX = 5;
const REFUSALS = 12;

const ENV: Record<string, string> = {
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: String(MAX),
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
  DOCEDIT_WEBHOOK_SOURCE: 'urn:docedit:prm-051-v-throttle',
};

class Recorder implements Transport {
  readonly sent: Array<{ url: string; body: string }> = [];

  async deliver(req: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult> {
    this.sent.push({ url: req.url, body: req.body });
    return { ok: true, status: 204, hops: 0 };
  }

  rejected(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.url === TARGET)
      .map((s) => JSON.parse(s.body) as Record<string, unknown>)
      .filter((b) => b['type'] === REJECTED);
  }
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} did not arrive in time`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-051 criterion 4: a refusal flood keeps every audit entry (${storage})`, () => {
    let h: Harness;
    let transport: Recorder;
    let doc: string;

    beforeAll(async () => {
      if (skip) return;
      transport = new Recorder();
      h = await startHarness(storage, { env: ENV, webhooks: { transport } });
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: { url: TARGET, events: [REJECTED] },
      });
      expect(sub.status, sub.text).toBe(201);
      doc = await h.createDocument(h.a, documentWithRegions());
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    t()(
      `${REFUSALS} refusals: every one is audited, the webhook delivers ${MAX}`,
      async () => {
        const editor = await h.mintToken(h.a, 'prm051v-flood', { [doc]: 'editor' });
        for (let i = 0; i < REFUSALS; i++) {
          const c0 = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
          const cur = { doc: loadDoc(c0.json.doc as unknown), seq: Number(c0.json.seq ?? 0) };
          const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
          try {
            await c.hello(editor);
            await c.open(1, doc);
            const r = await c.submit(1, {
              id: uuid7(),
              base: cur.seq,
              steps: stepsJson([new AttrStep(at(cur.doc, OPEN), 'policy', 'confidential')]),
            });
            expect(r.t).toBe('sync.reject');
            expect(r.d?.['code']).toBe('permission_denied');
          } finally {
            c.terminate();
          }
        }

        const entries = await until(async () => {
          const audit = h.parts.audit;
          if (!audit) throw new Error('the harness has no audit store');
          const rows = await audit.query(h.a.id, { doc, kind: 'commit.rejected', limit: 1000 });
          return rows.length >= REFUSALS ? rows : undefined;
        }, 'the audit entries of the refusals');
        expect(entries).toHaveLength(REFUSALS);
        for (const e of entries) {
          expect(e.doc).toBe(doc);
          expect(e.data['code']).toBe('permission_denied');
          expect(e.at).toBeGreaterThan(0);
        }

        await until(
          () => (transport.rejected().length >= MAX ? true : undefined),
          'the admitted deliveries',
        );
        await new Promise((r) => setTimeout(r, 300));
        await h.service.webhooks!.drain();
        expect(transport.rejected().filter((b) => b['subject'] === doc)).toHaveLength(MAX);
        expect(h.logs.some((l) => l.includes('"webhook.suppressed"'))).toBe(true);
      },
      60_000,
    );
  });
}
