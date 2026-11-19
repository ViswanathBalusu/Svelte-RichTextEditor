/**
 * PRO-109 (lane w5, 2026-11-18; owner decision 191): the test-mode switch and its timers.
 *
 * Criterion 1: with the switch off, every timer has the specified value. The values the spec gives
 * are in `pro-109-timers.test.ts`; the job lease, node lease and outbox poll have no value in 05 or
 * 06, so their documented defaults (ADR 0036; docs/adr/0413-w5-PRO-109-test-mode-timers.md) are
 * checked here and the region lease is the 07 §10 five minutes.
 *
 * Criterion 2: with the switch on, every timer is shorter, the region lease too, and a token never
 * lives longer than 15 minutes.
 *
 * Criterion 3: the waits the kit makes end at the shortened values. The service clock is the
 * harness's `now()`, moved by `advance`, so the 60 s token and the 3 s region lease are not slept;
 * the real-time waits (hello 2 s, room idle 1 s) are in the be-079-* tests of this folder.
 */
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { settingsFrom } from '../../src/data-plane/settings.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const OPEN = 'rOpen00000000001';
const MAX_TOKEN_MS = 15 * 60_000;
const REGION_LEASE_MS = 5 * 60_000;
const TOKEN_SKEW_MS = 60_000;

describe('the timers the spec leaves without a value, with the switch off (criterion 1)', () => {
  it('have the documented defaults', () => {
    const c = configFromEnv({});
    expect(c.testMode).toBe(false);
    // ADR 0036: job leases 30 seconds, an idle poll of 1 second.
    expect(c.jobLeaseMs).toBe(30_000);
    expect(c.jobIdleMs).toBe(1_000);
    const s = settingsFrom({});
    // The node lease 15 seconds, renewed every 3 seconds; the outbox poll 1 second, its lease 30 s.
    expect(s.lease.durationMs).toBe(15_000);
    expect(s.lease.renewMs).toBe(3_000);
    expect(s.outbox.pollMs).toBe(1_000);
    expect(s.outbox.leaseMs).toBe(30_000);
    expect(s.testMode).toBe(false);
  });

  it('keep every shortened value below its default', () => {
    const c = configFromEnv({});
    const s = settingsFrom({});
    expect(TEST_TIMERS.jobLeaseMs).toBeLessThan(c.jobLeaseMs);
    expect(TEST_TIMERS.nodeLeaseMs).toBeLessThan(s.lease.durationMs);
    expect(TEST_TIMERS.regionLeaseMs).toBeLessThan(REGION_LEASE_MS);
    expect(TEST_TIMERS.tokenLifetimeS * 1000).toBeLessThanOrEqual(MAX_TOKEN_MS);
  });
});

describe('the region lease and the token under the switch (criteria 2 and 3)', () => {
  const path = (doc: string) => `/v1/documents/${doc}/regions/${OPEN}/lease`;

  async function leaseLength(h: Harness): Promise<number> {
    const doc = await h.createDocument({ content: documentWithRegions() });
    const token = h.userToken({ [doc]: 'editor' }, { sub: 'ed-1' });
    const r = await h.call('POST', path(doc), { token });
    expect(r.status).toBe(201);
    return Date.parse(r.json.expiresAt) - h.now();
  }

  it('gives a region lease of the shortened duration with the switch on, and five minutes off', async () => {
    const on = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
    const off = await startHarness('memory');
    try {
      expect(await leaseLength(on)).toBeLessThanOrEqual(TEST_TIMERS.regionLeaseMs);
      expect(await leaseLength(off)).toBeGreaterThan(TEST_TIMERS.regionLeaseMs);
      expect(await leaseLength(off)).toBeLessThanOrEqual(REGION_LEASE_MS);
    } finally {
      await on.close();
      await off.close();
    }
  });

  it('lets a region lease lapse within seconds with the switch on, and then another user takes it', async () => {
    const h = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
    try {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const as = (sub: string) => h.userToken({ [doc]: 'editor' }, { sub });
      const first = await h.call('POST', path(doc), { token: as('ed-1') });
      expect(first.status).toBe(201);
      const tag = `"${first.json.id}"`;
      // Inside the lease a second holder is refused, and a heartbeat extends it.
      expect((await h.call('POST', path(doc), { token: as('ed-2') })).status).toBe(409);
      h.advance(TEST_TIMERS.regionLeaseMs - 1_000);
      const beat = await h.call('PUT', path(doc), {
        token: as('ed-1'),
        headers: { 'If-Match': tag },
      });
      expect(beat.status).toBe(200);
      // Past the last heartbeat plus the shortened duration the lease has lapsed.
      h.advance(TEST_TIMERS.regionLeaseMs + 1_000);
      const late = await h.call('PUT', path(doc), {
        token: as('ed-1'),
        headers: { 'If-Match': tag },
      });
      expect(late.status).toBe(404);
      const next = await h.call('POST', path(doc), { token: as('ed-2') });
      expect(next.status).toBe(201);
      expect(next.json.holder).toBe('ed-2');
    } finally {
      await h.close();
    }
  });

  it('lets a minted token expire after the shortened lifetime with the switch on', async () => {
    const h = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
    try {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const minted = await h.call('POST', '/v1/tokens', {
        token: h.serviceJwt(),
        body: { sub: 'alice', docs: { [doc]: 'owner' } },
      });
      expect(minted.status).toBe(200);
      const token = minted.json.token as string;
      expect(Date.parse(minted.json.expiresAt) - h.now()).toBeLessThanOrEqual(
        TEST_TIMERS.tokenLifetimeS * 1000,
      );
      expect((await h.call('GET', `/v1/documents/${doc}`, { token })).status).toBe(200);
      // Verifiers allow 60 seconds of clock skew after `exp` (05 §3.1), so the last use of the token
      // is its lifetime plus that skew, which is two minutes in test mode.
      h.advance(TEST_TIMERS.tokenLifetimeS * 1000 + TOKEN_SKEW_MS + 2_000);
      expect((await h.call('GET', `/v1/documents/${doc}`, { token })).status).toBe(401);
    } finally {
      await h.close();
    }
  });
});
