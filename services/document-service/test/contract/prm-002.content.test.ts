// PRM-002 criterion 3 in memory storage: the content of a document holds no permission data but
// a region's `policy`. The PostgreSQL run is test/postgres/prm-002.content.pg.test.ts.
import { describe, it } from 'vitest';
import { MemoryStore } from '../../src/index.ts';
import { newTenant } from '../support/env.ts';
import { checkContentHoldsOnlyPolicy } from './prm-002.content-checks.ts';

describe('PRM-002 criterion 3 in memory storage', () => {
  it('searching the stored content finds no permission data except a region policy', async () => {
    const store = new MemoryStore();
    await checkContentHoldsOnlyPolicy({
      tenant: newTenant(),
      otherTenant: newTenant(),
      docs: store,
      logs: store,
      grants: store,
    });
  });
});
