// FRW-043 criterion 1 in full (lane V-FRW-037-054): a purge of expired evidence deletes the evidence
// rows and leaves the commit log, its hash chain and the sealed PDF untouched, and chain
// verification still passes. The sealed PDF is the one written by `storeAndRecordSealedPdf` to the
// Object Lock bucket (FRW-054 criterion 1) and recorded in `workflow_sealed_pdf`; the test reads it
// back, checks its hash against the record, and checks that an overwrite and a delete are still
// refused after the purge. The test makes its own PostgreSQL database and its own Object Lock bucket,
// both named with V-FRW-037-054, and removes them afterwards. Skipped when PostgreSQL or the S3-compatible
// store is not up (infra/test-env.ps1 up). Test values only.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvidencePurge } from '@docedit/authority';
import { createPool, ensureServiceRole, migrate } from '../../src/index.ts';
import { inTenant } from '../../src/storage/db.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { readSealedPdf, sealedHash, sealedPdfKey } from '../../src/objects/sealed-pdf.ts';
import { PgEvidenceRowStore, PgPurgeAuditSink } from '../../src/workflow/evidence-store.ts';
import { storeAndRecordSealedPdf } from '../../src/workflow/sealed-pdf-finalise.ts';
import { readSealedPdfRecord } from '../../src/workflow/sealed-pdf-pg.ts';
import {
  pgStores,
  newTenant,
  postgresUnavailable,
  ADMIN,
  SERVICE_USER,
  settings,
} from '../support/env.ts';
import { newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';

const S = settings();
const endpoint = `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`;
const region = S['DOCEDIT_S3_REGION'] ?? 'us-east-1';
const accessKeyId = S['DOCEDIT_S3_ACCESS_KEY'] ?? '';
const secretAccessKey = S['DOCEDIT_S3_SECRET_KEY'] ?? '';

const suffix = randomBytes(4).toString('hex');
const bucket = `docedit-v-frw-037-054-purge-${suffix}`;
const objects = new S3ObjectStore({ endpoint, region, bucket, accessKeyId, secretAccessKey });

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore({
      endpoint,
      region,
      bucket: 'docedit-probe',
      accessKeyId,
      secretAccessKey,
    }).exists('probe');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${endpoint} (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

const DAY = 86_400_000;
const RETENTION_MS = 7 * DAY;
const sealBytes = new TextEncoder().encode(
  '%PDF-1.7\n% V-FRW-037-054 sealed sample for FRW-043 criterion 1\n%%EOF\n',
);

describe.skipIf(unavailable !== null)(
  'evidence purge leaves the commit log, the chain and the sealed PDF untouched (FRW-043 criterion 1, PostgreSQL and Object Lock)',
  () => {
    const dbName = `docedit_t_v_frw_037_054_${suffix}`;
    let service: pg.Pool;
    let admin: pg.Pool;
    // Locked objects can be removed only once their retention has ended.
    const retainUntilMs = Date.now() + 6_000;

    beforeAll(async () => {
      const password = S['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
        try {
          await ensureServiceRole(root, SERVICE_USER, password);
        } finally {
          await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
        }
        await root.query(`CREATE DATABASE ${dbName}`);
      } finally {
        await root.end();
      }
      admin = new pg.Pool({ ...ADMIN, database: dbName, max: 2 });
      admin.on('error', () => {});
      const c = await admin.connect();
      try {
        await migrate(c);
      } finally {
        c.release();
      }
      service = createPool({
        host: ADMIN.host,
        port: ADMIN.port,
        user: SERVICE_USER,
        password,
        database: dbName,
        max: 4,
      });
      await objects.createBucket({ objectLock: true });
    });

    afterAll(async () => {
      await service?.end().catch(() => {});
      await admin?.end().catch(() => {});
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await r.end();
      }
      const wait = retainUntilMs - Date.now() + 500;
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      await objects
        .delete(sealedPdfKey(tenantForCleanup, docForCleanup, wfForCleanup))
        .catch(() => undefined);
      await objects.deleteBucket().catch(() => undefined);
    });

    let tenantForCleanup = '';
    let docForCleanup = '';
    let wfForCleanup = '';

    it('purges expired evidence and leaves the commit log, the chain and the sealed PDF as they were', async () => {
      const tenant = newTenant();
      const s = pgStores(service);
      const h: StoreHarness = {
        tenant,
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
      const { ref, epoch } = await newDocument(h);

      // The commit log: three commits, verified before the purge.
      expect(
        await s.logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2), stepCommit(3)])),
      ).toEqual({
        status: 'ok',
      });
      const chainBefore = await s.logs.verify(ref);
      expect(chainBefore).toEqual({ ok: true, head: 3 });
      const logBefore = await s.logs.read(ref);
      const headBefore = await s.logs.head(ref);

      // The sealed PDF, written write-once and recorded by its hash (FRW-054 criterion 1).
      const workflowId = `wf-${randomUUID().slice(0, 8)}`;
      tenantForCleanup = tenant;
      docForCleanup = ref.doc;
      wfForCleanup = workflowId;
      const sealedHashBefore = sealedHash(sealBytes);
      const stored = await storeAndRecordSealedPdf(service, objects, {
        tenant,
        docId: ref.doc,
        workflowId,
        bytes: sealBytes,
        sealedHash: sealedHashBefore,
        retainUntilMs,
      });
      expect(stored.store).toEqual({ ok: true, storedHash: sealedHashBefore });
      const recordBefore = await readSealedPdfRecord(service, tenant, ref.doc, workflowId);
      expect(recordBefore?.storedHash).toBe(sealedHashBefore);

      // Two evidence rows are past their retention; one is recent.
      const nowMs = Date.now();
      await inTenant(service, tenant, async (c) => {
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
        new PgEvidenceRowStore(service, tenant),
        new PgPurgeAuditSink(service, tenant),
        { documentId: ref.doc, nowMs, retentionMs: RETENTION_MS, legalHold: false },
      );
      expect(result.removed).toHaveLength(2);
      expect(result.kept).toHaveLength(1);

      // The commit log, its head and the chain verify exactly as before the purge.
      expect(await s.logs.read(ref)).toEqual(logBefore);
      expect(await s.logs.head(ref)).toEqual(headBefore);
      expect(await s.logs.verify(ref)).toEqual(chainBefore);

      // The sealed PDF is untouched: the bytes read back hash to the recorded hash, the record is
      // the same, and the store still refuses an overwrite and a delete while the retention lasts.
      const back = await readSealedPdf(objects, tenant, ref.doc, workflowId);
      expect(back).not.toBeNull();
      expect(sealedHash(back!)).toBe(recordBefore?.storedHash);
      expect(await readSealedPdfRecord(service, tenant, ref.doc, workflowId)).toEqual(recordBefore);
      await expect(
        objects.putRetained(
          sealedPdfKey(tenant, ref.doc, workflowId),
          new TextEncoder().encode('x'),
          retainUntilMs,
        ),
      ).rejects.toThrow();
      await expect(objects.delete(sealedPdfKey(tenant, ref.doc, workflowId))).rejects.toThrow();
    });
  },
);
