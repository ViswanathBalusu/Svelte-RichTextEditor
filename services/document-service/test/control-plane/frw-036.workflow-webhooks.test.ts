// FRW-036 through the composed service (lane w4): the workflow events that a built path raises are
// delivered as signed CloudEvents webhooks through the real egress proxy (only the resolver and the
// connector are fakes), once per occurrence, with small data of identifiers, the `seq` and the chain
// head, and with no contact detail and no evidence personal data. The paths that raise events are the
// send, the correction, the resume, the decline and the void (FRW-027, FRW-032, FRW-033); the first view and the completion return
// their events to a route that does not exist yet (FRW-031, FRW-047), and the other events have no
// occurrence in the service yet: they are listed at the end with the reason.
import { uuid7 } from '@docedit/model';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
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
import { DepClient } from '../data-plane/client.ts';
import { recordCompletion, recordFirstView } from '../../src/workflow/progress.ts';
import type { TransitionDeps } from '../../src/workflow/transitions.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const WORKFLOW_EVENT_NAMES = [
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
const TYPES = WORKFLOW_EVENT_NAMES.map((n) => `dep.workflow.${n}.v1`);

/** The raisers that exist: the events they raise. The rest are listed with their reason below. */
const RAISED_BY_A_BUILT_PATH = [
  'sent',
  'participant_activated',
  'corrected',
  'participant_declined',
  'voided',
];

const PERSON = 'Ada Lovelace <ada@example.com>';
const PERSON_SUB = 'sub-ada-0192';

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pFields000000003' },
    content: [
      {
        type: 'form_field',
        attrs: {
          id: 'ffTenant00000001',
          key: 'tenant.name',
          kind: 'text',
          label: 'Name',
          assignee: 'tenant',
          required: true,
          value: null,
        },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca0',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: PERSON_SUB, name: PERSON },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2 },
  ],
});

const ALLOWED = ['workflow', 'document', 'seq', 'chainHead', 'participant'];
/** What a contact detail or an evidence value looks like: an address with an at sign, an IP address, a long number. */
const PERSONAL = /@|\b\d{1,3}(?:\.\d{1,3}){3}\b|\+?\d[\d\s().-]{8,}\d/;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`workflow webhooks (${storage}; FRW-036)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const deliveries = new MemoryDeliveryStore();
    const sent: { host: string; headers: Record<string, string>; body: string }[] = [];
    const clients: DepClient[] = [];

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
        config: { webhooks: settings },
        webhooks: { deliveries, egress: { resolver, connector } },
        realDataPlane: true,
      });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const deps = (): TransitionDeps => ({
      workflows: h.parts.workflows!,
      grants: h.parts.grants,
      logs: h.parts.logs,
      notifier: h.service.dataPlane,
      audit: h.parts.audit,
      now: h.now,
      controlWaitMs: 5000,
    });

    const rowsOf = async (id: string): Promise<DeliveryRow[]> => {
      await h.service.webhooks?.drain();
      return deliveries.ofSubscription(h.tenant, id);
    };

    it.skipIf(skip)(
      'delivers sent, participant_activated and corrected once each, signed, through the egress proxy (criterion 1, for the built paths)',
      async () => {
        const created = await h.call('POST', '/v1/webhooks', {
          token: h.apiKey,
          body: { url: 'https://public.example.test/hook', events: TYPES },
        });
        expect(created.status, created.text).toBe(201);
        const subscription = created.json.id as string;

        const doc = await h.createDocument({ content: document() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-036-${uuid7()}` });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: BODY(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        const client = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(client);
        expect((await client.hello(owner)).t).toBe('welcome');
        expect((await client.open(1, doc)).t).toBe('ch.opened');
        const ref = { tenant: h.tenant, doc };
        const typesOf = async () =>
          (await rowsOf(subscription))
            .filter((r) => (JSON.parse(r.body) as { subject: string }).subject === doc)
            .map((r) => r.eventType);

        // The send: one `sent` and one `participant_activated` for the one participant it activates.
        const key = `send-${uuid7()}`;
        const send = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
          token: owner,
          headers: { 'idempotency-key': key },
        });
        expect(send.status, send.text).toBe(200);
        expect(await typesOf()).toEqual([
          'dep.workflow.sent.v1',
          'dep.workflow.participant_activated.v1',
        ]);
        // The same request again raises nothing more: once per occurrence.
        const again = await h.call('POST', `/v1/documents/${doc}/workflow/send`, {
          token: owner,
          headers: { 'idempotency-key': key },
        });
        expect(again.status).toBe(200);
        expect((await typesOf()).length).toBe(2);

        // The first view opens the workflow; the correction raises `corrected`.
        expect(
          await recordFirstView(deps(), { ref, actor: 'p1', participant: 'p1' }),
        ).toMatchObject({ ok: true });
        const correct = await h.call('POST', `/v1/documents/${doc}/workflow/correct`, {
          token: owner,
        });
        expect(correct.status, correct.text).toBe(200);
        expect(await typesOf()).toEqual([
          'dep.workflow.sent.v1',
          'dep.workflow.participant_activated.v1',
          'dep.workflow.corrected.v1',
        ]);

        // The resume activates the participant again.
        const resume = await h.call('POST', `/v1/documents/${doc}/workflow/resume`, {
          token: owner,
        });
        expect(resume.status, resume.text).toBe(200);
        const rows = (await rowsOf(subscription)).filter(
          (r) => (JSON.parse(r.body) as { subject: string }).subject === doc,
        );
        expect(rows.map((r) => r.eventType)).toEqual([
          'dep.workflow.sent.v1',
          'dep.workflow.participant_activated.v1',
          'dep.workflow.corrected.v1',
          'dep.workflow.participant_activated.v1',
        ]);

        // Every delivery is a signed request to the subscription's host, with its row's `webhook-id`.
        for (const row of rows) {
          expect(row).toMatchObject({ state: 'delivered', attempts: 1 });
          const request = sent.find((s) => s.headers['webhook-id'] === row.messageId)!;
          expect(request.host).toBe('public.example.test');
          expect(request.headers['webhook-signature']).toMatch(/^v1,/);
          expect(request.headers['webhook-timestamp']).toMatch(/^\d+$/);
        }
        // Nothing else left the service for the workflow: every request went to that one target.
        expect(new Set(sent.map((s) => s.host))).toEqual(new Set(['public.example.test']));

        // The bodies are CloudEvents in structured JSON mode with small data (criteria 1, 2 and 4).
        const workflowId = send.json.id as string;
        for (const row of rows) {
          const body = JSON.parse(row.body) as {
            specversion: string;
            type: string;
            subject: string;
            datacontenttype: string;
            data: Record<string, unknown>;
          };
          expect(body).toMatchObject({
            specversion: '1.0',
            subject: doc,
            datacontenttype: 'application/json',
          });
          expect(body.type.startsWith('dep.workflow.')).toBe(true);
          expect(Object.keys(body.data).every((k) => ALLOWED.includes(k))).toBe(true);
          expect(body.data).toMatchObject({ workflow: workflowId, document: doc });
          expect(Number.isSafeInteger(body.data['seq'])).toBe(true);
          expect(body.data['chainHead']).toMatch(/^[0-9a-f]{64}$/);
          // No contact detail, no name, no `sub`, no address of a device.
          expect(row.body).not.toContain(PERSON_SUB);
          expect(row.body).not.toContain('Ada');
          // The identifiers, the number and the digest hold nothing that reads as a person or a device.
          for (const [name, value] of Object.entries(body.data)) {
            if (['chainHead', 'workflow', 'document'].includes(name)) continue;
            expect(String(value), JSON.stringify(body.data)).not.toMatch(PERSONAL);
          }
          expect(String(body.data['workflow'])).toMatch(/^[0-9a-f-]{36}$/);
          expect(String(body.data['document'])).toMatch(/^[0-9a-f-]{36}$/);
          // A participant event names its participant by identifier only (criterion 4).
          if (body.type === 'dep.workflow.participant_activated.v1')
            expect(body.data['participant']).toBe('p1');
          else expect(body.data).not.toHaveProperty('participant');
          // The data stays within what the published schema of the event lists.
          const schema = JSON.parse(
            readFileSync(
              new URL(`../../../../spec/dep/webhooks/${body.type}.schema.json`, import.meta.url),
              'utf8',
            ),
          ) as { properties: { data: { properties: Record<string, unknown> } } };
          for (const key of Object.keys(body.data))
            expect(Object.keys(schema.properties.data.properties), `${body.type} ${key}`).toContain(
              key,
            );
        }
        // The `seq` and the chain head are those of the control commit the transition wrote.
        const controls = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        const seqs = rows.map((r) => (JSON.parse(r.body) as { data: { seq: number } }).data.seq);
        // The send, the first view (which raises none), the correction and the resume each wrote
        // one (FRW-030 criterion 1).
        expect(controls).toHaveLength(4);
        expect(seqs[0]).toBe(controls[0]!.seq);
        expect(seqs[2]).toBe(controls[2]!.seq);
        expect(seqs[3]).toBe(controls[3]!.seq);
      },
    );

    it.skipIf(skip)(
      'raises participant events only with a participant: a first view and a completion return theirs for a route that is not built',
      async () => {
        const doc = await h.createDocument({ content: document() });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-036-${uuid7()}` });
        await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: BODY(doc),
          headers: { 'if-match': '"0"' },
        });
        const sentOk = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
        expect(sentOk.status, sentOk.text).toBe(200);
        const ref = { tenant: h.tenant, doc };
        const first = await recordFirstView(deps(), { ref, actor: 'p1', participant: 'p1' });
        const done = await recordCompletion(deps(), { ref, actor: 'p1', participant: 'p1' });
        // The functions name the events; no route raises them yet, so nothing is delivered for them.
        expect(first.ok && first.raised).toEqual([
          { name: 'participant_viewed', participant: 'p1' },
        ]);
        expect(done.ok && done.raised.map((r) => r.name)).toEqual([
          'participant_completed',
          'participant_activated',
        ]);
      },
    );
  });
}

describe('the events no path raises yet (FRW-036 criterion 1)', () => {
  it('lists the events a built path raises, so that the rest is stated rather than assumed', () => {
    const notRaised = WORKFLOW_EVENT_NAMES.filter((n) => !RAISED_BY_A_BUILT_PATH.includes(n));
    expect(notRaised).toEqual([
      'participant_viewed', // recordFirstView returns it; nothing calls it when a channel opens (FRW-031, FRW-038)
      'field_completed', // after a fill or sign commit: FRW-047
      'participant_completed', // recordCompletion returns it; the complete route is FRW-047
      'auth_failed', // the verification failure: FRW-040 and after
      'reminder_due', // the reminder schedule runs nowhere yet
      'expired', // the deadline job
      'completed', // recordCompletion returns it; the complete route is FRW-047
      'finalised', // the finalisation job: FRW-049
    ]);
  });
});
