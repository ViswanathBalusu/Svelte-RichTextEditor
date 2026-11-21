// The Queue contract (BE-002 criterion 4; 06 §14 `Queue`) against the job queue in PostgreSQL
// (migrations 0006 and 0041). Locks, delays and retries are judged by the database's clock, so the
// harness waits in real time. Skips when the integration environment is not up
// (pwsh -NoProfile -File infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { QUEUE_CHECKS, type QueueHarness } from '../contract/queue-checks.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('queue contract: PostgreSQL', () => {
  let db: TestDatabase;
  let harness: () => QueueHarness;

  beforeAll(async () => {
    db = await createTestDatabase();
    const queue = new PgJobQueue(db.service);
    // One database for every check: each check makes job kinds and tenants of its own.
    harness = () => ({
      queue,
      tenant: newTenant(),
      otherTenant: newTenant(),
      pass: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    });
  });
  afterAll(() => db?.drop());

  for (const c of QUEUE_CHECKS) it(c.name, () => c.run(harness()));
});
