// PRM-002 criterion 3 in PostgreSQL (07 §3): the stored content of a document holds no permission
// data but a region's `policy`. Skipped when PostgreSQL is not running (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { checkContentHoldsOnlyPolicy } from '../contract/prm-002.content-checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('PRM-002 criterion 3 in PostgreSQL', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  it('searching the stored content finds no permission data except a region policy', async () => {
    const s = pgStores(db.service);
    await checkContentHoldsOnlyPolicy({
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: s.docs,
      logs: s.logs,
      grants: s.grants,
    });
  });
});
