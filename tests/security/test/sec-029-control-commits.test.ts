/**
 * SEC-029 criterion 3 (lane U-SEC-017-032): permission changes appear in the chain as control
 * commits, so the history a relying party reads shows each one (08 §2, §12; 07 §9).
 *
 * A grant change through the control plane and a document state change (`locked`, which the
 * control plane treats as permission data) each leave one control commit at the revision they
 * raised. The chain is read back through the log store, and on PostgreSQL the chain verifier is run
 * over the same log afterwards. Workflow changes are not in this test: no workflow is built in
 * phase 1b or 2 (SEC-029 Notes), so the criterion is proved for permission changes only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '../../../services/document-service/src/storage/log-store.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const LEGAL = 'rLegal0000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-029 permission changes are control commits in the chain (${storage})`, () => {
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    /** Waits until the log holds a control commit at or after `fromSeq` that satisfies `pick`. */
    async function awaitControl(
      doc: string,
      fromSeq: number,
      pick: (c: { revision: number }) => boolean,
    ) {
      const ref = { tenant: h.a.id, doc };
      const deadline = Date.now() + 5000;
      for (;;) {
        const rows = await h.parts.logs.read(ref, fromSeq);
        const hit = rows.find((c) => c.kind === 'control' && pick(c));
        if (hit) return { seq: hit.seq, revision: hit.revision };
        if (Date.now() > deadline) throw new Error('no control commit was recorded in time');
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    t()(
      'a grant change and a document state change each leave one control commit in the chain',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        // A channel opens the document, so the room is running and records the control commits.
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, doc);
          const startSeq = (await h.parts.logs.head(ref)).seq;

          // 1. A grant change.
          const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
          const grant = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
            token: h.a.apiKey,
            body: { grants: [{ region: LEGAL, principal: 'user:rex', role: 'editor' }] },
            headers: { 'If-Match': g.headers.get('etag')! },
          });
          expect(grant.status).toBe(200);
          const grantRev = (await h.parts.grants.current(ref)).revision;
          const first = await awaitControl(doc, startSeq + 1, (x) => x.revision === grantRev);
          const afterGrant = (await h.parts.logs.head(ref)).seq;
          expect(first.seq).toBeGreaterThan(startSeq);

          // 2. A document state change to `locked` (permission data, 07 §9).
          const d = await h.call('GET', `/v1/documents/${doc}`, { token: h.a.apiKey });
          const lock = await h.call('PATCH', `/v1/documents/${doc}`, {
            token: h.a.apiKey,
            body: { state: 'locked' },
            headers: { 'If-Match': d.headers.get('etag')! },
          });
          expect(lock.status).toBe(200);
          const lockRev = (await h.parts.grants.current(ref)).revision;
          expect(lockRev).toBeGreaterThan(grantRev);
          const second = await awaitControl(doc, afterGrant + 1, (x) => x.revision === lockRev);

          // Each permission change is exactly one control commit at its revision.
          const all = await h.parts.logs.read(ref, 1);
          const controls = all.filter((x) => x.kind === 'control');
          expect(controls.map((x) => x.revision)).toEqual(
            expect.arrayContaining([grantRev, lockRev]),
          );
          expect(controls.filter((x) => x.revision === grantRev)).toHaveLength(1);
          expect(controls.filter((x) => x.revision === lockRev)).toHaveLength(1);
          expect(second.seq).toBeGreaterThan(first.seq);

          // On PostgreSQL the chain verifier accepts the log that holds them.
          if (storage === 'postgres') {
            const verdict = await (h.parts.logs as unknown as PgLogStore).verify(ref);
            expect(verdict.ok).toBe(true);
          }
        } finally {
          c.terminate();
        }
      },
      60_000,
    );
  });
}
