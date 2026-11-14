/**
 * SEC-026 criterion: once the PATCH of grants has returned, commits submitted by the affected user
 * in a stress run that interleaves changes and batches are never stored with an access revision
 * older than the revision in force when they were stored (07 §9; 10 §3.3).
 *
 * The run alternates a grant and a removal of `editor` on the restricted region, through the control
 * plane, and between them submits single commits and pairs of commits (batches) as that user. Each
 * submission records the revision that its PATCH returned (the revision in force from then on). The
 * log is then read and checks two things:
 *  - every stored commit of the user has a revision at least the one its PATCH had returned before
 *    the submission was sent (a commit cannot be stored under a grant that was already withdrawn);
 *  - the revisions of the stored log never decrease in `seq` order (the revision in force never goes
 *    back), so no commit was stored under an older revision than its predecessor.
 * A commit sent after a removal has returned is also required not to be acknowledged.
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
const ROUNDS = 10;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-026 permission changes cannot be raced in a stress run (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** PATCHes the grants; resolves with the revision in force once it has returned. */
    const patchGrants = async (doc: string, grants: unknown[]): Promise<number> => {
      const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
      const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token: h.a.apiKey,
        body: { grants },
        headers: { 'If-Match': g.headers.get('etag')! },
      });
      expect(r.status).toBe(200);
      return (await h.parts.grants.current({ tenant: h.a.id, doc })).revision;
    };

    t()(
      'interleaved grant changes and batches: no stored commit is older than the revision it was sent under',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        const token = await h.mintToken(h.a, 'rex', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, doc);

          // The minimum revision each commit must carry, keyed by commit identifier.
          const minRev = new Map<string, number>();
          const acked: string[] = [];
          let revision = await patchGrants(doc, [
            { region: LEGAL, principal: 'user:rex', role: 'editor' },
          ]);
          let granted = true;

          for (let round = 0; round < ROUNDS; round++) {
            // Change the grant: alternately withdraw it and restore it.
            revision = await patchGrants(
              doc,
              granted ? [] : [{ region: LEGAL, principal: 'user:rex', role: 'editor' }],
            );
            granted = !granted;

            // A batch of two commits and then a single commit, all sent after the PATCH returned.
            const content = (
              await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey })
            ).json;
            const pos = posInside(content.doc, 'pLegal0000000001');
            const batch = [uuid7(), uuid7()];
            const sends = batch.map((id, k) => {
              minRev.set(id, revision);
              return c.submit(1, {
                id,
                base: 0,
                steps: [insertText(pos + k, `s${round}${k}`)],
              });
            });
            const single = uuid7();
            minRev.set(single, revision);
            const singleSend = c.submit(1, { id: single, base: 0, steps: [insertText(pos, 'x')] });

            const answers = await Promise.all([...sends, singleSend]);
            const ids = [...batch, single];
            answers.forEach((a, k) => {
              if (a.t === 'sync.ack') acked.push(ids[k]!);
              // Sent after a removal returned: the user has no access then, so it cannot be acked.
              // It is refused with permission_denied, or unavailable when the revision moved under it.
              if (!granted) {
                expect(a.t, `round ${round} commit ${k} after removal`).toBe('sync.reject');
                expect(['permission_denied', 'unavailable']).toContain(a.d?.['code']);
              }
            });
          }

          // The stored log: every submitted commit that was stored has a revision at least the one
          // its PATCH had returned, and the revision in force never goes back in seq order.
          const head = await h.parts.logs.head(ref);
          const stored = await h.parts.logs.read(ref, 1, head.seq);
          let last = -Infinity;
          for (const s of stored) {
            expect(s.revision, `seq ${s.seq} revision`).toBeGreaterThanOrEqual(last);
            last = s.revision;
            const floor = minRev.get(s.id);
            if (floor !== undefined)
              expect(s.revision, `commit ${s.id}`).toBeGreaterThanOrEqual(floor);
          }
          // Sanity: when commits were acknowledged, the check above had stored commits to check.
          if (acked.length > 0) expect(stored.some((s) => minRev.has(s.id))).toBe(true);
          expect(acked.length, 'some grant-time commits were stored').toBeGreaterThan(0);
        } finally {
          c.terminate();
        }
      },
      60_000,
    );
  });
}
