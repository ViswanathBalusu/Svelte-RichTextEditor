// FRW-043 in PostgreSQL (lane U-FRW-037-054): the evidence purge job over the `workflow_evidence`
// table and the `audit_events` trail. Covers the legal hold (criterion 2) and the audit entry of a
// purge, which holds counts and the instant only (criterion 4). Not covered here: the chain check
// and the commit log of criterion 1, and the erasure with tombstones of criterion 3. Each run makes
// its own database, named with the lane, and drops it. Skipped when PostgreSQL is not up
// (infra/test-env.ps1 up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runEvidencePurge } from '@docedit/authority';
import { createPool, ensureServiceRole, migrate, PgDocumentStore } from '../../src/index.ts';
import { inTenant } from '../../src/storage/db.ts';
import { PgEvidenceRowStore, PgPurgeAuditSink } from '../../src/workflow/evidence-store.ts';
import { ADMIN, newTenant, postgresUnavailable, SERVICE_USER, settings } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const DAY = 86_400_000;
const RETENTION_MS = 7 * DAY;

interface LaneDatabase {
  service: pg.Pool;
  admin: pg.Pool;
  drop(): Promise<void>;
}

/** A database of this lane's own, migrated by the admin role, which the service role then uses. */
async function createLaneDatabase(): Promise<LaneDatabase> {
  const name = `docedit_t_u_frw_037_054_${randomBytes(4).toString('hex')}`;
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

describe.skipIf(unavailable !== null)('evidence purge over PostgreSQL (FRW-043)', () => {
  let db: LaneDatabase;
  beforeAll(async () => {
    db = await createLaneDatabase();
  });
  afterAll(() => db?.drop());

  /** A document of the tenant, and its evidence rows collected at the given ages in days. */
  async function seed(tenant: string, ages: readonly number[], nowMs: number): Promise<string> {
    const docs = new PgDocumentStore(db.service);
    const doc = await docs.create(tenant, { cdmVersion: 1, createdBy: 'u' });
    await inTenant(db.service, tenant, async (c) => {
      for (const [i, age] of ages.entries()) {
        await c.query(
          `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
           VALUES (gen_random_uuid(), $1, $2, $3, 'signed_at', $4, $5)`,
          [
            tenant,
            doc.id,
            `p${i}`,
            new Date(nowMs - age * DAY).toISOString(),
            JSON.stringify({ value: `v${i}` }),
          ],
        );
      }
    });
    return doc.id;
  }

  async function rowCount(tenant: string, docId: string): Promise<number> {
    return inTenant(
      db.service,
      tenant,
      async (c) => {
        const r = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM workflow_evidence WHERE tenant_id = $1 AND doc_id = $2',
          [tenant, docId],
        );
        return Number(r.rows[0]?.n ?? 0);
      },
      { readOnly: true },
    );
  }

  async function purgeEvents(tenant: string, docId: string) {
    const r = await inTenant(
      db.service,
      tenant,
      (c) =>
        c.query<{ kind: string; data: Record<string, unknown>; at: Date; doc_id: string }>(
          `SELECT kind, data, at, doc_id FROM audit_events
            WHERE tenant_id = $1 AND doc_id = $2 AND kind = 'evidence.purge' ORDER BY at`,
          [tenant, docId],
        ),
      { readOnly: true },
    );
    return r.rows;
  }

  it('holds every row while a legal hold is in force, and records the run (criteria 2 and 4)', async () => {
    const tenant = newTenant();
    const nowMs = Date.now();
    const docId = await seed(tenant, [10, 10, 1], nowMs);
    const store = new PgEvidenceRowStore(db.service, tenant);
    const sink = new PgPurgeAuditSink(db.service, tenant);

    const held = await runEvidencePurge(store, sink, {
      documentId: docId,
      nowMs,
      retentionMs: RETENTION_MS,
      legalHold: true,
    });

    expect(held.removed).toEqual([]);
    expect(held.kept).toHaveLength(3);
    expect(await rowCount(tenant, docId)).toBe(3);
    const events = await purgeEvents(tenant, docId);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ removedCount: 0, keptCount: 3, legalHold: true });
  });

  it('removes expired rows once the hold is lifted, keeps the rest, and audits counts only (criteria 2 and 4)', async () => {
    const tenant = newTenant();
    const nowMs = Date.now();
    const docId = await seed(tenant, [10, 10, 1], nowMs);
    const store = new PgEvidenceRowStore(db.service, tenant);
    const sink = new PgPurgeAuditSink(db.service, tenant);

    const before = await store.listRows(docId);
    const expiredIds = before
      .filter((r) => nowMs - r.collectedAtMs >= RETENTION_MS)
      .map((r) => r.id);
    const freshId = before.find((r) => nowMs - r.collectedAtMs < RETENTION_MS)?.id;

    const result = await runEvidencePurge(store, sink, {
      documentId: docId,
      nowMs,
      retentionMs: RETENTION_MS,
      legalHold: false,
    });

    expect([...result.removed].sort()).toEqual(expiredIds.sort());
    expect(result.kept).toEqual([freshId]);
    const after = await store.listRows(docId);
    expect(after.map((r) => r.id)).toEqual([freshId]);

    const events = await purgeEvents(tenant, docId);
    expect(events).toHaveLength(1);
    const audit = events[0]!;
    expect(audit.data).toEqual({ removedCount: 2, keptCount: 1, legalHold: false });
    // The entry names no row and holds no personal data: only the counts, the flag and the instant.
    const text = JSON.stringify(audit.data);
    for (const id of expiredIds) expect(text).not.toContain(id);
    expect(Object.keys(audit.data).sort()).toEqual(['keptCount', 'legalHold', 'removedCount']);
    expect(audit.at.getTime()).toBe(nowMs);
  });

  it("never reads or deletes another tenant's evidence (BE-011)", async () => {
    const tenantA = newTenant();
    const tenantB = newTenant();
    const nowMs = Date.now();
    const docB = await seed(tenantB, [10, 10], nowMs);
    // Tenant A's store, asked about tenant B's document, sees no rows and deletes none.
    const storeA = new PgEvidenceRowStore(db.service, tenantA);
    const sinkA = new PgPurgeAuditSink(db.service, tenantA);

    const result = await runEvidencePurge(storeA, sinkA, {
      documentId: docB,
      nowMs,
      retentionMs: RETENTION_MS,
      legalHold: false,
    });

    expect(result.removed).toEqual([]);
    expect(await rowCount(tenantB, docB)).toBe(2);
  });
});
