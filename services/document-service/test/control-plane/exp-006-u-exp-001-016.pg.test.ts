// EXP-006 criterion 5 on PostgreSQL, lane U-EXP-001-016: a cached export result is never returned to
// another tenant, even when both tenants have the same bundle hash and the same cache key. The
// in-memory version is in export-jobs.test.ts; this file runs the same rule against the real queue
// (PgJobQueue.findCompleted, which filters by tenant in SQL and runs inside the tenant's row-level
// security context). Each run gets a database of its own. It skips when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const databases: TestDatabase[] = [];
const why = await postgresUnavailable();

describe.skipIf(why)('EXP-006 criterion 5 on PostgreSQL (U-EXP-001-016)', () => {
  afterAll(async () => {
    for (const db of databases) await db.drop();
  });

  it('never returns a cached result to another tenant with the same cache key (EXP-006 criterion 5)', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const q = new PgJobQueue(db.service);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const cacheKey = 'ab'.repeat(32);

    const done = await q.enqueue(tenantA, {
      kind: 'export',
      doc: randomUUID(),
      createdBy: 'someone',
      payload: {},
      cacheKey,
      completedWith: { output: 'output.pdf' },
    });

    const hit = await q.findCompleted(tenantA, cacheKey, 0);
    expect(hit?.id).toBe(done.id);
    expect(await q.findCompleted(tenantB, cacheKey, 0)).toBeNull();
    // A third tenant that has never existed in the table sees nothing either.
    expect(await q.findCompleted(randomUUID(), cacheKey, 0)).toBeNull();
  });

  it('does not return a result of another tenant when a same-key job of this tenant is only queued (EXP-006 criterion 5)', async () => {
    const db = await createTestDatabase();
    databases.push(db);
    const q = new PgJobQueue(db.service);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const cacheKey = 'cd'.repeat(32);

    await q.enqueue(tenantA, {
      kind: 'export',
      doc: randomUUID(),
      createdBy: 'someone',
      payload: {},
      cacheKey,
      completedWith: { output: 'output-a.pdf' },
    });
    // Tenant B queues its own job with the same key; it is not completed, so it is not a cache hit.
    await q.enqueue(tenantB, {
      kind: 'export',
      doc: randomUUID(),
      createdBy: 'someone',
      payload: {},
      cacheKey,
    });

    expect(await q.findCompleted(tenantB, cacheKey, 0)).toBeNull();
    const seenByA = await q.findCompleted(tenantA, cacheKey, 0);
    expect(seenByA).not.toBeNull();
    expect(seenByA?.tenant).toBe(tenantA);
  });
});
