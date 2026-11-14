// PRO-015 criterion 3 end to end (lane U-PRO-001-017, round 2): a host-signed token with `wfp`,
// `amr` and `auth_time` is verified by the real token service, a real WebSocket client opens a
// channel on the real data plane, and the session's record of the channel is read back after the
// channel opened: the three claims as given, with the token's `jti` and the server time. The claims
// are not presented as identity: no frame sent to the client carries them, and the connection is
// the same as without them. Runs on memory storage, and on PostgreSQL in Podman when the test
// environment is up (infra/test-env.ps1); the harness creates and drops its own database.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DepDataPlaneInstance } from '../../src/data-plane/index.ts';
import type { Session } from '../../src/data-plane/session.ts';
import { DepClient } from '../data-plane/client.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

/** A `sub` unique to this run and lane. */
const subOf = (n: string) =>
  `u-pro-015-asserted-${n}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`wfp, amr and auth_time recorded per channel (${storage}; PRO-015 criterion 3)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    const connect = async (token: string): Promise<DepClient> => {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      const w = await c.hello(token);
      expect(w.t, JSON.stringify(w.d)).toBe('welcome');
      return c;
    };

    /** The data plane's session of the connection whose token named `sub`. */
    const sessionOf = (sub: string): Session => {
      const plane = h.service.dataPlane as unknown as DepDataPlaneInstance;
      const found = plane.sessions.filter((s) => s.identity?.sub === sub);
      expect(found).toHaveLength(1);
      return found[0]!;
    };

    it.skipIf(skip)(
      'keeps the claims as given, with the jti and server time, after the channel opens; no frame carries them',
      async () => {
        const doc = await h.createDocument();
        const sub = subOf('a');
        const jti = uuid7();
        const token = h.userToken(
          { [doc]: 'editor' },
          { sub, jti, wfp: 'participant-legal-1', amr: ['pwd', 'otp'], auth_time: 1_763_000_000 },
        );
        const before = h.now();
        const c = await connect(token);
        const opened = await c.open(1, doc);
        expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');

        const record = sessionOf(sub).assertedClaims(1);
        expect(record).toEqual({
          claims: { wfp: 'participant-legal-1', amr: ['pwd', 'otp'], auth_time: 1_763_000_000 },
          jti,
          recordedAt: expect.any(Number),
        });
        expect(record!.recordedAt).toBeGreaterThanOrEqual(before);
        expect(record!.recordedAt).toBeLessThanOrEqual(h.now());
        // The record cannot be changed afterwards.
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record!.claims.amr)).toBe(true);

        // Recorded, not vouched for: nothing the service sends carries the assertions.
        for (const frame of c.frames) {
          expect(frame).not.toContain('participant-legal-1');
          expect(frame).not.toContain('"amr"');
          expect(frame).not.toContain('auth_time');
          expect(frame).not.toContain('1763000000');
        }
      },
      60_000,
    );

    it.skipIf(skip)(
      'gives the same access as a token without them, and records nothing for that token',
      async () => {
        const doc = await h.createDocument();
        const subA = subOf('b');
        const subB = subOf('c');
        const withClaims = await connect(
          h.userToken({ [doc]: 'commenter' }, { sub: subA, wfp: 'p-2', amr: ['hwk'] }),
        );
        const without = await connect(h.userToken({ [doc]: 'commenter' }, { sub: subB }));
        const a = await withClaims.open(1, doc);
        const b = await without.open(1, doc);
        expect(a.t).toBe('ch.opened');
        expect(b.t).toBe('ch.opened');
        expect(a.d!['access']).toEqual(b.d!['access']);
        expect(sessionOf(subA).assertedClaims(1)?.claims).toEqual({ wfp: 'p-2', amr: ['hwk'] });
        expect(sessionOf(subB).assertedClaims(1)).toBeUndefined();
        // A channel that is not open has no record.
        expect(sessionOf(subA).assertedClaims(2)).toBeUndefined();
      },
      60_000,
    );

    it.skipIf(skip)(
      "records a channel's own token, and replaces the record when a refreshed token is accepted",
      async () => {
        const doc = await h.createDocument();
        const other = await h.createDocument();
        const sub = subOf('d');
        const c = await connect(
          h.userToken({ [doc]: 'editor', [other]: 'viewer' }, { sub, amr: ['pwd'] }),
        );
        // Channel 2 opens with a token of its own, which asserts something else.
        const ownJti = uuid7();
        const own = h.userToken(
          { [other]: 'viewer' },
          { sub, jti: ownJti, amr: ['sms'], auth_time: 1_763_000_100 },
        );
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        expect((await c.open(2, other, { token: own })).t).toBe('ch.opened');
        const s = sessionOf(sub);
        expect(s.assertedClaims(1)?.claims).toEqual({ amr: ['pwd'] });
        expect(s.assertedClaims(2)).toMatchObject({
          claims: { amr: ['sms'], auth_time: 1_763_000_100 },
          jti: ownJti,
        });

        // A session refresh with new assertions replaces channel 1's record and leaves channel 2's.
        const refreshJti = uuid7();
        const refreshed = h.userToken(
          { [doc]: 'editor', [other]: 'viewer' },
          { sub, jti: refreshJti, wfp: 'p-3', amr: ['pwd', 'hwk'], auth_time: 1_763_000_200 },
        );
        const id = c.nextId();
        c.send({ t: 'auth.refresh', id, d: { token: refreshed } });
        expect((await c.take((m) => m.re === id, 5000, 'answer to auth.refresh')).t).toBe(
          'auth.ok',
        );
        expect(s.assertedClaims(1)).toMatchObject({
          claims: { wfp: 'p-3', amr: ['pwd', 'hwk'], auth_time: 1_763_000_200 },
          jti: refreshJti,
        });
        expect(s.assertedClaims(2)?.jti).toBe(ownJti);

        // A refresh without them clears the record: it holds what the token in force asserts.
        const bareId = c.nextId();
        c.send({
          t: 'auth.refresh',
          id: bareId,
          d: { token: h.userToken({ [doc]: 'editor', [other]: 'viewer' }, { sub }) },
        });
        expect((await c.take((m) => m.re === bareId, 5000, 'answer to auth.refresh')).t).toBe(
          'auth.ok',
        );
        expect(s.assertedClaims(1)).toBeUndefined();
      },
      60_000,
    );
  });
}
