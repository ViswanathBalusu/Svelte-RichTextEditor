/**
 * BE-079 criterion 2, the idle part: in test mode the service closes an idle room after the
 * shortened `roomIdleMs` of `TEST_TIMERS` (1 s). With test mode off the data plane uses its own
 * default, 60 s (`roomIdleMs ?? 60_000` in `src/data-plane/settings.ts`). The tests run the real
 * data plane (the harness's `realDataPlane` option), open a room over a real WebSocket and
 * disconnect. Memory storage.
 *
 * Ownership is read in two ways. In test mode, through the test hook
 * `GET /_test/documents/{id}/state`, as the conformance kit reads it. With test mode off the hooks
 * are not registered (every `/_test/` path is 404), so the test reads the owner from the head row
 * of the log store the service runs on (`h.parts.logs.head`), which is what the hook reports.
 *
 * The node lease and the hello timer are not covered here (the story Notes say so).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { startHarness, type Harness } from './support.ts';
import { TEST_TIMERS } from '../../src/control-plane/test-hooks.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type OwnerReader = (h: Harness, doc: string) => Promise<string | null>;

/** The owner of the document's room as the test hook reports it (test mode only). */
const hookOwner: OwnerReader = async (h, doc) => {
  const r = await h.call('GET', `/_test/documents/${doc}/state`, { token: h.serviceJwt() });
  expect(r.status).toBe(200);
  return (r.json as { owner: string | null }).owner;
};

/** The owner in the document's head row in the service's log store; needs no test hook. */
const storedOwner: OwnerReader = async (h, doc) =>
  (await h.parts.logs.head({ tenant: h.tenant, doc })).owner;

/** Polls until the room has no owner or `ms` has passed; the real time it took, or null. */
async function releasedWithin(
  h: Harness,
  doc: string,
  read: OwnerReader,
  ms: number,
): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if ((await read(h, doc)) === null) return Date.now() - started;
    await sleep(25);
  }
  return null;
}

const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

/** Opens a room on the service over a real WebSocket, checks it is owned, then disconnects. */
async function openThenDisconnect(h: Harness, read: OwnerReader): Promise<string> {
  const doc = await h.createDocument();
  const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
  clients.push(c);
  const w = await c.hello(h.userToken({ [doc]: 'owner' }));
  expect(w.t).toBe('welcome');
  const o = await c.open(1, doc);
  expect(o.t).toBe('ch.opened');
  expect(typeof (await read(h, doc))).toBe('string');
  c.terminate();
  return doc;
}

describe('test mode shortens the room idle timeout (BE-079 criterion 2)', () => {
  it('releases an idle room after about the shortened 1 s idle timeout', async () => {
    const h = await startHarness('memory', {
      config: { testMode: true, environment: 'test' },
      realDataPlane: true,
    });
    harnesses.push(h);
    expect(TEST_TIMERS.roomIdleMs).toBe(1_000);
    const doc = await openThenDisconnect(h, hookOwner);
    // Not before the shortened timer; the 10 s window is generous for a loaded machine and still
    // far below the 60 s default.
    const took = await releasedWithin(h, doc, hookOwner, 10_000);
    expect(took).not.toBeNull();
    expect(took!).toBeGreaterThanOrEqual(TEST_TIMERS.roomIdleMs - 100);
  });

  it('keeps the room owned past the shortened timer when test mode is off (default 60 s)', async () => {
    const h = await startHarness('memory', { realDataPlane: true });
    harnesses.push(h);
    // The switch is really off: the test hooks are not served.
    const hook = await h.call('GET', '/_test/timers', { token: h.serviceJwt() });
    expect(hook.status).toBe(404);
    const doc = await openThenDisconnect(h, storedOwner);
    await sleep(TEST_TIMERS.roomIdleMs + 500);
    expect(typeof (await storedOwner(h, doc))).toBe('string');
  });
});
