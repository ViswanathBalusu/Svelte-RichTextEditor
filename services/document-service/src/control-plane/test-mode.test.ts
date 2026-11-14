// The test-mode switch and the hooks it mounts (BE-079 criterion 1; ADR 0054). With the switch off
// (the default) no path under `/_test/` exists, and the production configuration refuses the switch.
// The memory storage is the subject; no database is needed. The hooks' own behaviour is tested in
// `test-hooks.test.ts` and `src/data-plane/hooks.test.ts`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../../test/control-plane/support.ts';
import { configFromEnv } from '../config.ts';
import { TEST_TIMERS } from './test-hooks.ts';

describe('the test-mode switch (BE-079 criterion 1)', () => {
  it('is off by default', () => {
    expect(configFromEnv({}).testMode).toBe(false);
  });

  it('is refused in the production environment, which is also the default one', () => {
    expect(() => configFromEnv({ DOCEDIT_TEST_MODE: 'true' })).toThrow(/refused in production/);
    expect(() =>
      configFromEnv({ DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'production' }),
    ).toThrow(/refused in production/);
  });

  it('is accepted in the test and development environments', () => {
    expect(configFromEnv({ DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'test' }).testMode).toBe(
      true,
    );
    expect(
      configFromEnv({ DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'development' }).testMode,
    ).toBe(true);
  });
});

describe('the hooks exist only with the switch on (BE-079 criterion 1)', () => {
  let off: Harness;
  let on: Harness;

  beforeAll(async () => {
    off = await startHarness('memory');
    on = await startHarness('memory', { config: { testMode: true, environment: 'test' } });
  });

  afterAll(async () => {
    await off?.close();
    await on?.close();
  });

  it('answers not_found on every path under /_test/ when the switch is off', async () => {
    const timers = await off.call('GET', '/_test/timers', { token: off.serviceJwt() });
    expect(timers.status).toBe(404);
    expect(timers.json).toMatchObject({ code: 'not_found' });
    expect(timers.text).not.toContain('idempotencyTtlMs');

    const database = await off.call('POST', '/_test/database', {
      token: off.serviceJwt(),
      body: { down: true },
    });
    expect(database.status).toBe(404);
    expect(database.json).toMatchObject({ code: 'not_found' });
  });

  it('serves the shortened timers on /_test/timers only when the switch is on', async () => {
    const timers = await on.call('GET', '/_test/timers', { token: on.serviceJwt() });
    expect(timers.status).toBe(200);
    expect(timers.json).toEqual(TEST_TIMERS);
  });

  it('still refuses a hook call without a service credential when the switch is on', async () => {
    const unsigned = await on.call('POST', '/_test/database', { body: { down: true } });
    expect(unsigned.status).toBe(401);
  });
});
