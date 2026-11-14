/**
 * BE-079 criterion 2, the token lifetime part: in test mode the service mints tokens with the
 * shortened lifetime of `TEST_TIMERS` (60 s), and with the switch off it keeps the configured
 * default. Memory storage; the service clock is the harness's `now()`.
 */
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './support.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';

async function mintedLifetimeMs(h: Harness): Promise<number> {
  const doc = uuid7();
  const r = await h.call('POST', '/v1/tokens', {
    token: h.serviceJwt(),
    body: { sub: 'alice', docs: { [doc]: 'owner' } },
  });
  expect(r.status).toBe(200);
  return Date.parse(r.json.expiresAt as string) - h.now();
}

describe('token lifetime under test mode (BE-079 criterion 2)', () => {
  let on: Harness;
  let off: Harness;

  beforeAll(async () => {
    on = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
    off = await startHarness('memory');
  });

  afterAll(async () => {
    await on?.close();
    await off?.close();
  });

  it('mints tokens that live as long as the shortened lifetime the kit reads', async () => {
    expect(TEST_TIMERS.tokenLifetimeS).toBe(60);
    // exp is whole seconds from the service clock, so the lifetime is within one second of 60 s.
    const lifetime = await mintedLifetimeMs(on);
    expect(lifetime).toBeLessThanOrEqual(TEST_TIMERS.tokenLifetimeS * 1000);
    expect(lifetime).toBeGreaterThan((TEST_TIMERS.tokenLifetimeS - 1) * 1000);
  });

  it('keeps the configured default lifetime when test mode is off', async () => {
    const lifetime = await mintedLifetimeMs(off);
    expect(lifetime).toBeGreaterThan(TEST_TIMERS.tokenLifetimeS * 1000);
  });
});
