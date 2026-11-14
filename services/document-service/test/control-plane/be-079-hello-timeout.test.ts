/**
 * BE-079 criterion 2, the hello part: in test mode the service closes a socket that sends no
 * `hello` after the shortened `helloTimeoutMs` of `TEST_TIMERS` (2 s), with close code 4408
 * (`CLOSE.helloTimeout`). With test mode off the data plane uses its default (10 s in
 * `src/data-plane/settings.ts`), so the same socket is still open after the shortened window.
 * The tests run the real data plane over a real WebSocket, memory storage.
 *
 * The node lease expiry is not covered here (the story Notes say so).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { startHarness, type Harness } from './support.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';
import { CLOSE } from '../../src/data-plane/wire.ts';

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

describe('test mode shortens the hello timeout (BE-079 criterion 2, hello)', () => {
  it('closes a socket that sends no hello after about the shortened 2 s, with 4408', async () => {
    const h = await startHarness('memory', {
      config: { testMode: true, environment: 'test' },
      realDataPlane: true,
    });
    harnesses.push(h);
    expect(TEST_TIMERS.helloTimeoutMs).toBe(2_000);
    const started = Date.now();
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    const closed = await c.closed;
    const took = Date.now() - started;
    expect(closed.code).toBe(CLOSE.helloTimeout);
    // Not before the shortened timer; the 10 s bound is generous for a loaded machine.
    expect(took).toBeGreaterThanOrEqual(TEST_TIMERS.helloTimeoutMs - 200);
    expect(took).toBeLessThan(10_000);
  });

  it('keeps a silent socket open past the shortened timer when test mode is off', async () => {
    const h = await startHarness('memory', { realDataPlane: true });
    harnesses.push(h);
    const hook = await h.call('GET', '/_test/timers', { token: h.serviceJwt() });
    expect(hook.status).toBe(404);
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    clients.push(c);
    await new Promise((resolve) => setTimeout(resolve, TEST_TIMERS.helloTimeoutMs + 1_000));
    expect(c.closeInfo).toBeNull();
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });
});
