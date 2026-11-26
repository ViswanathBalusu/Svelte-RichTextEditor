// SEC-057 criteria 3 and 4 (lane w8): evidence follows the document, and a legal hold stops the purge.
//
// Signing evidence has no period of its own (12 section 7; owner decision 31): it is kept as long as
// the signed document exists and deleted with it. So here, on PostgreSQL through the service: the
// evidence rows of a deleted document are still there while the retention runs and while a legal
// hold is in force, and are gone once the purge has run, with the rest of the document. The purge
// runs as the job does, over a pool whose connections `SET ROLE docedit_purge` (migration 0073).
// The database is made for this file and dropped afterwards. Test values only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import { inTenant } from '../../src/storage/db.ts';
import { ADMIN } from '../support/env.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)('evidence follows the document through the purge (SEC-057)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let purge: DocumentPurge;

  beforeAll(async () => {
    h = await startHarness('postgres', {});
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    purge = new DocumentPurge({
      store: new PgPurgeStore(purgePool),
      objects: h.parts.objects,
      audit: h.parts.audit!,
      retentionMs: 30 * DAY_MS,
      now: () => Date.now(),
    });
  }, 60_000);

  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  async function evidenceRows(doc: string): Promise<number> {
    return inTenant(
      h.db!.service,
      h.tenant,
      async (c) => {
        const r = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM workflow_evidence WHERE tenant_id = $1 AND doc_id = $2',
          [h.tenant, doc],
        );
        return Number(r.rows[0]?.n ?? 0);
      },
      { readOnly: true },
    );
  }

  it('keeps the evidence while the retention runs and under a hold, and deletes it with the document', async () => {
    const d = await h.createDocument({ content: documentWithRegions(), title: 'Signed' });
    const other = await h.createDocument({ content: documentWithRegions(), title: 'Other' });
    for (const doc of [d, other])
      await h.db!.admin.query(
        `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
         VALUES ($1, $2, $3, 'p0', 'signed_at', now() - interval '400 days', '{"value":"v"}'::jsonb)`,
        [randomUUID(), h.tenant, doc],
      );
    expect(await evidenceRows(d)).toBe(1);

    const owner = h.userToken({ [d]: 'owner' }, { sub: 'olga' });
    const del = await h.call('DELETE', `/v1/documents/${d}`, { token: owner });
    expect(del.status, del.text).toBe(204);

    // The evidence is old, but it has no clock of its own: it stays while the document does.
    const early = await purge.run(h.tenant, new Set(), Date.now() + 29 * DAY_MS);
    expect(early.purged).toEqual([]);
    expect(await evidenceRows(d)).toBe(1);

    // A legal hold stops the purge after the retention has passed (criterion 3, the purge half).
    const held = await purge.run(h.tenant, new Set([d]), Date.now() + 31 * DAY_MS);
    expect(held.purged).toEqual([]);
    expect(held.skipped).toContainEqual({ doc: d, reason: 'legal-hold' });
    expect(await evidenceRows(d)).toBe(1);

    // Without the hold, the purge deletes the evidence with the document, and only that document's.
    const run = await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS);
    expect(run.purged).toEqual([d]);
    expect(await evidenceRows(d)).toBe(0);
    expect(await evidenceRows(other)).toBe(1);
  });
});
