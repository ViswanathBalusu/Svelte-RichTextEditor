// PRO-069 criteria 4 and 5 (05 section 7; lane w5): the body of a real delivery is checked against
// the published schema of its type, for every type in spec/dep/webhooks, and a later minor version
// that adds a field to `data` is read by an old receiver. The dispatcher is the composed one
// (`composeWebhooks`) over the real `EgressProxy`; only the resolver and the connector are fakes, and
// the connector records the request exactly as it would leave. The receiver is the reference host's
// (`apps/reference-host/src/lib/server/webhook-receiver.ts`), which knows `type`, `subject` and the
// signature and nothing else. Test values only.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  MemorySeenStore,
  WebhookReceiver,
  type ReceivedEvent,
} from '../../../../apps/reference-host/src/lib/server/webhook-receiver.ts';
import { configFromEnv } from '../../src/config.ts';
import { composeWebhooks } from '../../src/control-plane/webhook-composition.ts';
import type { DepEvent } from '../../src/control-plane/events.ts';
import type { ConnectInput, ConnectResult } from '../../src/control-plane/webhook-egress.ts';
import { generateSecret } from '../../src/control-plane/webhook-signing.ts';
import { SILENT } from '../../src/log.ts';

const TENANT = 't-w5-pro-069';
const CHAIN = 'cd'.repeat(32);
const WEBHOOKS = new URL('../../../../spec/dep/webhooks/', import.meta.url);
const TYPES = readdirSync(WEBHOOKS)
  .filter((f) => f.endsWith('.schema.json'))
  .map((f) => f.slice(0, -'.schema.json'.length))
  .sort();

// ajv and ajv-formats are dependencies of packages/protocol, not of this service: resolve them there.
interface AjvLike {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
}
const fromProtocol = createRequire(
  new URL('../../../../packages/protocol/package.json', import.meta.url),
);
const ajvModule = fromProtocol('ajv/dist/2020') as { default?: unknown };
const Ajv = (ajvModule.default ?? ajvModule) as new (o: object) => AjvLike;
const formatsModule = fromProtocol('ajv-formats') as { default?: unknown };
const addFormats = (formatsModule.default ?? formatsModule) as (a: AjvLike) => void;

function validatorFor(type: string): ReturnType<AjvLike['compile']> {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(readFileSync(new URL(`${type}.schema.json`, WEBHOOKS), 'utf8')) as object,
  );
}

const configured = configFromEnv({
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '1000',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
}).webhooks;
if (configured === null) throw new Error('the test settings switch webhooks on');
const SETTINGS = configured;

interface Sent {
  headers: Record<string, string>;
  body: string;
}

/** A composed dispatcher with one subscription to every type; `sent` holds what left, in order. */
async function rig(secret: string): Promise<{
  raise: (e: DepEvent) => Promise<void>;
  sent: Sent[];
}> {
  const sent: Sent[] = [];
  const composed = composeWebhooks({
    settings: SETTINGS,
    serviceId: 'https://docs.example.test/events',
    now: () => Date.now(),
    logger: SILENT,
    overrides: {
      egress: {
        resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
        connector: {
          send(input: ConnectInput): Promise<ConnectResult> {
            sent.push({ headers: input.headers, body: input.body });
            return Promise.resolve({
              remoteAddress: input.address,
              status: 204,
              location: undefined,
            });
          },
        },
      },
    },
  });
  await composed.store.insert({
    id: uuid7(),
    tenant: TENANT,
    url: 'https://hooks.example.test/receive',
    events: [...TYPES],
    secrets: [secret],
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return {
    sent,
    async raise(e) {
      await composed.dispatcher.raise(e);
      await composed.dispatcher.drain();
    },
  };
}

function eventOf(type: string, data: DepEvent['data']): DepEvent {
  return { type, tenant: TENANT, subject: uuid7(), data, time: Date.now() };
}

/** What every schema requires of `data`, and nothing more. */
const dataOf = (type: string): DepEvent['data'] =>
  type === 'dep.document.changed.v1' ? { seq: 7, chainHead: CHAIN } : { seq: 7 };

describe('PRO-069 criterion 4: a delivery of every event type passes the schema of its type', () => {
  it('lists the published types, so that a new schema is covered without a change here', () => {
    expect(TYPES.length).toBeGreaterThanOrEqual(35);
    expect(TYPES.every((t) => /^dep\.[a-z_.]+\.v[1-9]$/.test(t))).toBe(true);
  });

  it('sends a body for each type that its own schema accepts', async () => {
    const r = await rig(generateSecret());
    for (const type of TYPES) await r.raise(eventOf(type, dataOf(type)));
    expect(r.sent).toHaveLength(TYPES.length);
    const bodies = r.sent.map((s) => JSON.parse(s.body) as Record<string, unknown>);
    expect(bodies.map((b) => b['type']).sort()).toEqual([...TYPES]);
    for (const body of bodies) {
      const validate = validatorFor(body['type'] as string);
      expect(validate(body), `${String(body['type'])}: ${JSON.stringify(validate.errors)}`).toBe(
        true,
      );
    }
  });
});

describe('PRO-069 criterion 5: an old receiver ignores a field a later minor version adds', () => {
  it('delivers a body with an added data field and an added attribute to the receiver, which verifies and queues it', async () => {
    const secret = generateSecret();
    const r = await rig(secret);
    const queued: ReceivedEvent[] = [];
    const receiver = new WebhookReceiver({
      secrets: () => [secret],
      seen: new MemorySeenStore(),
      queue: { push: (e) => queued.push(e) },
    });
    const type = 'dep.document.changed.v1';
    const subject = uuid7();
    await r.raise({
      type,
      tenant: TENANT,
      subject,
      // A later minor version adds `title` to `data`: the old receiver has never heard of it.
      data: { seq: 9, chainHead: CHAIN, title: 'added by a later minor version' },
      time: Date.now(),
    });
    expect(r.sent).toHaveLength(1);
    const sent = r.sent[0]!;
    const body = JSON.parse(sent.body) as Record<string, unknown>;
    expect((body['data'] as Record<string, unknown>)['title']).toBe(
      'added by a later minor version',
    );

    // The schema of the earlier version accepts the body with the field it does not know.
    const validate = validatorFor(type);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...body, extension: 'also added' })).toBe(true);

    // The receiver verifies the signature over the whole body, reads what it knows and queues it.
    const outcome = receiver.receive(new Headers(sent.headers), sent.body);
    expect(outcome).toEqual({ status: 202, duplicate: false });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ type, subject, test: false });
    expect(queued[0]?.webhookId).toBe(sent.headers['webhook-id']);
    const data = queued[0]?.body['data'] as Record<string, unknown>;
    expect(data['seq']).toBe(9);
    expect(data['chainHead']).toBe(CHAIN);
  });

  it('refuses a body that drops a field the version requires, which is why such a change needs a new suffix', () => {
    const validate = validatorFor('dep.document.changed.v1');
    const body = {
      specversion: '1.0',
      id: 'e1',
      source: 'https://docs.example.test/events',
      type: 'dep.document.changed.v1',
      subject: uuid7(),
      data: { seq: 1, chainHead: CHAIN },
    };
    expect(validate(body)).toBe(true);
    expect(validate({ ...body, data: { seq: 1 } })).toBe(false);
    expect(validate({ ...body, data: { seq: '1', chainHead: CHAIN } })).toBe(false);
  });
});
