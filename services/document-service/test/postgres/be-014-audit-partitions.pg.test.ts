// BE-014 criterion 1 in PostgreSQL (lane V-BE-001-014): after the migrations run, `audit_events` is
// partitioned by range on `at`, and the partitions of the coming months exist. The scheduled job
// that creates them (BE-052) is not built, so this test does not tick the criterion. It checks the
// structure only. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAuditEvent } from '../../src/data-plane/pg/audit.ts';
import { inTenant } from '../../src/storage/db.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'audit_events partitions (PostgreSQL, BE-014 V-BE-001-014)',
  () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(() => db?.drop());

    it('audit_events is partitioned by range on the column at', async () => {
      const r = await db.admin.query<{ strategy: string; key: string }>(
        `SELECT p.partstrat AS strategy, a.attname AS key
         FROM pg_partitioned_table p
         JOIN pg_class c ON c.oid = p.partrelid
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = p.partattrs[0]
        WHERE c.relname = 'audit_events'`,
      );
      expect(r.rows).toEqual([{ strategy: 'r', key: 'at' }]);
    });

    it('the partitions of the current and the next months exist after the migrations', async () => {
      const r = await db.admin.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM pg_inherits i
         JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = 'audit_events'`,
      );
      expect(Number(r.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(4);
    });

    it('an event dated three months ahead lands in a partition, so the coming period is covered', async () => {
      const tenant = newTenant();
      const at = new Date();
      at.setUTCMonth(at.getUTCMonth() + 3);
      await inTenant(db.service, tenant, (c) =>
        insertAuditEvent(c, {
          id: randomUUID(),
          tenant,
          doc: null,
          actor: 'system',
          kind: 'grants.changed',
          data: { rev: 1, scopes: ['doc'] },
          at: at.getTime(),
        }),
      );
      const r = await db.admin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM audit_events WHERE tenant_id = $1',
        [tenant],
      );
      expect(r.rows[0]?.n).toBe('1');
    });
  },
);
