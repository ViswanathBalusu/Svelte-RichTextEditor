/**
 * PRM-052 criteria 1 and 2 (07 §9, §14): a region state change and a lease break each leave an
 * audit entry with the actor, the document, the scope and the server time, and each is a control
 * commit in the chain. Lane U-PRM-052-067.
 *
 * The audit entry is the grant store's `grants.changed` row, written in the same transaction as
 * the change (PRM-051 criterion 3). It names the scopes `region:<id>`. The in-memory grant store
 * writes no audit entry (PRM-051 Notes), so the audit half runs on PostgreSQL only; the control
 * commit half runs on both stores, with a channel open so that the room records it (as SEC-029).
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
const OPEN = 'rOpen00000000001';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`PRM-052 state change and lease break are audited and chained (${storage})`, () => {
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    }, 60_000);

    afterAll(async () => {
      await h?.close();
    });

    const t = () => (skip ? it.skip : it);

    /** Waits until the log holds a control commit at `revision` after `fromSeq`. */
    async function awaitControl(doc: string, fromSeq: number, revision: number) {
      const ref = { tenant: h.a.id, doc };
      const deadline = Date.now() + 5000;
      for (;;) {
        const rows = await h.parts.logs.read(ref, fromSeq);
        const hit = rows.find((c) => c.kind === 'control' && c.revision === revision);
        if (hit) return hit.seq;
        if (Date.now() > deadline) throw new Error('no control commit was recorded in time');
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    t()(
      'a region state change is audited with its actor, document, scope and time, and is a control commit',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        // A channel opens the document, so the room is running and records the control commit.
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, doc);
          const startSeq = (await h.parts.logs.head(ref)).seq;

          const g = await h.call('GET', `/v1/documents/${doc}/grants`, { token: h.a.apiKey });
          expect(g.status).toBe(200);
          const before = h.now();
          const put = await h.call('PUT', `/v1/documents/${doc}/regions/${LEGAL}/state`, {
            token: h.a.apiKey,
            body: { state: 'in_review' },
            headers: { 'If-Match': g.headers.get('etag')! },
          });
          expect(put.status, put.text).toBe(200);
          const after = h.now();

          const rev = (await h.parts.grants.current(ref)).revision;
          const seq = await awaitControl(doc, startSeq + 1, rev);
          expect(seq).toBeGreaterThan(startSeq);

          if (storage === 'postgres') {
            const rows = await h.parts.audit!.query(h.a.id, { kind: 'grants.changed', limit: 100 });
            const entry = rows.find((e) => e.doc === doc && e.data['rev'] === rev);
            expect(entry, JSON.stringify(rows)).toBeDefined();
            expect(entry!.tenant).toBe(h.a.id);
            expect(entry!.actor).toBe('system');
            expect(entry!.data['scopes']).toEqual([`region:${LEGAL}`]);
            expect(entry!.at).toBeGreaterThanOrEqual(before);
            expect(entry!.at).toBeLessThanOrEqual(after);
            const verdict = await (h.parts.logs as unknown as PgLogStore).verify(ref);
            expect(verdict.ok).toBe(true);
          }
        } finally {
          c.terminate();
        }
      },
      60_000,
    );

    t()(
      'a lease break by a holder of manage is audited with its actor, document, scope and time, and is a control commit',
      async () => {
        const doc = await h.createDocument(h.a, documentWithRegions());
        const ref = { tenant: h.a.id, doc };
        const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await c.hello(token);
          await c.open(1, doc);
          const path = `/v1/documents/${doc}/regions/${OPEN}/lease`;
          const editor = h.userToken(h.a, 'ed-1', { [doc]: 'editor' });
          const owner = h.userToken(h.a, 'ow-1', { [doc]: 'owner' });

          const taken = await h.call('POST', path, { token: editor });
          expect(taken.status, taken.text).toBe(201);
          const startSeq = (await h.parts.logs.head(ref)).seq;

          const before = h.now();
          const broke = await h.call('DELETE', path, { token: owner });
          expect(broke.status, broke.text).toBe(204);
          const after = h.now();

          const rev = (await h.parts.grants.current(ref)).revision;
          const seq = await awaitControl(doc, startSeq + 1, rev);
          expect(seq).toBeGreaterThan(startSeq);
          expect((await h.parts.grants.current(ref)).leases).toHaveLength(0);

          if (storage === 'postgres') {
            const rows = await h.parts.audit!.query(h.a.id, { kind: 'grants.changed', limit: 100 });
            const entry = rows.find((e) => e.doc === doc && e.data['rev'] === rev);
            expect(entry, JSON.stringify(rows)).toBeDefined();
            expect(entry!.actor).not.toBe('system');
            expect(entry!.data['scopes']).toEqual([`region:${OPEN}`]);
            expect(entry!.at).toBeGreaterThanOrEqual(before);
            expect(entry!.at).toBeLessThanOrEqual(after);
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
