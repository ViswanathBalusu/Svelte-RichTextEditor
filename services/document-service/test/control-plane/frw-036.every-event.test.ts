// FRW-036 criterion 1 through the composed service: each workflow event that a built path raises is
// delivered as a signed CloudEvents webhook through the real egress proxy (a fake resolver and
// connector only), once per occurrence, with small data that holds the `seq` and the chain head.
// Every path is driven through its route or the real data plane: the send, the first view (a
// participant's channel opens), the consent and the signing, the completion, the decline, the void,
// the remind, the deadline sweep, the wrong access code and the correction. `finalised` needs the
// signing service and a time-stamp authority; the live path raises it (FRW-053), and its data is checked in
// frw-053.live-seal.test.ts. Here the last test says that it is the one event this file does not drive. Memory storage and, when the test
// environment is up, PostgreSQL in Podman.
import { unsandboxed } from '@docedit/asset-worker';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import {
  MemoryDeliveryStore,
  type DeliveryRow,
} from '../../src/control-plane/webhook-dispatcher.ts';
import type {
  ConnectInput,
  ConnectResult,
  Connector,
  Resolver,
} from '../../src/control-plane/webhook-egress.ts';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import { sweepTenant } from '../../src/workflow/schedule-sweep.ts';
import { DepClient } from '../data-plane/client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const NAMES = [
  'sent',
  'participant_activated',
  'participant_viewed',
  'field_completed',
  'participant_completed',
  'participant_declined',
  'auth_failed',
  'reminder_due',
  'corrected',
  'voided',
  'expired',
  'completed',
  'finalised',
] as const;
type Name = (typeof NAMES)[number];

const TEXT_ID = 'esign-consent';
const VERSION = 1;
const HOUR = 3_600_000;
const CODE = `CODE-${uuid7().slice(-12)}`;
/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const SIG = 'fe00000000000001';
const DATE = 'fe00000000000002';

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[0]!.content.push({
    type: 'role_def',
    attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const ff = (id: string, key: string, kind: string) => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee: 'tenant', required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pEvery0000000036' },
    content: [
      ff(SIG, 'tenant.sig', 'signature'),
      { type: 'text', text: ' ' },
      ff(DATE, 'tenant.date', 'dateSigned'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string, extra: Record<string, unknown> = {}, auth?: unknown) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c36',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: VERSION },
  participants: [
    {
      id: 'p1',
      roles: ['tenant'],
      kind: 'signer',
      order: 1,
      sub: 'sub-p1',
      ...(auth !== undefined ? { auth } : {}),
    },
  ],
  ...extra,
});

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`every workflow event as a webhook (${storage}; FRW-036)`, async () => {
    const skip = await skipReason(storage);
    const texts = new MemoryConsentTextStore();
    const deliveries = new MemoryDeliveryStore();
    const sent: { host: string; headers: Record<string, string>; body: string }[] = [];
    const clients: DepClient[] = [];
    let h: Harness;
    let subscription = '';

    beforeAll(async () => {
      if (skip) return;
      const resolver: Resolver = { resolve: () => Promise.resolve(['93.184.216.34']) };
      const connector: Connector = {
        send(input: ConnectInput): Promise<ConnectResult> {
          sent.push({ host: input.url.hostname, headers: input.headers, body: input.body });
          return Promise.resolve({
            remoteAddress: input.address,
            status: 204,
            location: undefined,
          });
        },
      };
      const settings = configFromEnv({
        DOCEDIT_WEBHOOKS: 'true',
        DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
        DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
        DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
        DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
      }).webhooks;
      h = await startHarness(storage, {
        config: { webhooks: settings, jobIdleMs: 20 },
        webhooks: { deliveries, egress: { resolver, connector } },
        realDataPlane: true,
        views: FULL_VIEWS,
        assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
        parts: { consentTexts: texts },
      });
      texts.put(h.tenant, TEXT_ID, VERSION, 'I agree to sign electronically. Test text only.');
      const created = await h.call('POST', '/v1/webhooks', {
        token: h.apiKey,
        body: {
          url: 'https://public.example.test/hook',
          events: NAMES.map((n) => `dep.workflow.${n}.v1`),
        },
      });
      expect(created.status, created.text).toBe(201);
      subscription = created.json.id as string;
    }, 60_000);
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const token = (doc: string, pid = 'p1') =>
      h.userToken({ [doc]: 'filler' }, { sub: `sub-${pid}`, wfp: pid });

    async function workflow(extra: Record<string, unknown> = {}, auth?: unknown) {
      const doc = await h.createDocument({ content: document() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-036e-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc, extra, auth),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(r.status, r.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    /** The participant opens the document: the first view moves the workflow to `in_progress`. */
    async function view(doc: string, owner: string) {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(token(doc))).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
      for (let i = 0; i < 100; i++) {
        const w = await h.call('GET', `/v1/documents/${doc}/workflow`, { token: owner });
        if (w.json.state === 'in_progress') return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the workflow did not reach in_progress');
    }

    const rowsOf = async (): Promise<DeliveryRow[]> => {
      await h.service.webhooks?.drain();
      return deliveries.ofSubscription(h.tenant, subscription);
    };
    /** The event names delivered for one document, in the order of the rows. */
    const delivered = async (doc: string): Promise<string[]> =>
      (await rowsOf())
        .map((r) => JSON.parse(r.body) as { type: string; subject: string })
        .filter((b) => b.subject === doc)
        .map((b) => b.type.replace(/^dep\.workflow\./, '').replace(/\.v1$/, ''));

    async function readyAsset(doc: string): Promise<string> {
      const tok = token(doc);
      const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
        token: tok,
        body: { filename: 'sig.png', mime: 'image/png', size: PNG.length },
      });
      expect(r.status, r.text).toBe(201);
      const asset = r.json.asset as string;
      await h.service.assets.putQuarantined(h.tenant, asset, PNG);
      expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: tok })).status).toBe(
        202,
      );
      let row = await h.parts.assetRegistry.get(h.tenant, asset);
      for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        row = await h.parts.assetRegistry.get(h.tenant, asset);
      }
      expect(row?.state).toBe('ready');
      return asset;
    }

    const seen = new Set<string>();
    const expectOnce = async (doc: string, expected: string[]) => {
      const got = await delivered(doc);
      expect([...got].sort()).toEqual([...expected].sort());
      for (const n of got) seen.add(n);
    };

    it.skipIf(skip)(
      'first view, signing, completion: participant_viewed, field_completed, participant_completed and completed, once each',
      async () => {
        const { doc, owner } = await workflow();
        await view(doc, owner);
        const asset = await readyAsset(doc);
        const consent = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/consent`,
          { token: token(doc), body: {} },
        );
        expect(consent.status, consent.text).toBe(200);
        const signed = await h.call('POST', `/v1/documents/${doc}/fields/${SIG}/sign`, {
          token: token(doc),
          body: { asset, mode: 'uploaded' },
          headers: { 'idempotency-key': `sign-${uuid7()}` },
        });
        expect(signed.status, signed.text).toBe(200);
        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/p1/complete`,
          {
            token: token(doc),
            body: {},
          },
        );
        expect(done.status, done.text).toBe(200);
        expect(done.json.state).toBe('completed');
        await expectOnce(doc, [
          'sent',
          'participant_activated',
          'participant_viewed',
          'field_completed',
          'participant_completed',
          'completed',
        ]);
      },
      60_000,
    );

    it.skipIf(skip)('a decline raises participant_declined once', async () => {
      const { doc, owner } = await workflow();
      await view(doc, owner);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/decline`, {
        token: token(doc),
        body: { reason: 'No' },
      });
      expect(r.status, r.text).toBe(200);
      await expectOnce(doc, [
        'sent',
        'participant_activated',
        'participant_viewed',
        'participant_declined',
      ]);
    });

    it.skipIf(skip)('a void raises voided once', async () => {
      const { doc, owner } = await workflow();
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/void`, {
        token: owner,
        body: { reason: 'Stop' },
      });
      expect(r.status, r.text).toBe(200);
      await expectOnce(doc, ['sent', 'participant_activated', 'voided']);
    });

    it.skipIf(skip)('a correction raises corrected once', async () => {
      const { doc, owner } = await workflow();
      await view(doc, owner);
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/correct`, { token: owner });
      expect(r.status, r.text).toBe(200);
      await expectOnce(doc, ['sent', 'participant_activated', 'participant_viewed', 'corrected']);
    });

    it.skipIf(skip)('the action remind raises reminder_due once', async () => {
      const { doc, owner } = await workflow();
      const r = await h.call('POST', `/v1/documents/${doc}/workflow/remind`, { token: owner });
      expect(r.status, r.text).toBe(200);
      await expectOnce(doc, ['sent', 'participant_activated', 'reminder_due']);
    });

    it.skipIf(skip)('the deadline sweep raises expired once', async () => {
      const { doc } = await workflow({ deadline: new Date(h.now() + HOUR).toISOString() });
      h.advance(HOUR);
      const done = await sweepTenant(
        {
          workflows: h.parts.workflows!,
          reminders: h.parts.reminders!,
          grants: h.parts.grants,
          logs: h.parts.logs,
          notifier: h.service.dataPlane,
          audit: h.parts.audit,
          now: h.now,
          controlWaitMs: 5000,
          events: h.service.events,
        },
        h.tenant,
      );
      expect(done.failed).toEqual([]);
      // The service has its own `workflow.schedule` job, which `advance` makes due as well, so
      // either run may do the expiry and the other finds the workflow already expired (the sweep
      // is written for several instances: only the one that moves the state raises the event).
      // The test asks for the one event, wherever it came from, and waits for the other run to
      // finish raising it.
      for (let i = 0; i < 200 && !(await delivered(doc)).includes('expired'); i++)
        await new Promise((r) => setTimeout(r, 25));
      await expectOnce(doc, ['sent', 'participant_activated', 'expired']);
    });

    it.skipIf(skip)('a wrong access code raises auth_failed once, without the code', async () => {
      const { doc, owner } = await workflow({}, { require: ['access_code'] });
      const reg = await h.call(
        'POST',
        `/v1/documents/${doc}/workflow/participants/p1/access-code`,
        {
          token: owner,
          body: { code: CODE },
        },
      );
      expect(reg.status, reg.text).toBe(204);
      const wrong = await h.call('POST', `/v1/documents/${doc}/workflow/participants/p1/verify`, {
        token: token(doc),
        body: { code: `${CODE}-wrong` },
      });
      expect(wrong.status, wrong.text).toBe(403);
      await expectOnce(doc, ['sent', 'participant_activated', 'auth_failed']);
      for (const r of await rowsOf()) expect(r.body).not.toContain(CODE);
    });

    it.skipIf(skip)(
      'every delivery is signed, goes to the one host and carries a seq and a chain head; twelve of the thirteen events were delivered',
      async () => {
        const rows = await rowsOf();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row).toMatchObject({ state: 'delivered', attempts: 1 });
          const request = sent.find((s) => s.headers['webhook-id'] === row.messageId)!;
          expect(request.host).toBe('public.example.test');
          expect(request.headers['webhook-signature']).toMatch(/^v1,/);
          const body = JSON.parse(row.body) as {
            type: string;
            data: Record<string, unknown>;
          };
          expect(body.type.startsWith('dep.workflow.')).toBe(true);
          expect(Number.isSafeInteger(body.data['seq'])).toBe(true);
          expect(body.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
          for (const key of Object.keys(body.data))
            expect(['workflow', 'document', 'seq', 'chainHead', 'participant']).toContain(key);
        }
        expect(new Set(sent.map((s) => s.host))).toEqual(new Set(['public.example.test']));
        // Only `finalised` was not driven here: it needs the signing service (frw-053.live-seal.test.ts).
        const missing = NAMES.filter((n: Name) => !seen.has(n));
        expect(missing).toEqual(['finalised']);
      },
    );
  });
}
