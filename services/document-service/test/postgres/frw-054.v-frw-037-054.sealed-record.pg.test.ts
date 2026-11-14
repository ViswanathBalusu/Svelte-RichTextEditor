// FRW-054 criterion 1 in PostgreSQL (lane V-FRW-037-054): the hash of the sealed PDF is recorded in
// table `workflow_sealed_pdf` (0061_workflow_sealed_pdf.sql), once per workflow, under row-level
// security, and the service role cannot rewrite or delete the record. Each run makes its own
// database, named with the lane, and drops it. Skipped when PostgreSQL is not up
// (infra/test-env.ps1 up). Test values only.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, ensureServiceRole, migrate, PgDocumentStore } from '../../src/index.ts';
import { inTenant } from '../../src/storage/db.ts';
import { readSealedPdfRecord, recordSealedPdf } from '../../src/workflow/sealed-pdf-pg.ts';
import { ADMIN, newTenant, postgresUnavailable, SERVICE_USER, settings } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

interface LaneDatabase {
  service: pg.Pool;
  admin: pg.Pool;
  drop(): Promise<void>;
}

/** A database of this lane's own, migrated by the admin role, which the service role then uses. */
async function createLaneDatabase(): Promise<LaneDatabase> {
  const name = `docedit_t_v_frw_037_054_${randomBytes(4).toString('hex')}`;
  const password = settings().DOCEDIT_PG_SERVICE_PASSWORD ?? '';
  const root = new pg.Client(ADMIN);
  await root.connect();
  try {
    await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
    try {
      await ensureServiceRole(root, SERVICE_USER, password);
    } finally {
      await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
    }
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  const admin = new pg.Pool({ ...ADMIN, database: name, max: 4 });
  admin.on('error', () => {});
  const c = await admin.connect();
  try {
    await migrate(c);
  } finally {
    c.release();
  }
  const service = createPool({
    host: ADMIN.host,
    port: ADMIN.port,
    user: SERVICE_USER,
    password,
    database: name,
    max: 6,
  });
  return {
    service,
    admin,
    async drop() {
      await service.end().catch(() => {});
      await admin.end().catch(() => {});
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    },
  };
}

const HASH = 'a'.repeat(63) + '1';
const OTHER_HASH = 'b'.repeat(64);

describe.skipIf(unavailable !== null)(
  'sealed PDF record over PostgreSQL (FRW-054 criterion 1)',
  () => {
    let db: LaneDatabase;
    beforeAll(async () => {
      db = await createLaneDatabase();
    });
    afterAll(() => db?.drop());

    async function seedDocument(tenant: string): Promise<string> {
      const docs = new PgDocumentStore(db.service);
      const doc = await docs.create(tenant, { cdmVersion: 1, createdBy: 'u' });
      return doc.id;
    }

    it('records the hash of the sealed bytes and reads the record back', async () => {
      const tenant = newTenant();
      const docId = await seedDocument(tenant);
      const workflowId = `wf-${randomUUID().slice(0, 8)}`;
      const retainUntilMs = Date.now() + 7 * 86_400_000;
      await recordSealedPdf(db.service, tenant, {
        docId,
        workflowId,
        sealedHash: HASH,
        storedHash: HASH,
        objectKey: `tenants/${tenant}/documents/${docId}/workflows/${workflowId}/final.pdf`,
        retainUntilMs,
      });
      const back = await readSealedPdfRecord(db.service, tenant, docId, workflowId);
      expect(back).not.toBeNull();
      expect(back?.sealedHash).toBe(HASH);
      expect(back?.storedHash).toBe(HASH);
      expect(back?.retainUntilMs).toBe(retainUntilMs);
    });

    it('refuses a second record for the same workflow', async () => {
      const tenant = newTenant();
      const docId = await seedDocument(tenant);
      const workflowId = 'wf-once';
      const record = {
        docId,
        workflowId,
        sealedHash: HASH,
        storedHash: HASH,
        objectKey: 'k',
        retainUntilMs: Date.now() + 86_400_000,
      };
      await recordSealedPdf(db.service, tenant, record);
      await expect(
        recordSealedPdf(db.service, tenant, {
          ...record,
          sealedHash: OTHER_HASH,
          storedHash: OTHER_HASH,
        }),
      ).rejects.toMatchObject({
        code: '23505',
      });
      const back = await readSealedPdfRecord(db.service, tenant, docId, workflowId);
      expect(back?.sealedHash).toBe(HASH);
    });

    it('refuses a record whose stored hash differs from the sealed hash', async () => {
      const tenant = newTenant();
      const docId = await seedDocument(tenant);
      await expect(
        recordSealedPdf(db.service, tenant, {
          docId,
          workflowId: 'wf-mismatch',
          sealedHash: HASH,
          storedHash: OTHER_HASH,
          objectKey: 'k',
          retainUntilMs: Date.now() + 86_400_000,
        }),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it("keeps one tenant's record out of another tenant's reads", async () => {
      const tenant = newTenant();
      const other = newTenant();
      const docId = await seedDocument(tenant);
      await recordSealedPdf(db.service, tenant, {
        docId,
        workflowId: 'wf-rls',
        sealedHash: HASH,
        storedHash: HASH,
        objectKey: 'k',
        retainUntilMs: Date.now() + 86_400_000,
      });
      expect(await readSealedPdfRecord(db.service, other, docId, 'wf-rls')).toBeNull();
    });

    it('gives the service role no update and no delete on a recorded hash', async () => {
      const tenant = newTenant();
      const docId = await seedDocument(tenant);
      await recordSealedPdf(db.service, tenant, {
        docId,
        workflowId: 'wf-immutable',
        sealedHash: HASH,
        storedHash: HASH,
        objectKey: 'k',
        retainUntilMs: Date.now() + 86_400_000,
      });
      await expect(
        inTenant(db.service, tenant, (c) =>
          c.query(
            "UPDATE workflow_sealed_pdf SET sealed_hash = $1 WHERE workflow_id = 'wf-immutable'",
            [OTHER_HASH],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inTenant(db.service, tenant, (c) =>
          c.query("DELETE FROM workflow_sealed_pdf WHERE workflow_id = 'wf-immutable'"),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const back = await readSealedPdfRecord(db.service, tenant, docId, 'wf-immutable');
      expect(back?.sealedHash).toBe(HASH);
    });
  },
);
