// PRO-071 criterion 1 (05 section 7; lane w5): the composed service retries a failed delivery with
// exponential delay for up to 24 hours and then abandons it. Here the settings come from
// `configFromEnv`, the dispatcher from `composeWebhooks`, and the transport is the real
// `EgressProxy`; only the resolver, the connector, the clock and the timers are fakes, so a
// receiver that does not answer is a connector that fails with the timeout of the real connector.
// The real `nodeConnector` is run once against a local server that never answers. Test values only.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { configFromEnv } from '../../src/config.ts';
import { composeWebhooks } from '../../src/control-plane/webhook-composition.ts';
import type { DepEvent } from '../../src/control-plane/events.ts';
import { RETRY_WINDOW_MS, type DeliveryRow } from '../../src/control-plane/webhook-dispatcher.ts';
import {
  nodeConnector,
  type ConnectInput,
  type ConnectResult,
  type Connector,
} from '../../src/control-plane/webhook-egress.ts';
import { generateSecret } from '../../src/control-plane/webhook-signing.ts';
import { SILENT } from '../../src/log.ts';

const TENANT = 't-w5-pro-071';
const SUBJECT = '0190c8a4-1b2c-7d3e-8f40-123456789abc';
const CHAIN = 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
const PUBLIC = '93.184.216.34';
const BASE_MS = 1_000;
const FACTOR = 2;

const ENV: Record<string, string> = {
  DOCEDIT_WEBHOOKS: 'true',
  DOCEDIT_WEBHOOK_REJECTED_WINDOW_MS: '60000',
  DOCEDIT_WEBHOOK_REJECTED_MAX: '5',
  DOCEDIT_WEBHOOK_TIMEOUT_MS: '2000',
  DOCEDIT_WEBHOOK_MAX_REDIRECTS: '0',
  DOCEDIT_WEBHOOK_RETRY_BASE_MS: String(BASE_MS),
  DOCEDIT_WEBHOOK_RETRY_FACTOR: String(FACTOR),
};

describe('PRO-071 criterion 1: the retry settings (config.ts)', () => {
  it('reads a schedule when both are given, and has none otherwise', () => {
    expect(configFromEnv(ENV).webhooks?.retry).toEqual({ baseMs: BASE_MS, factor: FACTOR });
    const { DOCEDIT_WEBHOOK_RETRY_BASE_MS: _b, DOCEDIT_WEBHOOK_RETRY_FACTOR: _f, ...without } = ENV;
    const settings = configFromEnv(without).webhooks;
    expect(settings).not.toBeNull();
    expect(settings && 'retry' in settings).toBe(false);
  });

  it('refuses one of the two alone, and a number that cannot be a schedule', () => {
    const { DOCEDIT_WEBHOOK_RETRY_FACTOR: _f, ...baseOnly } = ENV;
    expect(() => configFromEnv(baseOnly)).toThrow(/together or not at all/);
    const { DOCEDIT_WEBHOOK_RETRY_BASE_MS: _b, ...factorOnly } = ENV;
    expect(() => configFromEnv(factorOnly)).toThrow(/together or not at all/);
    expect(() => configFromEnv({ ...ENV, DOCEDIT_WEBHOOK_RETRY_BASE_MS: '0' })).toThrow(
      /at least 1/,
    );
    expect(() => configFromEnv({ ...ENV, DOCEDIT_WEBHOOK_RETRY_FACTOR: '0.5' })).toThrow(
      /at least 1/,
    );
  });
});

interface Timer {
  due: number;
  run: () => void;
}

interface Rig {
  rows: ReturnType<typeof composeWebhooks>['deliveries'];
  dispatcher: ReturnType<typeof composeWebhooks>['dispatcher'];
  clock: { now: number };
  timers: Timer[];
  sends: { at: number; messageId: string | undefined; address: string }[];
}

/** The composed dispatcher over the real egress proxy; `answer` is what the receiver does. */
async function rig(
  host: string,
  addresses: readonly string[],
  answer: (n: number) => 'timeout' | number,
): Promise<Rig> {
  const clock = { now: T0 };
  const timers: Timer[] = [];
  const sends: Rig['sends'] = [];
  const connector: Connector = {
    send(input: ConnectInput): Promise<ConnectResult> {
      sends.push({
        at: clock.now,
        messageId: input.headers['webhook-id'],
        address: input.address,
      });
      const got = answer(sends.length);
      if (got === 'timeout') return Promise.reject(new Error('timeout'));
      return Promise.resolve({ remoteAddress: input.address, status: got, location: undefined });
    },
  };
  const settings = configFromEnv(ENV).webhooks;
  if (settings === null) throw new Error('the test settings switch webhooks on');
  const composed = composeWebhooks({
    settings,
    serviceId: 'https://docs.example.test/events',
    now: () => clock.now,
    logger: SILENT,
    overrides: {
      egress: { resolver: { resolve: () => Promise.resolve(addresses) }, connector },
      schedule: (run, delayMs) => {
        timers.push({ due: clock.now + delayMs, run });
      },
    },
  });
  await composed.store.insert({
    id: uuid7(),
    tenant: TENANT,
    url: `https://${host}/hook`,
    events: ['dep.document.changed.v1'],
    secrets: [generateSecret()],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  return { rows: composed.deliveries, dispatcher: composed.dispatcher, clock, timers, sends };
}

function changed(): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant: TENANT,
    subject: SUBJECT,
    data: { seq: 1, chainHead: CHAIN },
    time: T0,
  };
}

/** Fires the held timers in due order, letting each send finish before the next. */
async function fireAll(r: Rig): Promise<void> {
  for (let i = 0; i < 200 && r.timers.length > 0; i++) {
    r.timers.sort((a, b) => a.due - b.due);
    const next = r.timers.shift();
    if (next === undefined) break;
    r.clock.now = next.due;
    next.run();
    await r.dispatcher.drain();
  }
}

async function onlyRow(r: Rig, id: string | undefined): Promise<DeliveryRow> {
  const row = await r.rows.get(id ?? '');
  if (row === null) throw new Error('no such delivery');
  return row;
}

describe('PRO-071 criterion 1: the composed service retries, then abandons', () => {
  it('sends again after base, base x factor, base x factor squared, and stops once the receiver answers', async () => {
    const r = await rig('hooks.example.test', [PUBLIC], (n) => (n < 4 ? 'timeout' : 204));
    const [id] = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);

    expect(r.sends.map((s) => s.at - T0)).toEqual([
      0,
      BASE_MS,
      BASE_MS + BASE_MS * FACTOR,
      BASE_MS + BASE_MS * FACTOR + BASE_MS * FACTOR ** 2,
    ]);
    expect(new Set(r.sends.map((s) => s.messageId)).size).toBe(1);
    expect(r.sends.every((s) => s.address === PUBLIC)).toBe(true);
    const row = await onlyRow(r, id);
    expect(row.state).toBe('delivered');
    expect(row.attempts).toBe(4);
    expect(row.messageId).toBe(r.sends[0]?.messageId);
  });

  it('abandons a receiver that never answers once the next send would fall after 24 hours', async () => {
    const r = await rig('silent.example.test', [PUBLIC], () => 'timeout');
    const [id] = await r.dispatcher.raise(changed());
    await r.dispatcher.drain();
    await fireAll(r);

    const row = await onlyRow(r, id);
    expect(row.state).toBe('failed');
    expect(row.lastReason).toBe('timeout');
    expect(r.timers).toHaveLength(0);
    expect(r.sends.length).toBeGreaterThan(10);
    const last = r.sends[r.sends.length - 1];
    expect((last?.at ?? 0) - T0).toBeLessThanOrEqual(RETRY_WINDOW_MS);
    const gap = r.sends.length - 1;
    // The send that would have followed the last one falls outside the window.
    expect(last?.at !== undefined && last.at + BASE_MS * FACTOR ** (gap - 1) - T0).toBeGreaterThan(
      RETRY_WINDOW_MS,
    );
    expect(new Set(r.sends.map((s) => s.messageId)).size).toBe(1);
  });

  it('retries a 500 answer, and does not retry a target the egress rules refuse', async () => {
    const r500 = await rig('five.example.test', [PUBLIC], (n) => (n < 2 ? 500 : 200));
    const [id500] = await r500.dispatcher.raise(changed());
    await r500.dispatcher.drain();
    await fireAll(r500);
    expect(r500.sends).toHaveLength(2);
    expect((await onlyRow(r500, id500)).state).toBe('delivered');

    const refused = await rig('rebind.example.test', ['10.0.0.5'], () => 204);
    const [idRefused] = await refused.dispatcher.raise(changed());
    await refused.dispatcher.drain();
    expect(refused.sends).toHaveLength(0);
    expect(refused.timers).toHaveLength(0);
    const row = await onlyRow(refused, idRefused);
    expect(row.state).toBe('failed');
    expect(row.attempts).toBe(1);
  });
});

describe('PRO-071 criterion 1: the real connector times out on a receiver that does not answer', () => {
  let server: Server | undefined;
  afterAll(() => {
    server?.closeAllConnections();
    server?.close();
  });

  it('fails with the timeout the egress proxy maps to a retryable reason', async () => {
    server = createServer(() => {
      // Never answers.
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server?.address() as AddressInfo;
    const connector = nodeConnector(100);
    await expect(
      connector.send({
        address: '127.0.0.1',
        url: new URL(`http://127.0.0.1:${port}/hook`),
        headers: {},
        body: '{}',
      }),
    ).rejects.toThrow('timeout');
  });
});
