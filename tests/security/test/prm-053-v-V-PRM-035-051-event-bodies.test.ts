/**
 * PRM-053 criterion 4 (lane V-PRM-035-051): the bodies the composed service actually delivers are
 * small CloudEvents whose `subject` is the document, whose `data` carries `seq`, and which hold no
 * document content. The check reads the delivered bytes, not the builders in
 * packages/authority/src/permissions/events.ts.
 *
 * The control plane emits `rev` for `dep.grants.changed` (not `revision`, the name the authority
 * builder uses), so the allowed keys here are the builder's keys plus `rev`. Nothing else is allowed.
 * Memory and PostgreSQL storage; a PostgreSQL run skips when the shared container is not reachable.
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

const LEGAL = 'rLegal0000000001';
const OPEN = 'rOpen00000000001';
const TARGET = 'https://hooks.example.test/prm-053-v-bodies';
const GRANTS = 'dep.grants.changed.v1';
const STATE = 'dep.region.state_changed.v1';
const REJECTED = 'dep.commit.rejected.v1';
const SECRET_TEXT = 'confidential';

const ALLOWED_DATA_KEYS = new Set(['seq', 'rev', 'revision', 'region', 'state', 'code']);
const CONTENT_KEYS = [
  'steps',
  'text',
  'content',
  'marks',
  'attrs',
  'doc',
  'value',
  'html',
  'fragment',
];

const ENV: Record<string, string> = {
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '50',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
  DOCEDIT_WEBHOOK_SOURCE: 'urn:docedit:prm-053-v-bodies',
};

interface Sent {
  url: string;
  body: string;
}

class Recorder implements Transport {
  readonly sent: Sent[] = [];

  async deliver(req: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult> {
    this.sent.push({ url: req.url, body: req.body });
    return { ok: true, status: 204, hops: 0 };
  }

  bodies(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.url === TARGET)
      .map((s) => JSON.parse(s.body) as Record<string, unknown>);
  }
}

async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} did not arrive in time`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-053 criterion 4: delivered event bodies (${storage})`, () => {
    let h: Harness;
    let transport: Recorder;
    let doc: string;

    beforeAll(async () => {
      if (skip) return;
      transport = new Recorder();
      h = await startHarness(storage, { env: ENV, webhooks: { transport } });
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: { url: TARGET, events: [GRANTS, STATE, REJECTED] },
      });
      expect(sub.status, sub.text).toBe(201);
      doc = await h.createDocument(h.a, documentWithRegions());
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    const etag = async () => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      expect(g.status).toBe(200);
      return g.headers.get('etag')!;
    };

    const submitAttr = async (token: string, id: string, attr: string, value: string) => {
      const c0 = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      const cur = { doc: loadDoc(c0.json.doc as unknown), seq: Number(c0.json.seq ?? 0) };
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        await c.hello(token);
        await c.open(1, doc);
        return await c.submit(1, {
          id: uuid7(),
          base: cur.seq,
          steps: stepsJson([new AttrStep(at(cur.doc, id), attr, value)]),
        });
      } finally {
        c.terminate();
      }
    };

    t()(
      'every delivered body is a CloudEvent on the document with seq and no content',
      async () => {
        const g = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.a.apiKey,
          headers: { 'If-Match': await etag() },
          body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
        });
        expect(g.status, g.text).toBe(200);
        const s = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: h.a.apiKey,
          body: { state: 'in_review' },
          headers: { 'If-Match': await etag() },
        });
        expect(s.status, s.text).toBe(200);
        const editor = await h.mintToken(h.a, 'prm053v-editor', { [doc]: 'editor' });
        const r = await submitAttr(editor, OPEN, 'policy', SECRET_TEXT);
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');

        const types = [GRANTS, STATE, REJECTED];
        await until(
          () =>
            types.every((ty) => transport.bodies().some((b) => b['type'] === ty))
              ? true
              : undefined,
          'one body of each event type',
        );

        const mine = transport.bodies().filter((b) => types.includes(b['type'] as string));
        expect(mine.length).toBeGreaterThanOrEqual(3);
        for (const b of mine) {
          expect(b['specversion']).toBe('1.0');
          expect(b['subject']).toBe(doc);
          const data = b['data'] as Record<string, unknown>;
          expect(typeof data['seq']).toBe('number');
          for (const k of Object.keys(data)) {
            expect(
              ALLOWED_DATA_KEYS.has(k),
              `unexpected data key ${k} in ${String(b['type'])}`,
            ).toBe(true);
            expect(CONTENT_KEYS.includes(k)).toBe(false);
          }
          for (const v of Object.values(data)) {
            if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(255);
          }
          // The refused value must never leave the server in any delivered body.
          expect(JSON.stringify(b)).not.toContain(SECRET_TEXT);
        }
      },
    );
  });
}
