/**
 * PRM-053 criteria 1, 2 and 3 through the service as composed (05 §7; 07 §11, §14; BE-055, BE-056).
 * Lane U-PRM-052-067, round 3 fix.
 *
 * The earlier test (prm-053-webhook-events.test.ts) built its own dispatcher and passed it as the
 * event sink. Here the test builds no dispatcher: the service reads `DOCEDIT_WEBHOOKS` and its
 * settings through `configFromEnv`, and `startService` composes the dispatcher, the subscription
 * store shared with `/webhooks`, the delivery store and the egress proxy (webhook-composition.ts).
 *
 * - The main run replaces only the transport with a recorder, because the egress proxy refuses
 *   every non-public address and a test receiver is on loopback. Everything else is the composition.
 * - A second run keeps the composed egress proxy and shows that a loopback target is refused and
 *   recorded on the delivery row, so the proxy is the route that ships.
 * - Criterion 3 is shown for both codes: `permission_denied` (an editor changes a region's policy)
 *   and `invalid_op` (an editor changes a node identifier, invariant I2).
 *
 * The throttle window (60 s) and maximum (5) are test values; the spec gives no figure (ADR 0146).
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { configFromEnv } from '../../../services/document-service/src/config.ts';
import { MemoryDeliveryStore } from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
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
const INTRO = 'pIntro0000000001';
const TARGET = 'https://hooks.example.test/prm-053-composed';
const GRANTS = 'dep.grants.changed.v1';
const STATE = 'dep.region.state_changed.v1';
const REJECTED = 'dep.commit.rejected.v1';
const MAX = 5;

/** The DOCEDIT_* variables that switch webhook delivery on; every number is a test value. */
const ENV: Record<string, string> = {
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: String(MAX),
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
  DOCEDIT_WEBHOOK_SOURCE: 'urn:docedit:prm-053-composed',
};

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface Body {
  type: string;
  source: string;
  subject: string;
  data: Record<string, unknown>;
}

/** Records every send; answers 204, so each delivery is a success. */
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

  of(type: string): Array<Body & { headers: Record<string, string> }> {
    return this.sent
      .filter((s) => s.url === TARGET)
      .map((s) => ({ ...(JSON.parse(s.body) as Body), headers: s.headers }))
      .filter((b) => b.type === type);
  }
}

/** Polls `read` until it gives a value; fails after five seconds. */
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

describe('PRM-053 webhook settings (config.ts)', () => {
  it('leaves webhooks off by default and refuses DOCEDIT_WEBHOOKS without its settings', () => {
    expect(configFromEnv({}).webhooks).toBeNull();
    expect(() => configFromEnv({ DOCEDIT_WEBHOOKS: 'true' })).toThrow(/no default/);
    expect(configFromEnv(ENV).webhooks).toEqual({
      rejectedWindowMs: 60_000,
      rejectedMax: MAX,
      timeoutMs: 2000,
      maxRedirects: 0,
      source: 'urn:docedit:prm-053-composed',
    });
  });
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-053 permission events through the composed service (${storage})`, () => {
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

    const current = async () => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      expect(r.status).toBe(200);
      return { doc: loadDoc(r.json.doc as unknown), seq: Number(r.json.seq ?? 0) };
    };

    const etag = async () => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      expect(g.status).toBe(200);
      return g.headers.get('etag')!;
    };

    /** One attribute step on node `id`, submitted as `token` over the wire. */
    const submitAttr = async (token: string, id: string, attr: string, value: string) => {
      const cur = await current();
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

    t()('the composed dispatcher is the event sink of both planes', () => {
      expect(h.service.webhooks).not.toBeNull();
      expect(h.service.events).toBe(h.service.webhooks);
    });

    t()('criterion 1: a grant change is delivered as dep.grants.changed, signed', async () => {
      const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: h.a.apiKey,
        headers: { 'If-Match': await etag() },
        body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
      });
      expect(r.status, r.text).toBe(200);
      const body = await until(
        () => transport.of(GRANTS).find((b) => b.subject === doc),
        'the grant event',
      );
      expect(body.source).toBe('urn:docedit:prm-053-composed');
      expect(body.data).toMatchObject({ rev: expect.any(Number), seq: expect.any(Number) });
      expect(body.headers['webhook-id']).toMatch(/^msg_/);
      expect(body.headers['webhook-signature']).toMatch(/^v1,/);
    });

    t()('criterion 2: a region state change is delivered as dep.region.state_changed', async () => {
      const r = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: h.a.apiKey,
        body: { state: 'in_review' },
        headers: { 'If-Match': await etag() },
      });
      expect(r.status, r.text).toBe(200);
      const body = await until(
        () => transport.of(STATE).find((b) => b.subject === doc && b.data['state'] === 'in_review'),
        'the region state event',
      );
      expect(body.data).toMatchObject({ region: LEGAL, seq: expect.any(Number) });
    });

    t()(
      'criterion 3: a commit refused with permission_denied is raised as dep.commit.rejected',
      async () => {
        const editor = await h.mintToken(h.a, 'prm053c-editor', { [doc]: 'editor' });
        const r = await submitAttr(editor, OPEN, 'policy', 'confidential');
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
        const body = await until(
          () =>
            transport
              .of(REJECTED)
              .find((b) => b.subject === doc && b.data['code'] === 'permission_denied'),
          'the permission_denied event',
        );
        expect(body.data).toMatchObject({ seq: expect.any(Number) });
      },
    );

    t()(
      'criterion 3: a commit refused with invalid_op is raised as dep.commit.rejected',
      async () => {
        const editor = await h.mintToken(h.a, 'prm053c-editor', { [doc]: 'editor' });
        // I2: a node identifier never changes; giving pIntro another node's identifier is refused.
        const r = await submitAttr(editor, INTRO, 'id', 'pEnd000000000001');
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('invalid_op');
        const body = await until(
          () =>
            transport
              .of(REJECTED)
              .find((b) => b.subject === doc && b.data['code'] === 'invalid_op'),
          'the invalid_op event',
        );
        expect(body.data).toMatchObject({ seq: expect.any(Number) });
      },
    );

    t()('criterion 3: the rejections are throttled to the window maximum', async () => {
      const editor = await h.mintToken(h.a, 'prm053c-flood', { [doc]: 'editor' });
      for (let i = 0; i < 12; i++) {
        const r = await submitAttr(editor, OPEN, 'policy', 'confidential');
        expect(r.t).toBe('sync.reject');
      }
      await until(
        () => (transport.of(REJECTED).length >= MAX ? true : undefined),
        'the admitted rejections',
      );
      await new Promise((r) => setTimeout(r, 300));
      await h.service.webhooks!.drain();
      // Two refusals above plus twelve here: only the window maximum is delivered.
      expect(transport.of(REJECTED)).toHaveLength(MAX);
      expect(h.logs.some((l) => l.includes('"webhook.suppressed"'))).toBe(true);
    });
  });
}

describe('PRM-053 the composed egress proxy is the route out (memory)', () => {
  let h: Harness;
  const deliveries = new MemoryDeliveryStore();

  beforeAll(async () => {
    h = await startHarness('memory', { env: ENV, webhooks: { deliveries } });
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('refuses a loopback target and records the refusal on the delivery row', async () => {
    const sub = await h.call('POST', '/v1/webhooks', {
      token: h.a.apiKey,
      body: { url: 'http://127.0.0.1:56281/prm-053', events: [GRANTS] },
    });
    expect(sub.status, sub.text).toBe(201);
    const id = sub.json.id as string;
    const doc = await h.createDocument(h.a, documentWithRegions());
    const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
    const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
      token: h.a.apiKey,
      headers: { 'If-Match': g.headers.get('etag')! },
      body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
    });
    expect(r.status, r.text).toBe(200);
    const row = await until(async () => {
      const rows = await deliveries.ofSubscription(h.a.id, id);
      return rows.find((x) => x.state !== 'pending');
    }, 'the delivery row');
    expect(row).toMatchObject({ eventType: GRANTS, state: 'failed', lastReason: 'loopback' });
    expect(
      h.logs.some((l) => l.includes('"webhook.attempt.failed"') && l.includes('loopback')),
    ).toBe(true);
  });
});
