/**
 * SEC-026 — a revoked grant stops working at once, even when messages are lost (10 §3.3; 04 G7;
 * 07 §9). The log write of every commit is conditional on the grants revision it was checked
 * against, so a lost `perm.changed` cannot let a commit land under permissions that were replaced.
 *
 * The fault hooks of BE-079 arrive in phase 1b; until then the announcement is dropped with an
 * in-process double — the harness changes grants in storage without telling the room (SEC-026 Notes).
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

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-026 permission changes cannot be raced (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** Grants a principal a region role through the control plane, which notifies the room. */
    const patchGrants = async (doc: string, grants: unknown[]) => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: h.a.apiKey,
        body: { grants },
        headers: { 'If-Match': g.headers.get('etag')! },
      });
      expect(r.status).toBe(200);
    };
    const open = async (sub: string, role: string, doc: string) => {
      const token = await h.mintToken(h.a, sub, { [doc]: role });
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
      'a commit checked under the old revision is not stored when the removal announcement is lost',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        await patchGrants(doc, [{ region: LEGAL, principal: 'user:rex', role: 'editor' }]);
        const c = await open('rex', 'editor', doc);
        try {
          const pos = await legalPos(doc);
          // With the grant, rex can edit the restricted region.
          expect(
            (await c.submit(1, { id: uuid7(), base: 0, steps: [insertText(pos, 'RACE_A')] })).t,
          ).toBe('sync.ack');

          // The grant is removed in storage; the announcement to the room is dropped (the double).
          const ref = { tenant: h.a.id, doc };
          const rex = (await h.parts.users.resolve(h.a.id, 'rex')).surrogate;
          const cur = await h.parts.grants.current(ref);
          await h.parts.grants.change(
            ref,
            { removeGrants: [{ region: LEGAL, principal: `user:${rex}` }] },
            { actor: 'system', ifRevision: cur.revision },
          );

          const seqBefore = (
            await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })
          ).json.seq as number;
          // rex, still holding old access in the room, submits again: the conditional write fails,
          // because it was checked under the revision that has been replaced.
          const raced = await c.submit(1, {
            id: uuid7(),
            base: seqBefore,
            steps: [insertText(await legalPos(doc), 'RACE_B')],
          });
          expect(raced.t).toBe('sync.reject');
          expect(raced.d?.['code']).toBe('unavailable'); // revision moved under it; retry

          // The raced content edit was not stored (the room may record a control commit for the new
          // revision, but RACE_B never lands).
          const afterRace = (
            await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })
          ).json;
          expect(JSON.stringify(afterRace.doc)).toContain('RACE_A');
          expect(JSON.stringify(afterRace.doc)).not.toContain('RACE_B');

          // Resubmitted, it is now checked against the new permissions and refused.
          const retry = await c.submit(1, {
            id: uuid7(),
            base: afterRace.seq as number,
            steps: [insertText(await legalPos(doc), 'RACE_C')],
          });
          expect(retry.t).toBe('sync.reject');
          expect(retry.d?.['code']).toBe('permission_denied');
          expect(retry.d?.['scopes']).toContain(`region:${LEGAL}`);
        } finally {
          c.terminate();
        }
      },
    );

    t()(
      'an expired grant stops working without any event, because the room recomputes at the expiry',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        // A wide window: the first submit must land before expiry even when the suite runs under load.
        const expiresAt = new Date(h.now() + 1500).toISOString();
        await patchGrants(doc, [
          { region: LEGAL, principal: 'user:rex', role: 'editor', expiresAt },
        ]);
        const c = await open('rex', 'editor', doc);
        try {
          // Before the expiry, rex can edit the restricted region.
          expect(
            (
              await c.submit(1, {
                id: uuid7(),
                base: 0,
                steps: [insertText(await legalPos(doc), 'A')],
              })
            ).t,
          ).toBe('sync.ack');
          // Let the grant expire with no other event; the room's expiry timer recomputes access.
          await new Promise((r) =>
            setTimeout(r, Math.max(0, Date.parse(expiresAt) - h.now()) + 300),
          );
          const head = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
            .json.seq as number;
          const after = await c.submit(1, {
            id: uuid7(),
            base: head,
            steps: [insertText(await legalPos(doc), 'B')],
          });
          expect(after.t).toBe('sync.reject');
          expect(after.d?.['code']).toBe('permission_denied');
        } finally {
          c.terminate();
        }
      },
    );
  });
}
