/**
 * PRO-109 criterion 4: with the test-mode switch on, the discovery document reveals nothing a
 * client could use to enable test mode on a production server. The switch is not in discovery,
 * no `/_test/` path is named, and the document's key set is the same with the switch off.
 * Memory storage; no database is needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './support.ts';

const SWITCH_WORDS = /test[-_ ]?mode|testmode|\/_test|kill-room|fail-next-write|drop-announcement/i;

describe('the discovery document under the test-mode switch (PRO-109 criterion 4)', () => {
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

  it('answers discovery with the switch on and off, without naming the switch or its paths', async () => {
    const withSwitch = await on.call('GET', '/.well-known/dep');
    const withoutSwitch = await off.call('GET', '/.well-known/dep');
    expect(withSwitch.status).toBe(200);
    expect(withoutSwitch.status).toBe(200);
    expect(withSwitch.text).not.toMatch(SWITCH_WORDS);
    expect(withoutSwitch.text).not.toMatch(SWITCH_WORDS);
  });

  it('has the same top-level keys with the switch on and off', async () => {
    const withSwitch = await on.call('GET', '/.well-known/dep');
    const withoutSwitch = await off.call('GET', '/.well-known/dep');
    expect(Object.keys(withSwitch.json).sort()).toEqual(Object.keys(withoutSwitch.json).sort());
  });

  it('ignores a request that tries to switch test mode on through the query or a header', async () => {
    const r = await off.call('GET', '/.well-known/dep?testMode=true', {
      headers: { 'X-Test-Mode': 'true' },
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toMatch(SWITCH_WORDS);
    const hooks = await off.call('GET', '/_test/timers', { token: off.serviceJwt() });
    expect(hooks.status).toBe(404);
  });
});
