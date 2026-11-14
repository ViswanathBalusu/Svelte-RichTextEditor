/**
 * PRM-053 criteria 1, 2, 3 and 5 (05 §7; 07 §11, §14; BE-055): the host hears about permission
 * events. Lane U-PRM-052-067.
 *
 * - Criterion 1: a grant change over HTTP is delivered as `dep.grants.changed.v1` to a subscribed
 *   webhook. Criterion 2: a region state change is delivered as `dep.region.state_changed.v1`.
 * - Criterion 3: a commit refused with `permission_denied` is raised as `dep.commit.rejected.v1`
 *   by the room, through the event sink the composition passes (`DataPlaneDeps.events`).
 * - Criterion 5: a flood of refusals is throttled. The admitted count is bounded by the window
 *   maximum; the unit case runs 1,000 rejections at one instant in the dispatcher with no
 *   environment, and the service case sends a burst of refused commits over the wire.
 *
 * The delivery target is a recording `Transport`, the seam the dispatcher sends through, so the
 * test checks what would be sent and to which URL. The egress proxy (BE-056) is not run here.
 * The subscription store is in memory in both storage modes; the room's log and audit trail are
 * PostgreSQL in the PostgreSQL run.
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
  type DispatcherLogEntry,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import type {
  Transport,
  TransportResult,
} from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import { generateSecret } from '../../../services/document-service/src/control-plane/webhook-signing.ts';
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
const TARGET = 'https://hooks.example.test/prm-053';
const SOURCE = 'urn:docedit:prm-053-test';
const REJECTED = 'dep.commit.rejected.v1';
const WINDOW = { windowMs: 60_000, max: 5 };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface Body {
  type: string;
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

  /** The bodies sent to the target, of one event type. */
  of(type: string): Body[] {
    return this.sent
      .filter((s) => s.url === TARGET)
      .map((s) => JSON.parse(s.body) as Body)
      .filter((b) => b.type === type);
  }
}

/** Polls `read` until it gives a value; fails after five seconds. */
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} was not delivered in time`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- Criterion 5, in the dispatcher alone (no environment). ----------------------------------------

describe('PRM-053 criterion 5: a flood of rejections is throttled (dispatcher, memory)', () => {
  it('admits at most the window maximum of commit.rejected deliveries and counts the rest', async () => {
    const tenant = 'tenant-prm053-flood';
    const subs = new MemorySubscriptionStore();
    await subs.insert({
      id: uuid7(),
      tenant,
      url: TARGET,
      events: [REJECTED],
      secrets: [generateSecret()],
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    });
    const transport = new Recorder();
    const logs: DispatcherLogEntry[] = [];
    const T0 = 1_700_000_000_000;
    const dispatcher = new WebhookDispatcher({
      subscriptions: subs,
      deliveries: new MemoryDeliveryStore(),
      transport,
      source: SOURCE,
      now: () => T0,
      rejectedThrottle: WINDOW,
      log: (e) => logs.push(e),
    });
    const doc = uuid7();
    for (let i = 0; i < 1000; i++) {
      dispatcher.emit({
        type: REJECTED,
        tenant,
        subject: doc,
        data: { seq: i, code: 'permission_denied' },
        time: T0,
      });
    }
    await dispatcher.drain();
    expect(transport.of(REJECTED)).toHaveLength(WINDOW.max);
    expect(logs.filter((e) => e.event === 'suppressed')).toHaveLength(1000 - WINDOW.max);
  });
});

// --- Criteria 1 to 3 and the wire burst of criterion 5, over the real service. ---------------------

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-053 permission events reach the webhook (${storage})`, () => {
    let h: Harness;
    let transport: Recorder;
    let dispatcher: WebhookDispatcher;
    let doc: string;

    beforeAll(async () => {
      if (skip) return;
      const subs = new MemorySubscriptionStore();
      transport = new Recorder();
      dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: new MemoryDeliveryStore(),
        transport,
        source: SOURCE,
        now: () => Date.now(),
        rejectedThrottle: WINDOW,
      });
      h = await startHarness(storage, {
        events: dispatcher,
        parts: { webhooks: new WebhookSubscriptions({ store: subs, now: () => Date.now() }) },
      });
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: {
          url: TARGET,
          events: ['dep.grants.changed.v1', 'dep.region.state_changed.v1', REJECTED],
        },
      });
      expect(sub.status, sub.text).toBe(201);
      doc = await h.createDocument(h.a, documentWithRegions());
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    /** The stored content, as the service serves it, with its current seq. */
    const current = async () => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      expect(r.status).toBe(200);
      return { doc: loadDoc(r.json.doc as unknown), seq: Number(r.json.seq ?? 0) };
    };

    /** The grants ETag, read as the host. */
    const etag = async () => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      expect(g.status).toBe(200);
      return g.headers.get('etag')!;
    };

    /** One policy change on the open region, submitted as `token` over the wire. */
    const setPolicy = async (token: string, policy: string) => {
      const cur = await current();
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        await c.hello(token);
        await c.open(1, doc);
        return await c.submit(1, {
          id: uuid7(),
          base: cur.seq,
          steps: stepsJson([new AttrStep(at(cur.doc, OPEN), 'policy', policy)]),
        });
      } finally {
        c.terminate();
      }
    };

    t()(
      'criterion 1: a grant change is delivered as dep.grants.changed to the subscribed webhook',
      async () => {
        const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
          token: h.a.apiKey,
          headers: { 'If-Match': await etag() },
          body: { grants: [{ region: OPEN, principal: 'user:mallory', role: 'editor' }] },
        });
        expect(r.status, r.text).toBe(200);
        const body = await until(
          () => transport.of('dep.grants.changed.v1').find((b) => b.subject === doc),
          'the grant event',
        );
        expect(body.data).toMatchObject({ rev: expect.any(Number), seq: expect.any(Number) });
      },
    );

    t()('criterion 2: a region state change is delivered as dep.region.state_changed', async () => {
      const r = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
        token: h.a.apiKey,
        body: { state: 'in_review' },
        headers: { 'If-Match': await etag() },
      });
      expect(r.status, r.text).toBe(200);
      const body = await until(
        () =>
          transport
            .of('dep.region.state_changed.v1')
            .find((b) => b.subject === doc && b.data['state'] === 'in_review'),
        'the region state event',
      );
      expect(body.data).toMatchObject({
        region: LEGAL,
        rev: expect.any(Number),
        seq: expect.any(Number),
      });
    });

    t()(
      'criterion 3: a commit refused with permission_denied is raised as dep.commit.rejected',
      async () => {
        const editor = await h.mintToken(h.a, 'prm053-editor', { [doc]: 'editor' });
        const r = await setPolicy(editor, 'confidential');
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('permission_denied');
        const body = await until(
          () => transport.of(REJECTED).find((b) => b.subject === doc),
          'the rejection event',
        );
        expect(body.data).toMatchObject({ code: 'permission_denied', seq: expect.any(Number) });
      },
    );

    t()(
      'criterion 3: a commit refused with invalid_op (base ahead of the head) is raised as dep.commit.rejected',
      async () => {
        const cur = await current();
        const editor = await h.mintToken(h.a, 'prm053-invalid', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        let r: Awaited<ReturnType<WireClient['submit']>>;
        try {
          await c.hello(editor);
          await c.open(1, doc);
          r = await c.submit(1, {
            id: uuid7(),
            base: cur.seq + 100,
            steps: stepsJson([new AttrStep(at(cur.doc, OPEN), 'policy', 'confidential')]),
          });
        } finally {
          c.terminate();
        }
        expect(r.t).toBe('sync.reject');
        expect(r.d?.['code']).toBe('invalid_op');
        const body = await until(
          () =>
            transport
              .of(REJECTED)
              .find((b) => b.subject === doc && b.data['code'] === 'invalid_op'),
          'the invalid_op rejection event',
        );
        expect(body.data).toMatchObject({ code: 'invalid_op', seq: expect.any(Number) });
      },
    );

    t()(
      'criterion 5: a burst of refused commits over the wire is bounded by the window maximum',
      async () => {
        const before = transport.of(REJECTED).length;
        const editor = await h.mintToken(h.a, 'prm053-flood', { [doc]: 'editor' });
        for (let i = 0; i < 12; i++) {
          const r = await setPolicy(editor, 'confidential');
          expect(r.t).toBe('sync.reject');
        }
        // The room raises each refusal in the background; wait for the admitted ones to arrive.
        await until(
          () => (transport.of(REJECTED).length >= WINDOW.max ? true : undefined),
          'the admitted rejections',
        );
        await new Promise((r) => setTimeout(r, 300));
        await dispatcher.drain();
        // One permission_denied and one invalid_op were admitted by the two cases above.
        expect(before).toBe(2);
        expect(transport.of(REJECTED).length).toBe(WINDOW.max);
      },
    );
  });
}
