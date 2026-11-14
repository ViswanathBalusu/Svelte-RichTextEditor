// FRW-041 criterion 1, the PostgreSQL part (lane V-FRW-037-054): evidence is stored in the workflow
// table `workflow_evidence` and in no other table of the database. A marker value is written as
// evidence, a commit log with ordinary commits and a sealed-PDF record are written beside it, and
// then every table of the database is searched for the marker, as text, through the admin role (which
// sees every row). Only `workflow_evidence` may hold it. The test does not cover the object store
// (exports, checkpoints kept as objects) and does not cover the search index's own files, so FRW-041
// criterion 1 stays unticked on this evidence alone. Each run makes its own database, named with the
// lane, and drops it. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, ensureServiceRole, migrate } from '../../src/index.ts';
import { inTenant } from '../../src/storage/db.ts';
import {
  ADMIN,
  newTenant,
  pgStores,
  postgresUnavailable,
  SERVICE_USER,
  settings,
} from '../support/env.ts';
import { newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'evidence is stored only in the workflow evidence table (FRW-041 criterion 1, PostgreSQL)',
  () => {
    const suffix = randomBytes(4).toString('hex');
    const dbName = `docedit_t_v_frw_037_054_ev_${suffix}`;
    const marker = `EVIDENCE-MARKER-V-FRW-037-054-${suffix}`;
    let service: pg.Pool;
    let admin: pg.Pool;

    beforeAll(async () => {
      const password = settings()['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
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
    });

    it('holds the evidence marker in workflow_evidence and in no other table', async () => {
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
      expect(await s.logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]))).toEqual({
        status: 'ok',
      });

      await inTenant(service, tenant, async (c) => {
        await c.query(
          `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
           VALUES (gen_random_uuid(), $1, $2, 'p0', 'signed_at', now(), $3)`,
          [tenant, ref.doc, JSON.stringify({ value: marker })],
        );
      });

      // Every base table of the database, searched as text by the admin role.
      const tables = await admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      expect(tables.rows.length).toBeGreaterThan(1);
      const holders: string[] = [];
      for (const { table_name } of tables.rows) {
        const hit = await admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table_name}" AS x WHERE x::text LIKE $1`,
          [`%${marker}%`],
        );
        if ((hit.rows[0]?.n ?? 0) > 0) holders.push(table_name);
      }
      expect(holders).toEqual(['workflow_evidence']);
    });
  },
);
