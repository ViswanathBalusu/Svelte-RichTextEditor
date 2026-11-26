// FRW-043 criterion 5 as the owner's decision 31 settles it (lane w4, 2026-11-26): signing evidence
// has no tenant period. Its retention is the life of its document, so the purge job with the default
// removes nothing by age however long ago the evidence was collected, and the purge of a deleted
// document removes the document's rows and no other document's. PostgreSQL in Podman; the database
// is made for this file and dropped afterwards. docs/adr/0394-w4-FRW-084-evidence-retention.md.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVIDENCE_RETENTION_DEFAULT, runEvidencePurge } from '@docedit/authority';
import { DAY_MS, DocumentPurge } from '../../src/control-plane/document-purge.ts';
import { PgPurgeStore } from '../../src/control-plane/document-purge-pg.ts';
import { inTenant } from '../../src/storage/db.ts';
import { PgEvidenceRowStore, PgPurgeAuditSink } from '../../src/workflow/evidence-store.ts';
import { ADMIN } from '../support/env.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)(
  'evidence lasts as long as its document (FRW-043 criterion 5)',
  () => {
    let h: Harness;
    let purgePool: pg.Pool;
    beforeAll(async () => {
      h = await startHarness('postgres');
      purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 2 });
      purgePool.on('error', () => {});
      purgePool.on('connect', (c) => {
        void c.query('SET ROLE docedit_purge');
      });
    }, 60_000);
    afterAll(async () => {
      await purgePool?.end();
      await h?.close();
    });

    const record = (doc: string, participant: string) =>
      h.parts.evidence!.record(h.tenant, {
        doc,
        participant,
        kind: 'signer',
        item: 'viewed',
        facts: {
          ipAddress: '203.0.113.5',
          userAgent: 'FrwTest/43',
          items: { session: `s-${participant}`, viewedAtMs: 1 },
        },
      });
    const count = async (doc: string) => (await h.parts.evidence!.list(h.tenant, doc)).length;

    it('has no period by default: the job removes nothing by age, and the document purge removes the rows with the document', async () => {
      // The default is no period (decision 31; ADR 0394 item 1).
      expect(EVIDENCE_RETENTION_DEFAULT).toBeNull();

      const kept = await h.createDocument({ content: documentWithRegions(), title: 'kept' });
      const gone = await h.createDocument({ content: documentWithRegions(), title: 'gone' });
      for (const doc of [kept, gone]) {
        await record(doc, 'p1');
        await record(doc, 'p2');
      }

      // The rows are ten years old (the admin role may update; the service role may not), there is
      // no hold, and still nothing is removed by age. The run is audited with counts.
      await h.db!.admin.query(
        "UPDATE workflow_evidence SET collected_at = now() - interval '3650 days' WHERE tenant_id = $1",
        [h.tenant],
      );
      const tenYears = Date.now();
      for (const doc of [kept, gone]) {
        const run = await runEvidencePurge(
          new PgEvidenceRowStore(h.db!.service, h.tenant),
          new PgPurgeAuditSink(h.db!.service, h.tenant),
          {
            documentId: doc,
            nowMs: tenYears,
            retentionMs: EVIDENCE_RETENTION_DEFAULT,
            legalHold: false,
          },
        );
        expect(run.removed).toEqual([]);
        expect(run.kept).toHaveLength(2);
      }
      expect(await count(kept)).toBe(2);
      expect(await count(gone)).toBe(2);

      // Deleting the document is what ends the evidence: after the 30 days of the document purge the
      // rows of that document are gone, and the other document's rows are not touched.
      const owner = h.userToken({ [gone]: 'owner' }, { sub: 'owner-043-life' });
      expect((await h.call('DELETE', `/v1/documents/${gone}`, { token: owner })).status).toBe(204);
      const purge = new DocumentPurge({
        store: new PgPurgeStore(purgePool),
        objects: h.parts.objects,
        audit: h.parts.audit!,
        retentionMs: 30 * DAY_MS,
        now: () => Date.now(),
      });
      const early = await purge.run(h.tenant, new Set(), Date.now() + 29 * DAY_MS);
      expect(early.purged).not.toContain(gone);
      expect(await count(gone)).toBe(2);
      const run = await purge.run(h.tenant, new Set(), Date.now() + 31 * DAY_MS);
      expect(run.purged).toEqual([gone]);
      expect(await count(gone)).toBe(0);
      expect(await count(kept)).toBe(2);
      const left = await inTenant(h.db!.service, h.tenant, (c) =>
        c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM workflow_evidence WHERE tenant_id = $1 AND doc_id = $2',
          [h.tenant, gone],
        ),
      );
      expect(left.rows[0]!.n).toBe('0');
    });

    it('keeps the evidence of a document under a legal hold, as the document is kept', async () => {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'held' });
      await record(doc, 'p1');
      const owner = h.userToken({ [doc]: 'owner' }, { sub: 'owner-043-hold' });
      expect((await h.call('DELETE', `/v1/documents/${doc}`, { token: owner })).status).toBe(204);
      const purge = new DocumentPurge({
        store: new PgPurgeStore(purgePool),
        objects: h.parts.objects,
        audit: h.parts.audit!,
        retentionMs: 30 * DAY_MS,
        now: () => Date.now(),
      });
      const run = await purge.run(h.tenant, new Set([doc]), Date.now() + 400 * DAY_MS);
      expect(run.purged).not.toContain(doc);
      expect(await count(doc)).toBe(1);
    });
  },
);
