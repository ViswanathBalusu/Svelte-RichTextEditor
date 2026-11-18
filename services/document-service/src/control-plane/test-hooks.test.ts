/**
 * The fault-injection hooks of the control plane (BE-079 criteria 3, 4, 5; ADR 0054), tested at the
 * handler with a stub data plane whose hooks record their calls. The composition that mounts the
 * hooks only in test mode is server.ts; its refusal in production is config.ts and is not tested here.
 * This file shows the routing only: what each hook does to a real room, its log and its audit trail
 * is tested in src/data-plane/hooks.test.ts.
 */
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '../log.ts';
import type { DataPlane, DataPlaneTestHooks } from '../seams.ts';
import { TEST_TIMERS, testHooks } from './test-hooks.ts';
import type { TokenService } from './tokens.ts';

const TENANT = 'tenant-hooks';
const TOKEN = 'svc-hooks-test-token';
const DOC = '0190f0a0-0000-7000-8000-0000000000aa';

/** A request as the hooks read it: a bearer credential and an optional JSON body. */
function request(method: string, body?: unknown, token: string | null = TOKEN): IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  const headers: Record<string, string> = {};
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return Object.assign(req, { method, headers }) as unknown as IncomingMessage;
}

/** A stub data plane whose hooks record each call, and the state and audit events they return. */
function stubHooks(): { hooks: DataPlaneTestHooks; calls: string[] } {
  const calls: string[] = [];
  const events = [{ marker: 'audit-1' }] as unknown as Awaited<
    ReturnType<DataPlaneTestHooks['auditEvents']>
  >;
  const hooks: DataPlaneTestHooks = {
    dropDatabase: (down) => {
      calls.push(`dropDatabase:${down}`);
    },
    failNextWrite: (ref, at) => {
      calls.push(`failNextWrite:${ref.tenant}:${ref.doc}:${at}`);
    },
    killRoom: async (ref) => {
      calls.push(`killRoom:${ref.doc}`);
      return true;
    },
    dropNextAnnouncement: (ref) => {
      calls.push(`dropNextAnnouncement:${ref.doc}`);
    },
    rewind: async (ref, head) => {
      calls.push(`rewind:${ref.doc}:${head}`);
      return { head, incarnation: 'inc-2' };
    },
    state: async (ref) => {
      calls.push(`state:${ref.doc}`);
      return { seq: 7, epoch: 3, owner: 'node-a', incarnation: 'inc-1', chainHead: 'c0ffee' };
    },
    auditEvents: async (ref) => {
      calls.push(`audit:${ref.doc}`);
      return events;
    },
  };
  return { hooks, calls };
}

function build(hooks: DataPlaneTestHooks | undefined) {
  const logged: LogFields[] = [];
  const logger: Logger = {
    info() {},
    error() {},
    warn(fields) {
      logged.push(fields);
    },
  };
  const tokens = {
    async verifyService(credential: string) {
      if (credential !== TOKEN) throw new Error('not a service credential of the test');
      return { tenant: TENANT, credential };
    },
  } as unknown as TokenService;
  const handler = testHooks({
    tokens,
    dataPlane: { hooks } as unknown as DataPlane,
    timers: TEST_TIMERS,
    logger,
  });
  const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) =>
    handler(request(method, body, token), new URL(`http://service.test/_test${path}`));
  return { call, logged };
}

describe('fault-injection hooks (BE-079)', () => {
  it('does not offer the hooks when the data plane has none, and refuses calls without a service credential', async () => {
    const { call, logged } = build(undefined);
    const off = await call('POST', '/database', { down: true });
    expect(off.status).toBe(404);
    expect(off.body).toMatchObject({ code: 'not_found' });
    const unsigned = await call('POST', '/database', { down: true }, null);
    expect(unsigned.status).toBe(401);
    expect(logged).toEqual([]);
  });

  it('lets the kit drop the database and fail the next write before or after its insert, and logs each use (criteria 3, 5)', async () => {
    const { hooks, calls } = stubHooks();
    const { call, logged } = build(hooks);
    expect((await call('POST', '/database', { down: true })).status).toBe(204);
    expect((await call('POST', '/database', { down: false })).status).toBe(204);
    expect(
      (await call('POST', `/documents/${DOC}/fail-next-write`, { at: 'after-insert' })).status,
    ).toBe(204);
    // Anything but `after-insert` means `before-insert`.
    expect((await call('POST', `/documents/${DOC}/fail-next-write`, {})).status).toBe(204);
    expect(calls).toEqual([
      'dropDatabase:true',
      'dropDatabase:false',
      `failNextWrite:${TENANT}:${DOC}:after-insert`,
      `failNextWrite:${TENANT}:${DOC}:before-insert`,
    ]);
    expect(logged.map((f) => f.message)).toEqual([
      'database.down',
      'database.up',
      'fail-next-write.after-insert',
      'fail-next-write.before-insert',
    ]);
    expect(logged.every((f) => f.event === 'test.hook' && f.tenant === TENANT)).toBe(true);
    expect(logged[2]).toMatchObject({ doc: DOC });
  });

  it('rewinds a log to a sequence number and answers the new incarnation, and refuses a bad number (ADR 0398)', async () => {
    const { hooks, calls } = stubHooks();
    const { call, logged } = build(hooks);
    const done = await call('POST', `/documents/${DOC}/rewind`, { to: 2 });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ head: 2, incarnation: 'inc-2' });
    for (const bad of [{ to: -1 }, { to: 1.5 }, { to: '2' }, {}]) {
      const r = await call('POST', `/documents/${DOC}/rewind`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(calls).toEqual([`rewind:${DOC}:2`]);
    expect(logged.map((f) => f.message)).toContain('rewind');
  });
  it('kills a room, drops one grant announcement, reads the chain head, epoch and audit events, and logs each use (criteria 3, 4, 5)', async () => {
    const { hooks, calls } = stubHooks();
    const { call, logged } = build(hooks);
    const killed = await call('POST', `/documents/${DOC}/kill-room`);
    expect(killed.status).toBe(200);
    expect(killed.body).toEqual({ killed: true });
    expect((await call('POST', `/documents/${DOC}/drop-announcement`)).status).toBe(204);
    const state = await call('GET', `/documents/${DOC}/state`);
    expect(state.status).toBe(200);
    expect(state.body).toEqual({
      seq: 7,
      epoch: 3,
      owner: 'node-a',
      incarnation: 'inc-1',
      chainHead: 'c0ffee',
    });
    const audit = await call('GET', `/documents/${DOC}/audit`);
    expect(audit.body).toEqual({ items: [{ marker: 'audit-1' }] });
    expect(calls).toEqual([
      `killRoom:${DOC}`,
      `dropNextAnnouncement:${DOC}`,
      `state:${DOC}`,
      `audit:${DOC}`,
    ]);
    expect(logged.map((f) => f.message)).toEqual([
      'kill-room',
      'drop-announcement',
      'state',
      'audit',
    ]);
    // A path that is not a hook, or a method the hook does not take, is not found.
    expect((await call('POST', `/documents/${DOC}/state`)).body).toMatchObject({
      code: 'not_found',
    });
    expect((await call('GET', `/documents/${DOC}/kill-room`)).body).toMatchObject({
      code: 'not_found',
    });
    expect(calls).toHaveLength(4);
  });

  it('reports the shortened timers in force, which are shorter than the production values of the spec (criterion 2, reported only)', async () => {
    const { call } = build(undefined);
    const timers = await call('GET', '/timers');
    expect(timers.status).toBe(200);
    expect(timers.body).toEqual(TEST_TIMERS);
    expect(TEST_TIMERS.tokenLifetimeS).toBeLessThanOrEqual(900);
    expect(TEST_TIMERS.idempotencyTtlMs).toBeLessThan(24 * 60 * 60 * 1000);
    expect(TEST_TIMERS.previewWindowMs).toBeLessThan(10_000);
  });

  it('restarts the node in place, or says it cannot (PRO-024 criterion 6)', async () => {
    const { hooks, calls } = stubHooks();
    const restarting = build({
      ...hooks,
      restartNode: async () => {
        calls.push('restartNode');
      },
    });
    const done = await restarting.call('POST', '/restart-node');
    expect(done.status).toBe(204);
    expect(calls).toEqual(['restartNode']);
    expect(restarting.logged.map((l) => l.message)).toEqual(['restart-node']);
    // A data plane that cannot restart answers not_found, and a GET is not the hook.
    const plain = build(stubHooks().hooks);
    expect((await plain.call('POST', '/restart-node')).body).toMatchObject({ code: 'not_found' });
    expect((await restarting.call('GET', '/restart-node')).body).toMatchObject({
      code: 'not_found',
    });
  });
});
