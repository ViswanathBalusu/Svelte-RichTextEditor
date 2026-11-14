/**
 * SEC-026 criterion 3 (lane V-SEC-017-032): a grant with an expiry and a region lease with an
 * expiry both end access on time, with no other event (10 §3.3; 07 §4 last paragraph, §9, §10;
 * PRM-007, PRM-043). The room recomputes at the earliest expiry, so a user's next commit is refused
 * once the grant or the lease that gave the access has ended.
 *
 * The region lease is put in the grants store with a short expiry (the control plane's default is
 * five minutes, which a test cannot wait for). It is stored before the room opens, so the room
 * reads it with the grants. Run over memory and PostgreSQL through the security harness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const LEGAL = 'rLegal0000000001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-026 grant and lease expiries end access on time (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const patchGrants = async (doc: string, grants: unknown[]) => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: h.a.apiKey,
        body: { grants },
        headers: { 'If-Match': g.headers.get('etag')! },
      });
      expect(r.status).toBe(200);
    };

    /** Stores a region lease held by `sub`, expiring at `expiresAt` (ms), before the room opens. */
    const storeLease = async (doc: string, sub: string, expiresAt: number) => {
      const ref = { tenant: h.a.id, doc };
      const holder = (await h.parts.users.resolve(h.a.id, sub)).surrogate;
      const cur = await h.parts.grants.current(ref);
      await h.parts.grants.change(
        ref,
        { putLeases: [{ region: LEGAL, holder, expiresAt }] },
        { actor: 'system', ifRevision: cur.revision },
      );
    };

    const open = async (sub: string, doc: string) => {
      const token = await h.mintToken(h.a, sub, { [doc]: 'editor' });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, doc);
      return c;
    };

    const legalPos = async (doc: string) => {
      const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      return posInside(content.doc, 'pLegal0000000001');
    };

    t()(
      'the grant expiry ends access with no event while the holder still holds the lease',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const started = h.now();
        // The grant ends at +3000 ms; the lease, held by rex, ends later at +6000 ms. The margin is
        // wide because setup (the grant patch, the lease, the socket and hello) runs before the
        // first commit, and under load it takes more than the 600 ms this window once had.
        await patchGrants(doc, [
          {
            region: LEGAL,
            principal: 'user:rex',
            role: 'editor',
            expiresAt: new Date(started + 3000).toISOString(),
          },
        ]);
        await storeLease(doc, 'rex', started + 6000);
        const c = await open('rex', doc);
        try {
          expect(
            (
              await c.submit(1, {
                id: uuid7(),
                base: 0,
                steps: [insertText(await legalPos(doc), 'A')],
              })
            ).t,
          ).toBe('sync.ack');
          // Wait past the grant's expiry; the lease is still in force, so only the grant has ended.
          await sleep(Math.max(0, started + 3300 - h.now()));
          const head = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
            .json.seq as number;
          const after = await c.submit(1, {
            id: uuid7(),
            base: head,
            steps: [insertText(await legalPos(doc), 'B')],
          });
          expect(after.t).toBe('sync.reject');
          expect(after.d?.['code']).toBe('permission_denied');
          expect(after.d?.['scopes']).toContain(`region:${LEGAL}`);
        } finally {
          c.terminate();
        }
      },
    );

    t()(
      'the lease expiry ends the other holder’s hold with no event, and the next commit is accepted',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const started = h.now();
        // rex has an editor grant with no expiry; bob holds the lease, which ends at +700 ms.
        await patchGrants(doc, [{ region: LEGAL, principal: 'user:rex', role: 'editor' }]);
        await storeLease(doc, 'bob', started + 700);
        const c = await open('rex', doc);
        try {
          // While bob holds the lease, rex has at most view and comment in the region.
          const held = await c.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(await legalPos(doc), 'HELD')],
          });
          expect(held.t).toBe('sync.reject');
          expect(held.d?.['code']).toBe('permission_denied');

          // The lease ends with no event; the room recomputes at its expiry, so rex may edit again.
          await sleep(Math.max(0, started + 900 - h.now()));
          const head = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
            .json.seq as number;
          const free = await c.submit(1, {
            id: uuid7(),
            base: head,
            steps: [insertText(await legalPos(doc), 'FREE')],
          });
          expect(free.t).toBe('sync.ack');
        } finally {
          c.terminate();
        }
      },
    );
  });
}
