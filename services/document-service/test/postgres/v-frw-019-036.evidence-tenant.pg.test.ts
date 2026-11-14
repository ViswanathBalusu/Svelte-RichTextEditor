// FRW-041 criterion 5 in PostgreSQL (lane V-FRW-019-036): another tenant's credential cannot read
// or change a tenant's workflow evidence. The service role reaches the table only inside a
// transaction that names one tenant (BE-011); the table is protected by row-level security
// (`docedit_protect`, migration 0060). Each run makes its own database and drops it. Skipped when
// PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDocumentStore } from '../../src/index.ts';
import { inTenant, sqlState } from '../../src/storage/db.ts';
import { newTenant, postgresUnavailable } from '../support/env.ts';
import { createLaneDatabase, type LaneDatabase } from '../support/v-frw-019-036-db.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'workflow evidence is tenant-isolated (FRW-041 criterion 5, PostgreSQL)',
  () => {
    let db: LaneDatabase;
    beforeAll(async () => {
      db = await createLaneDatabase();
    });
    afterAll(() => db?.drop());

    async function seedDoc(tenant: string, rows: number): Promise<string> {
      const doc = await new PgDocumentStore(db.service).create(tenant, {
        cdmVersion: 1,
        createdBy: 'u',
      });
      await inTenant(db.service, tenant, async (c) => {
        for (let i = 0; i < rows; i++) {
          await c.query(
            `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
           VALUES (gen_random_uuid(), $1, $2, $3, 'signed_at', now(), $4)`,
            [tenant, doc.id, `p${i}`, JSON.stringify({ value: `${tenant}-${i}` })],
          );
        }
      });
      return doc.id;
    }

    async function count(tenant: string, docId?: string): Promise<number> {
      return inTenant(
        db.service,
        tenant,
        async (c) => {
          const r = await c.query<{ n: string }>(
            docId === undefined
              ? 'SELECT count(*)::text AS n FROM workflow_evidence'
              : 'SELECT count(*)::text AS n FROM workflow_evidence WHERE doc_id = $1',
            docId === undefined ? [] : [docId],
          );
          return Number(r.rows[0]?.n ?? 0);
        },
        { readOnly: true },
      );
    }

    it('shows one tenant only its own evidence, by any filter', async () => {
      const a = newTenant();
      const b = newTenant();
      const docA = await seedDoc(a, 2);
      await seedDoc(b, 1);

      expect(await count(a)).toBe(2);
      expect(await count(b)).toBe(1);
      // Tenant B asks for tenant A's document by its identifier: row-level security hides every row.
      expect(await count(b, docA)).toBe(0);
      // Tenant B asks for tenant A's rows through the tenant column: the same.
      const seenByB = await inTenant(
        db.service,
        b,
        (c) =>
          c.query<{ tenant_id: string }>(
            'SELECT tenant_id FROM workflow_evidence WHERE tenant_id = $1',
            [a],
          ),
        { readOnly: true },
      );
      expect(seenByB.rows).toHaveLength(0);
    });

    it("refuses tenant B an insert into tenant A and deletes none of A's rows", async () => {
      const a = newTenant();
      const b = newTenant();
      const docA = await seedDoc(a, 2);
      await seedDoc(b, 1);

      let refused: string | undefined;
      try {
        await inTenant(db.service, b, (c) =>
          c.query(
            `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
           VALUES (gen_random_uuid(), $1, $2, 'forged', 'signed_at', now(), '{"value":"x"}')`,
            [a, docA],
          ),
        );
      } catch (e) {
        refused = sqlState(e);
      }
      expect(refused).toBe('42501');

      const deleted = await inTenant(db.service, b, (c) =>
        c.query('DELETE FROM workflow_evidence WHERE tenant_id = $1', [a]),
      );
      expect(deleted.rowCount).toBe(0);
      expect(await count(a, docA)).toBe(2);
    });

    it('gives the service role no UPDATE on evidence, so a stored row is not rewritten', async () => {
      const a = newTenant();
      const docA = await seedDoc(a, 1);
      let refused: string | undefined;
      try {
        await inTenant(db.service, a, (c) =>
          c.query('UPDATE workflow_evidence SET data = \'{"value":"changed"}\' WHERE doc_id = $1', [
            docA,
          ]),
        );
      } catch (e) {
        refused = sqlState(e);
      }
      expect(refused).toBe('42501');
      const data = await inTenant(
        db.service,
        a,
        (c) =>
          c.query<{ data: { value: string } }>(
            'SELECT data FROM workflow_evidence WHERE doc_id = $1',
            [docA],
          ),
        { readOnly: true },
      );
      expect(data.rows[0]?.data.value).toBe(`${a}-0`);
    });
  },
);
