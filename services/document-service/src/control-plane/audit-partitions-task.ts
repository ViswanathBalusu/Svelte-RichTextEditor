/**
 * The scheduled job that creates the audit partitions ahead of time (BE-014 criterion 1, BE-052).
 * `src/server.ts` registers it when the audit trail is in PostgreSQL. It is a function of its own so
 * that a test can run the same job through the scheduler against the database
 * (`test/control-plane/be-014-v-be-001-014-audit-schedule.pg.test.ts`).
 */
import type { ScheduledTask } from './scheduler.ts';

/** The partition store the job calls: `PgAuditStore.ensurePartitions`. */
export interface AuditPartitionMaker {
  ensurePartitions(months?: number): Promise<number>;
}

export const AUDIT_PARTITIONS_TASK = 'audit.partitions';

export function auditPartitionsTask(audit: AuditPartitionMaker): ScheduledTask {
  return {
    name: AUDIT_PARTITIONS_TASK,
    everyMs: 24 * 60 * 60 * 1000,
    run: async () => {
      await audit.ensurePartitions();
    },
  };
}
