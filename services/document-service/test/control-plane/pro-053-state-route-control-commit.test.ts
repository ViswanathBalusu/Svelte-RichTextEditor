// PRO-053 criterion 1 end to end (lane V-PRO-052-068): `PUT /documents/{id}/regions/{rid}/state`
// over HTTP, on the real data plane with a connected room. The state change must reach the room,
// which stores it as one control commit at the grants revision the change made (07 §9, §11). The
// control plane's route test (prm-046-region-state-route.test.ts) uses the stub room and so cannot
// show the commit; this file does. Runs with memory storage and with PostgreSQL in Podman when the
// test environment is up (infra/test-env.ps1); the harness creates and drops its own database.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import {
  skipReason,
  startHarness,
  documentWithRegions,
  type Harness,
  type Storage,
} from './support.ts';

const LEGAL = 'rLegal0000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`a region state set over HTTP is stored as a control commit (${storage}; PRO-053 criterion 1)`, async () => {
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

    /** Waits until the room has stored the control commits, or the time runs out. */
    const controlCommits = async (doc: string, want: number) => {
      const ref = { tenant: h.tenant, doc };
      const deadline = Date.now() + 10_000;
      for (;;) {
        const found = (await h.parts.logs.read(ref)).filter((c) => c.kind === 'control');
        if (found.length >= want || Date.now() > deadline) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    it.skipIf(skip)(
      'the route stores one control commit at the new grants revision, and a second change stores a second',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'PRO-053 route',
        });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-053-${uuid7()}` });
        // A room must be open for the change to reach the log (07 §9): the owner opens the document.
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        const welcome = await c.hello(owner);
        expect(welcome.t, JSON.stringify(welcome.d)).toBe('welcome');
        const opened = await c.open(1, doc);
        expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');

        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(grants.status).toBe(200);
        const first = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: owner,
          body: { state: 'in_review' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        expect(first.status, first.text).toBe(200);
        const firstRev = Number(first.headers.get('etag')!.replace(/"/g, '').replace(/^g/, ''));
        const afterFirst = await controlCommits(doc, 1);
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]!.revision).toBe(firstRev);

        const second = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: owner,
          body: { state: 'draft' },
          headers: { 'If-Match': first.headers.get('etag')! },
        });
        expect(second.status, second.text).toBe(200);
        const secondRev = Number(second.headers.get('etag')!.replace(/"/g, '').replace(/^g/, ''));
        expect(secondRev).toBe(firstRev + 1);
        const afterSecond = await controlCommits(doc, 2);
        expect(afterSecond.map((x) => x.revision)).toEqual([firstRev, secondRev]);
      },
      60_000,
    );

    it.skipIf(skip)(
      'refuses a state other than draft, in_review or approved with validation_failed, and stores nothing',
      async () => {
        const doc = await h.createDocument({
          content: documentWithRegions(),
          title: 'PRO-053 bad state',
        });
        const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-053b-${uuid7()}` });
        const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
        clients.push(c);
        await c.hello(owner);
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        const grants = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        const bad = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
          token: owner,
          body: { state: 'published' },
          headers: { 'If-Match': grants.headers.get('etag')! },
        });
        expect(bad.status, bad.text).toBe(400);
        expect(bad.json.code).toBe('validation_failed');
        const again = await h.call('GET', `/v1/documents/${doc}/grants`, { token: owner });
        expect(again.headers.get('etag')).toBe(grants.headers.get('etag'));
        expect(await controlCommits(doc, 1)).toHaveLength(0);
      },
      60_000,
    );
  });
}
