// BE-014 criterion 1 on PostgreSQL (lane V-BE-001-014): the partitions of the coming months of
// `audit_events` are created by a scheduled job (BE-052). The test drops the partition of the month
// three months ahead, then runs the job the server registers (`auditPartitionsTask`) through the
// scheduler, the PostgreSQL job queue and a job runner, as the service does. The partition must come
// back. It skips when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_PARTITIONS_TASK,
  auditPartitionsTask,
} from '../../src/control-plane/audit-partitions-task.ts';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { JobRunner } from '../../src/control-plane/jobs/runner.ts';
import { SCHEDULE_KIND, Scheduler } from '../../src/control-plane/scheduler.ts';
import { PgAuditStore } from '../../src/data-plane/pg/audit.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const why = await postgresUnavailable();

/** The name of the monthly partition `offset` months from the current UTC month. */
function partitionName(offset: number): string {
  const d = new Date();
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
  const y = first.getUTCFullYear();
  const m = String(first.getUTCMonth() + 1).padStart(2, '0');
  return `audit_events_${y}_${m}`;
}

describe.skipIf(why !== null)(
  'audit partitions created by the scheduled job (BE-014 criterion 1, V-BE-001-014)',
  () => {
    let db: TestDatabase;

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      await db?.drop();
    });

    const exists = async (name: string): Promise<boolean> => {
      const r = await db.admin.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [
        `public.${name}`,
      ]);
      return r.rows[0]?.ok === true;
    };

    it('the scheduled job re-creates a missing partition of the coming months', async () => {
      const coming = partitionName(3);
      // The migrations created the partitions from the month before to three months ahead.
      expect(await exists(coming)).toBe(true);
      // An empty future partition can be dropped by the owner without losing data.
      await db.admin.query(`DROP TABLE public.${coming}`);
      expect(await exists(coming)).toBe(false);

      const audit = new PgAuditStore(db.service);
      const queue = new PgJobQueue(db.service);
      const task = auditPartitionsTask(audit);
      expect(task.name).toBe(AUDIT_PARTITIONS_TASK);
      const scheduler = new Scheduler({
        queue,
        tasks: [task],
        tenants: async () => [],
        now: () => Date.now(),
      });
      await scheduler.ensure();
      const runner = new JobRunner({
        queue,
        handlers: { [SCHEDULE_KIND]: scheduler.handler },
        worker: 'v-be-001-014-audit',
        leaseMs: 60_000,
        idleMs: 1,
        retryAfterMs: 1,
        now: () => Date.now(),
      });
      for (let i = 0; i < 5; i++) await runner.runOnce();

      expect(await exists(coming)).toBe(true);
    });
  },
);
