// FRW-043 criterion 1 in PostgreSQL, the part that can be tested without a sealed PDF (lane
// V-FRW-019-036): a purge of expired evidence deletes the evidence rows and leaves the commit log
// and its hash chain as they were, and chain verification still passes. The sealed PDF is not built
// yet (FRW-049, FRW-050), so the criterion stays open. Each run makes its own database and drops
// it. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvidencePurge } from '@docedit/authority';
import { inTenant } from '../../src/storage/db.ts';
import { PgEvidenceRowStore, PgPurgeAuditSink } from '../../src/workflow/evidence-store.ts';
import { pgStores, newTenant, postgresUnavailable } from '../support/env.ts';
import { newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';
import { createLaneDatabase, type LaneDatabase } from '../support/v-frw-019-036-db.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const DAY = 86_400_000;
const RETENTION_MS = 7 * DAY;

describe.skipIf(unavailable !== null)(
  'evidence purge leaves the commit log and its chain (FRW-043 criterion 1, PostgreSQL)',
  () => {
    let db: LaneDatabase;
    beforeAll(async () => {
      db = await createLaneDatabase();
    });
    afterAll(() => db?.drop());

    it('deletes expired evidence and leaves the commit log, the head and the chain unchanged', async () => {
      const tenant = newTenant();
      const s = pgStores(db.service);
      const h: StoreHarness = {
        tenant,
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
      const { ref, epoch } = await newDocument(h);

      const appended = await s.logs.append(
        ref,
        write(epoch, [stepCommit(1), stepCommit(2), stepCommit(3)]),
      );
      expect(appended).toEqual({ status: 'ok' });
      const chainBefore = await s.logs.verify(ref);
      expect(chainBefore).toEqual({ ok: true, head: 3 });
      const logBefore = await s.logs.read(ref);
      const headBefore = await s.logs.head(ref);

      // Two evidence rows of this document are past their retention; one is recent.
      const nowMs = Date.now();
      await inTenant(db.service, tenant, async (c) => {
        for (const [i, age] of [10, 10, 1].entries()) {
          await c.query(
            `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
           VALUES (gen_random_uuid(), $1, $2, $3, 'signed_at', $4, $5)`,
            [
              tenant,
              ref.doc,
              `p${i}`,
              new Date(nowMs - age * DAY).toISOString(),
              JSON.stringify({ value: `v${i}` }),
            ],
          );
        }
      });

      const result = await runEvidencePurge(
        new PgEvidenceRowStore(db.service, tenant),
        new PgPurgeAuditSink(db.service, tenant),
        { documentId: ref.doc, nowMs, retentionMs: RETENTION_MS, legalHold: false },
      );
      expect(result.removed).toHaveLength(2);
      expect(result.kept).toHaveLength(1);

      // The commit log, its head and the chain verify exactly as before the purge.
      expect(await s.logs.read(ref)).toEqual(logBefore);
      expect(await s.logs.head(ref)).toEqual(headBefore);
      expect(await s.logs.verify(ref)).toEqual(chainBefore);
    });
  },
);
