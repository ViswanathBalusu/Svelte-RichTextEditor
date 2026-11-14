// BE-016 criterion 4 (lane U-BE-015-028): after every migration of the repository has run on a
// fresh database, the log tables still have the partition count set once in the baseline (BE-008).
// The static guard in src/storage/partitions.test.ts checks the migration text; this checks the
// result of running them. Runs against PostgreSQL; skips when it is not up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('migrations keep the partition count (PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  it('leaves 64 hash partitions on each log table after all migrations, and the migration table records every phase', async () => {
    for (const table of ['doc_commits', 'doc_commit_payloads']) {
      const r = await db.admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = $1::regclass',
        [table],
      );
      expect(r.rows[0]!.n, table).toBe(64);
    }
    const phases = await db.admin.query<{ version: string; phase: string | null }>(
      'SELECT version, phase FROM docedit_schema_migrations WHERE version = $1',
      ['0050_collaboration_tables'],
    );
    expect(phases.rows).toEqual([{ version: '0050_collaboration_tables', phase: 'expand' }]);
  });
});
