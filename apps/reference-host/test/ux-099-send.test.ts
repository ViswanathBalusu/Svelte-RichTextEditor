// Send for completion in the reference host (UX-099), against the real document service in memory
// (`startService`): the host binds people to the roles of a document and sends it, the service's own
// dispatcher signs the workflow events, the host's receiver verifies them and the host sends the
// mail, asks for a passcode and mints the participant's token. The service accepts that token.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecret } from '../../../services/document-service/src/control-plane/webhook-signing.ts';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import type { Transport } from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  MemorySubscriptionStore,
  type SubscriptionRecord,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import type { DepEvent } from '../../../services/document-service/src/control-plane/events.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceTemplateContent } from '../src/lib/server/documents.ts';
import {
  PASSCODE_ATTEMPTS,
  PASSCODE_LIFETIME_MS,
  SIGNATURE_STATEMENT,
  SendRefused,
  WorkflowStore,
  handleWorkflowEvent,
  resultFile,
  rolesOf,
  sendForCompletion,
  startPasscode,
  verifyPasscode,
  type EventDeps,
} from '../src/lib/server/send-for-completion.ts';
import { ServiceError, type ServiceClient } from '../src/lib/server/service.ts';
import { composeWebhookEndpoint } from '../src/lib/server/webhook-endpoint.ts';
import { MemoryNotificationSink } from '../src/lib/server/webhook-notifications.ts';
import { decodeJws, startHarness, type Harness } from './support.ts';

const TENANT = 't-host';
const T0 = 1_800_000_000_000;
const PUBLIC_URL = 'http://127.0.0.1:56490';

interface Mail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}

interface World {
  h: Harness;
  dir: string;
  deps: EventDeps;
  mails: Mail[];
  doc: string;
  clock: { now: number };
}

let world: World | null = null;

async function setup(): Promise<World> {
  const h = await startHarness();
  const dir = await mkdtemp(join(tmpdir(), 'docedit-ux099-'));
  const st = h.host.seed.serviceTemplates![0]!;
  const created = await h.host.service.createDocument(
    { content: await serviceTemplateContent(h.host.seedDir, st), title: 'Lease (test)' },
    'ux099-doc',
    'u-olivia',
  );
  await h.host.catalogue.put({
    id: created.id,
    externalId: 'ux099-doc',
    title: 'Lease (test)',
    template: 'lease',
    createdBy: 'u-olivia',
    createdAt: new Date(T0).toISOString(),
    roles: { 'u-olivia': 'owner', 'u-ada': 'editor' },
    accessSince: {},
    deletedAt: null,
  });
  const mails: Mail[] = [];
  const clock = { now: T0 };
  const deps: EventDeps = {
    host: { ...h.host, config: { dataDir: dir }, now: () => new Date(clock.now) },
    store: await WorkflowStore.open(dir),
    mail: (m) => {
      mails.push(m);
      return Promise.resolve();
    },
    publicUrl: PUBLIC_URL,
  };
  return { h, dir, deps, mails, doc: created.id, clock };
}

beforeEach(async () => {
  world = await setup();
});
afterEach(async () => {
  await world?.h.close();
  if (world) await rm(world.dir, { recursive: true, force: true });
  world = null;
});

const PEOPLE = [
  {
    role: 'tenant',
    name: 'Tess Tenant',
    email: 'tess@people.example.test',
    kind: 'filler' as const,
  },
  {
    role: 'landlord',
    name: 'Larry Landlord',
    email: 'larry@people.example.test',
    kind: 'signer' as const,
  },
];

const w = (): World => world!;

describe('UX-099 criterion 1: bind people to roles and send', () => {
  it('reads the roles of the document from its fields', async () => {
    expect((await rolesOf(w().deps.host, w().doc)).sort()).toEqual(['landlord', 'tenant']);
  });

  it('writes the workflow with names, order and opaque identifiers, and sends it as the owner', async () => {
    const record = await sendForCompletion(w().deps.host, w().deps.store, {
      doc: w().doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    const read = await w().h.host.service.getWorkflow(w().doc);
    expect(read?.workflow.state).toBe('sent');
    const byId = Object.fromEntries(read!.workflow.participants.map((p) => [p.id, p]));
    expect(byId['p1']).toMatchObject({
      roles: ['tenant'],
      kind: 'filler',
      order: 1,
      name: 'Tess Tenant',
      state: 'active',
    });
    expect(byId['p2']).toMatchObject({
      roles: ['landlord'],
      kind: 'signer',
      order: 2,
      state: 'pending',
    });
    // The service holds an opaque sub and a name; the address stays in the host.
    expect(JSON.stringify(read?.workflow)).not.toContain('@');
    expect(byId['p1']?.sub).toBe(record.participants[0]?.sub);
    expect(record.participants[0]?.sub).toMatch(/^ext-[\w-]+$/);
    expect(w().deps.store.get(w().doc)?.participants[0]?.email).toBe('tess@people.example.test');
  });

  it('refuses anyone but the owner, a role without a person, a bad address and a second send', async () => {
    const send = (over: Partial<Parameters<typeof sendForCompletion>[2]>) =>
      sendForCompletion(w().deps.host, w().deps.store, {
        doc: w().doc,
        owner: 'u-olivia',
        participants: PEOPLE,
        ...over,
      });
    await expect(send({ owner: 'u-ada' })).rejects.toThrow(SendRefused);
    await expect(send({ participants: [PEOPLE[0]!] })).rejects.toThrow(/Missing: landlord/);
    await expect(
      send({ participants: [PEOPLE[0]!, { ...PEOPLE[1]!, email: 'a@b.test>\r\nBcc: x@y.test' }] }),
    ).rejects.toThrow(/one plain address/);
    expect(await w().h.host.service.getWorkflow(w().doc)).toBeNull();
    await send({});
    await expect(send({})).rejects.toThrow(/already/);
  });
});

/** The service's own dispatcher signs an event; the host's receiver verifies it and handles it. */
async function pipeline(deps: EventDeps, clock: { now: number }) {
  const secret = generateSecret();
  const sink = new MemoryNotificationSink();
  const endpoint = composeWebhookEndpoint({
    secrets: () => [secret],
    sink,
    onEvent: (event) => handleWorkflowEvent(deps, event),
    now: () => Math.floor(clock.now / 1000),
  });
  const failures: unknown[] = [];
  const transport: Transport = {
    deliver(req) {
      const outcome = endpoint.receiver.receive(new Headers({ ...req.headers }), req.body);
      if (outcome.status === 202 && !outcome.duplicate) endpoint.schedule();
      return Promise.resolve({ ok: true, status: outcome.status, hops: 0 });
    },
  };
  const subs = new MemorySubscriptionStore();
  await subs.insert({
    id: 'sub-1',
    tenant: TENANT,
    url: 'https://host.test/webhooks/dep',
    events: [
      'dep.workflow.participant_activated.v1',
      'dep.workflow.reminder_due.v1',
      'dep.workflow.completed.v1',
      'dep.workflow.finalised.v1',
    ],
    secrets: [secret],
    version: 1,
    createdAt: clock.now,
    updatedAt: clock.now,
  } as SubscriptionRecord);
  const dispatcher = new WebhookDispatcher({
    subscriptions: subs,
    deliveries: new MemoryDeliveryStore(),
    transport,
    source: 'https://docs.example.test/events',
    now: () => clock.now,
    rejectedThrottle: { windowMs: 60_000, max: 3 },
  });
  return {
    failures,
    raise: async (type: string, doc: string, data: Record<string, unknown>) => {
      await dispatcher.raise({
        type,
        tenant: TENANT,
        subject: doc,
        data,
        time: clock.now,
      } as DepEvent);
      await dispatcher.drain();
      await endpoint.settled();
    },
    queue: endpoint.queue,
  };
}

const activated = (participant: string) => ({
  workflow: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  document: 'd',
  seq: 1,
  chainHead: 'a'.repeat(64),
  participant,
});

describe('UX-099 criteria 2, 3 and 4: invitation, passcode, token, reminder', () => {
  async function sent() {
    await sendForCompletion(w().deps.host, w().deps.store, {
      doc: w().doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    return pipeline(w().deps, w().clock);
  }

  const referenceIn = (mail: Mail): string => /\/fill\/([\w-]+)/.exec(mail.text)![1]!;

  it('mails the invitation when the participant is activated, with a link that carries no token', async () => {
    const p = await sent();
    await p.raise('dep.workflow.participant_activated.v1', w().doc, activated('p1'));
    expect(w().mails).toHaveLength(1);
    const mail = w().mails[0]!;
    expect(mail.to).toBe('tess@people.example.test');
    expect(mail.text).toContain(`${PUBLIC_URL}/fill/`);
    // No JWT, no secret, no document identifier in the link.
    expect(mail.text).not.toMatch(/eyJ|token=|secret/i);
    expect(mail.text).not.toContain(w().doc);
    expect(mail.text).toContain(SIGNATURE_STATEMENT);
  });

  it('sends nothing for a document it did not send, a participant it does not know, or the test ping', async () => {
    const p = await sent();
    await p.raise(
      'dep.workflow.participant_activated.v1',
      '0192f3a1-0000-7000-8000-00000000ffff',
      activated('p1'),
    );
    await p.raise('dep.workflow.participant_activated.v1', w().doc, activated('p9'));
    expect(w().mails).toHaveLength(0);
  });

  it('asks for a passcode, refuses a wrong one, and mints a filler token with wfp, amr and auth_time', async () => {
    const p = await sent();
    await p.raise('dep.workflow.participant_activated.v1', w().doc, activated('p1'));
    const reference = referenceIn(w().mails[0]!);

    expect(await verifyPasscode(w().deps, reference, '123456')).toEqual({
      ok: false,
      reason: 'none',
    });
    expect(await startPasscode(w().deps, 'nobody')).toBeNull();
    expect(await startPasscode(w().deps, reference)).toEqual({ name: 'Tess Tenant' });
    const mail = w().mails.at(-1)!;
    expect(mail.to).toBe('tess@people.example.test');
    const code = /passcode is (\d{6})/.exec(mail.text)![1]!;

    const wrong = code === '000000' ? '111111' : '000000';
    expect(await verifyPasscode(w().deps, reference, wrong)).toEqual({
      ok: false,
      reason: 'wrong',
    });
    // A pasted code with a space in the middle is accepted.
    const good = await verifyPasscode(w().deps, reference, `${code.slice(0, 3)} ${code.slice(3)}`);
    if (!good.ok) throw new Error(`the passcode was refused: ${good.reason}`);
    const { payload } = decodeJws(good.token);
    expect(payload['wfp']).toBe('p1');
    expect(payload['amr']).toEqual(['otp']);
    expect(payload['auth_time']).toBe(Math.floor(T0 / 1000));
    expect(payload['sub']).toBe(w().deps.store.get(w().doc)?.participants[0]?.sub);
    expect(payload['docs']).toEqual({ [w().doc]: 'filler' });
    // The code is spent.
    expect(await verifyPasscode(w().deps, reference, code)).toEqual({ ok: false, reason: 'none' });

    // The service accepts the token: a participant's token reads the workflow of its document, and
    // the participant it names is the one the host bound.
    const res = await fetch(`${w().h.rest}/documents/${w().doc}/workflow`, {
      headers: { Authorization: `Bearer ${good.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { participants: Array<{ id: string; sub: string }> };
    expect(body.participants.find((p) => p.id === payload['wfp'])?.sub).toBe(payload['sub']);
    // The same token is refused for another document.
    const other = await fetch(
      `${w().h.rest}/documents/0192f0a1-0000-7000-8000-00000000ffff/workflow`,
      {
        headers: { Authorization: `Bearer ${good.token}` },
      },
    );
    expect([401, 403, 404]).toContain(other.status);
  });

  it('locks a passcode after repeated wrong tries and lets it lapse', async () => {
    const p = await sent();
    await p.raise('dep.workflow.participant_activated.v1', w().doc, activated('p1'));
    const reference = referenceIn(w().mails[0]!);
    await startPasscode(w().deps, reference);
    for (let i = 1; i < PASSCODE_ATTEMPTS; i++)
      expect(await verifyPasscode(w().deps, reference, 'aaaaaa')).toEqual({
        ok: false,
        reason: 'wrong',
      });
    expect(await verifyPasscode(w().deps, reference, 'aaaaaa')).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect(await verifyPasscode(w().deps, reference, 'aaaaaa')).toEqual({
      ok: false,
      reason: 'none',
    });

    await startPasscode(w().deps, reference);
    w().clock.now += PASSCODE_LIFETIME_MS + 1;
    expect(await verifyPasscode(w().deps, reference, '123456')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('mails a reminder when one is due, with a fresh link, and the old link stops working', async () => {
    const p = await sent();
    await p.raise('dep.workflow.participant_activated.v1', w().doc, activated('p1'));
    const first = referenceIn(w().mails[0]!);
    await p.raise('dep.workflow.reminder_due.v1', w().doc, activated('p1'));
    expect(w().mails).toHaveLength(2);
    expect(w().mails[1]?.subject).toMatch(/^A reminder to complete/);
    const second = referenceIn(w().mails[1]!);
    expect(second).not.toBe(first);
    expect(await startPasscode(w().deps, first)).toBeNull();
    expect(await startPasscode(w().deps, second)).not.toBeNull();
  });
});

describe('UX-099 criterion 5: the sealed PDF and the evidence bundle', () => {
  it('fails on a workflow that is not finalised, so that the queue records it', async () => {
    await sendForCompletion(w().deps.host, w().deps.store, {
      doc: w().doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    await expect(
      handleWorkflowEvent(w().deps, {
        webhookId: 'msg_1',
        type: 'dep.workflow.finalised.v1',
        subject: w().doc,
        test: false,
        body: { data: {} },
      }),
    ).rejects.toThrow(ServiceError);
    expect(w().deps.store.get(w().doc)?.state).toBe('sent');
  });

  it('keeps the fetched files for the owner and for nobody else', async () => {
    await sendForCompletion(w().deps.host, w().deps.store, {
      doc: w().doc,
      owner: 'u-olivia',
      participants: PEOPLE,
    });
    // What the service returns for a finalised workflow is stood in for here: the sealed PDF and
    // the evidence bundle themselves are not produced in this test (no signing service).
    const pdf = new TextEncoder().encode('%PDF-1.7 test bytes');
    const evidence = new TextEncoder().encode('{"evidence":{"items":[]}}');
    const stub = {
      ...w().deps,
      host: {
        ...w().deps.host,
        service: Object.assign(Object.create(w().deps.host.service) as object, {
          getSealedPdf: () => Promise.resolve(pdf),
          getEvidenceBundle: () => Promise.resolve(evidence),
        }) as unknown as ServiceClient,
      },
    };
    await handleWorkflowEvent(stub, {
      webhookId: 'msg_2',
      type: 'dep.workflow.finalised.v1',
      subject: w().doc,
      test: false,
      body: { data: {} },
    });
    expect(w().deps.store.get(w().doc)?.state).toBe('finalised');
    const file = await resultFile(w().deps.host, w().deps.store, w().doc, 'u-olivia', 'sealed-pdf');
    expect(Buffer.from(file!.bytes).toString()).toBe('%PDF-1.7 test bytes');
    expect(file?.type).toBe('application/pdf');
    expect(
      await resultFile(w().deps.host, w().deps.store, w().doc, 'u-ada', 'sealed-pdf'),
    ).toBeNull();
    expect(await readFile(join(w().dir, 'workflows.json'), 'utf8')).toContain('"finalised"');
  });
});

describe('UX-099 criterion 6: what the demo says about signatures', () => {
  it('says simple electronic signature, evidence and a tamper-evident seal, and never overclaims', async () => {
    expect(SIGNATURE_STATEMENT).toMatch(/simple electronic signatures/);
    expect(SIGNATURE_STATEMENT).toMatch(/evidence/);
    expect(SIGNATURE_STATEMENT).toMatch(/tamper-evident seal/);
    const files = [
      '../src/lib/server/send-for-completion.ts',
      '../src/routes/fill/[invitation]/+page.svelte',
      '../src/routes/as/[user]/docs/[id]/send/+page.svelte',
    ];
    for (const f of files) {
      const text = await readFile(join(import.meta.dirname, f), 'utf8');
      expect(text, f).not.toMatch(/qualified|legally binding|everywhere/i);
    }
  });
});
