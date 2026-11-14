// The storage contract against PostgreSQL (BE-002, BE-017, BE-010, BE-026; PRM-002). Skips when
// the integration environment is not up (pwsh -NoProfile -File infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { GRANT_STORE_CHECKS, LOG_STORE_CHECKS, type StoreHarness } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('storage contract: PostgreSQL', () => {
  let db: TestDatabase;
  let harness: () => StoreHarness;

  beforeAll(async () => {
    db = await createTestDatabase();
    const { docs, logs, grants } = pgStores(db.service);
    const tenant = newTenant();
    harness = () => ({ tenant, otherTenant: newTenant(), docs, logs, grants });
  });
  afterAll(() => db?.drop());

  for (const c of [...LOG_STORE_CHECKS, ...GRANT_STORE_CHECKS]) it(c.name, () => c.run(harness()));
});
