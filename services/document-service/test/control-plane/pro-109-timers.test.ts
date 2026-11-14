/**
 * PRO-109 criteria 1 and 2 (lane PRO-099-112, round 3): the timers the spec gives a value to.
 *
 * Criterion 1 (switch off): the timers that 05 and 06 specify carry their specified values in the
 * defaults the service uses when test mode is off. Only the timers with a specified value are
 * checked here; the job lease, the node lease and the outbox poll have no value in the spec, so
 * criterion 1 as a whole stays open (see the story Notes).
 *
 * Criterion 2 (switch on): each shortened timer of `TEST_TIMERS` is shorter than its specified
 * default, and a minted token lives shorter than the 15 minute maximum. Memory storage; the
 * service clock is the harness's `now()`. No database is needed.
 */
import { describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { configFromEnv } from '../../src/config.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';
import { startHarness, type Harness } from './support.ts';

const MAX_TOKEN_LIFETIME_MS = 15 * 60_000;

/** The specified values: 05 §4 (heartbeat), 05 §5.1 (hello), 05 §6.1 (idempotency), 06 §2.2
 * (room idle), 06 §10 (preview window), 05 §3.1 (token maximum). */
const SPECIFIED = {
  heartbeatMs: 25_000,
  helloTimeoutMs: 10_000,
  roomIdleMs: 60_000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  previewWindowMs: 10_000,
} as const;

async function mintedLifetimeMs(h: Harness): Promise<number> {
  const doc = uuid7();
  const r = await h.call('POST', '/v1/tokens', {
    token: h.serviceJwt(),
    body: { sub: 'alice', docs: { [doc]: 'owner' } },
  });
  expect(r.status).toBe(200);
  return Date.parse(r.json.expiresAt as string) - h.now();
}

describe('the timers with the switch off have their specified values (PRO-109 criterion 1)', () => {
  it('the data plane defaults carry the heartbeat, hello and room idle values of 05 and 06', () => {
    const s = settingsFrom({});
    expect(s.limits.heartbeatMs).toBe(SPECIFIED.heartbeatMs);
    expect(s.helloTimeoutMs).toBe(SPECIFIED.helloTimeoutMs);
    expect(s.roomIdleMs).toBe(SPECIFIED.roomIdleMs);
  });

  it('the service defaults carry the idempotency and preview window values of 05 and 06', () => {
    const c = configFromEnv({});
    expect(c.testMode).toBe(false);
    expect(c.idempotencyTtlMs).toBe(SPECIFIED.idempotencyTtlMs);
    expect(c.previewWindowMs).toBe(SPECIFIED.previewWindowMs);
  });

  it('mints tokens that live longer than the test-mode lifetime and no longer than 15 minutes', async () => {
    const off = await startHarness('memory');
    try {
      const lifetime = await mintedLifetimeMs(off);
      expect(lifetime).toBeGreaterThan(TEST_TIMERS.tokenLifetimeS * 1000);
      expect(lifetime).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_MS);
    } finally {
      await off.close();
    }
  });
});

describe('the shortened timers are shorter than the specified values (PRO-109 criterion 2)', () => {
  it('room idle, hello and the idempotency and preview windows are shorter in test mode', () => {
    expect(TEST_TIMERS.roomIdleMs).toBeLessThan(SPECIFIED.roomIdleMs);
    expect(TEST_TIMERS.helloTimeoutMs).toBeLessThan(SPECIFIED.helloTimeoutMs);
    expect(TEST_TIMERS.idempotencyTtlMs).toBeLessThan(SPECIFIED.idempotencyTtlMs);
    expect(TEST_TIMERS.previewWindowMs).toBeLessThan(SPECIFIED.previewWindowMs);
  });

  it('a token minted with the switch on lives shorter than the 15 minute maximum', async () => {
    const on = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
    try {
      const lifetime = await mintedLifetimeMs(on);
      expect(lifetime).toBeLessThanOrEqual(TEST_TIMERS.tokenLifetimeS * 1000);
      expect(lifetime).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_MS);
    } finally {
      await on.close();
    }
  });
});
