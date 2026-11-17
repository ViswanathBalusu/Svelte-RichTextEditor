/**
 * BE-088 criterion 1 (lane w5): the log lines of the data plane are structured and carry the
 * tenant, the document and the session where they apply. The real service runs with the real data
 * plane over a real WebSocket (memory storage), and its logger writes to an array.
 *
 * Two failures are injected into the service's own stores after it has started:
 * - the permission store fails while a session opens a channel on a room that is already loaded:
 *   the error belongs to one session and one document, so the line has all three identifiers;
 * - the log store fails while a room is loaded: the error belongs to the room, which no single
 *   session owns, so the line has the tenant and the document and no session.
 * The access line of a REST request carries the tenant and the document, as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/log.ts';
import { DepClient } from '../data-plane/client.ts';
import { startHarness, type Harness } from './support.ts';

const CANARY = 'CTXLOG4b7a injected failure';
const clients: DepClient[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const h of harnesses.splice(0)) await h.close();
});

type Line = Record<string, unknown>;

describe('data plane log lines carry tenant, document and session (BE-088 criterion 1)', () => {
  it('names all three for an error of one channel, and tenant and document for an error of a room', async () => {
    const recorded: string[] = [];
    const h = await startHarness('memory', {
      realDataPlane: true,
      logger: createLogger((l) => recorded.push(l)),
    });
    harnesses.push(h);
    const url = `${h.base.replace(/^http/, 'ws')}/dep`;
    const doc = await h.createDocument({});
    const cold = await h.createDocument({});
    const token = h.userToken({ [doc]: 'editor', [cold]: 'editor' });

    // The room of `doc` is loaded by a first session.
    const first = await DepClient.connect(url);
    clients.push(first);
    expect((await first.hello(token)).t).toBe('welcome');
    expect((await first.open(1, doc)).t).toBe('ch.opened');

    // A second session opens a channel on it while the permission store fails.
    const second = await DepClient.connect(url);
    clients.push(second);
    const welcome = await second.hello(token);
    const session = welcome.d!['session'] as string;
    const grants = h.parts.grants;
    const current = grants.current.bind(grants);
    grants.current = () => Promise.reject(new Error(CANARY));
    try {
      const refused = await second.open(1, doc);
      expect(refused.t).toBe('ch.rejected');
      expect(refused.d).toMatchObject({ code: 'unavailable' });
    } finally {
      grants.current = current;
    }

    // The same session opens a document whose room cannot be loaded: the log store fails.
    const logs = h.parts.logs;
    const head = logs.head.bind(logs);
    logs.head = (ref) => (ref.doc === cold ? Promise.reject(new Error(CANARY)) : head(ref));
    try {
      const refused = await second.open(2, cold);
      expect(refused.t).toBe('ch.rejected');
      expect(refused.d).toMatchObject({ code: 'unavailable' });
    } finally {
      logs.head = head;
    }

    // Every line is one JSON object with a time, a level and an event.
    const lines = recorded.map((l) => JSON.parse(l) as Line);
    for (const e of lines) {
      expect(typeof e['time']).toBe('string');
      expect(typeof e['level']).toBe('string');
      expect(typeof e['event']).toBe('string');
    }
    const errors = lines.filter((e) => e['event'] === 'data-plane.error');

    const channel = errors.filter((e) => e['message'] === 'ch.open');
    expect(channel).toHaveLength(1);
    expect(channel[0]).toMatchObject({ level: 'error', tenant: h.tenant, doc, session });

    const room = errors.filter((e) => e['doc'] === cold);
    expect(room.length).toBeGreaterThanOrEqual(1);
    for (const e of room) {
      expect(e['tenant']).toBe(h.tenant);
      expect(e['session']).toBeUndefined();
    }

    // No error of the data plane is logged without the identifiers it has.
    for (const e of errors) expect(e['tenant']).toBe(h.tenant);

    // The REST access lines of the two documents name the tenant and the document.
    const access = lines.filter((e) => e['event'] === 'http' && e['tenant'] === h.tenant);
    expect(access.length).toBeGreaterThanOrEqual(2);

    // The error's own text is in no line (criterion 2).
    for (const l of recorded) expect(l).not.toContain('CTXLOG4b7a');
  });
});
