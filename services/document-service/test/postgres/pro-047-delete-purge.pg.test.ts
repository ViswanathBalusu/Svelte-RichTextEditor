// PRO-047 criterion 4 through the composed service on PostgreSQL: `DELETE /documents/{id}` is a soft
// delete (the document cannot be read, its data stays), and the scheduled task `documents.purge`
// removes the data once the retention has passed. The retention is 30 days by default (owner
// decision 30, docs/owner-decisions-2026-11-15.md; `purgeAfterDays`). The service clock is moved
// with `advance`; no job is run by hand. The database is made for this file and dropped afterwards.
// Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../../src/control-plane/document-purge.ts';
import { skipReason, startHarness, type Harness } from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)(
  'a deleted document is purged by the scheduler after the retention (PRO-047, PostgreSQL)',
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness('postgres', {
        realDataPlane: true,
        purgeRole: true,
        config: { jobIdleMs: 50 },
      });
    }, 60_000);
    afterAll(async () => {
      await h?.close();
    });

    const rowsOf = async (doc: string) =>
      (
        await h.db!.admin.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM documents WHERE id = $1`,
          [doc],
        )
      ).rows[0]!.n;

    async function until<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
      const end = Date.now() + 20_000;
      for (;;) {
        const v = await read();
        if (done(v) || Date.now() > end) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    it('keeps the data of a deleted document inside the retention and removes it after', async () => {
      const doc = await h.createDocument({ title: 'PRO-047 delete' });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
      expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);

      // Soft delete: the document cannot be read, and its row stays.
      expect((await h.call('GET', `/v1/documents/${doc}`, { token: h.apiKey })).status).toBe(404);
      expect(await rowsOf(doc)).toBe('1');

      // 29 days later the scheduler's slot is due, and the document is still inside its retention.
      h.advance(29 * DAY_MS);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await rowsOf(doc)).toBe('1');
      expect(await h.parts.audit!.query(h.tenant, { kind: 'document.purged', limit: 10 })).toEqual(
        [],
      );

      // Two days more: past 30 days, so the scheduled task removes it and audits it.
      h.advance(2 * DAY_MS);
      const gone = await until(
        () => rowsOf(doc),
        (n) => n === '0',
      );
      expect(gone).toBe('0');
      const audit = await h.parts.audit!.query(h.tenant, { kind: 'document.purged', limit: 10 });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ doc, actor: 'system' });
    }, 90_000);
  },
);
