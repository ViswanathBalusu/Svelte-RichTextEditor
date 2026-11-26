// BE-052 criterion 2 for the renewal of time-stamps (FRW-056), on PostgreSQL: the scheduled scan
// lists the chains that expire within the lead time through `PgRenewalStore.listDue` (row-level
// security on, so a tenant sees its own chains), and enqueues one `workflow.renewal` job for each
// expiry in the `PgJobQueue`, once however often the scan runs. Skips when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import {
  RENEWAL_KIND,
  renewalJobId,
  renewalScheduleTask,
} from '../../src/control-plane/jobs/workflow-renewal.ts';
import { PgRenewalStore } from '../../src/workflow/renewal-state-pg.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const why = await postgresUnavailable();

describe.skipIf(why)('the renewal scan on PostgreSQL (BE-052, FRW-056)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('lists the due chains of one tenant, soonest first, and bounds the window', async () => {
    const store = new PgRenewalStore(db.service);
    const t1 = randomUUID();
    const t2 = randomUUID();
    const [a, b, c, d, e] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await store.start(t1, a, NOW + 5 * DAY);
    await store.start(t1, b, NOW + 2 * DAY);
    await store.start(t1, c, NOW + 20 * DAY);
    await store.start(t1, d, NOW - DAY);
    await store.start(t2, e, NOW + DAY);
    expect(await store.listDue(t1, NOW, NOW + 7 * DAY, 10)).toEqual([
      { doc: b, expiresAtMs: NOW + 2 * DAY },
      { doc: a, expiresAtMs: NOW + 5 * DAY },
    ]);
    expect(await store.listDue(t1, NOW, NOW + 7 * DAY, 1)).toEqual([
      { doc: b, expiresAtMs: NOW + 2 * DAY },
    ]);
  });

  it('enqueues one job for each expiry, however often the scan runs', async () => {
    const store = new PgRenewalStore(db.service);
    const queue = new PgJobQueue(db.service);
    const tenant = randomUUID();
    const doc = randomUUID();
    await store.start(tenant, doc, NOW + 3 * DAY);
    const task = renewalScheduleTask({ source: store, queue, leadMs: 7 * DAY });
    const scope = { held: new Set<string>() };
    await task.forTenant!(tenant, NOW, scope);
    await task.forTenant!(tenant, NOW + 3600_000, scope);
    const job = await queue.get(tenant, renewalJobId(doc, NOW + 3 * DAY));
    expect(job).toMatchObject({ kind: RENEWAL_KIND, doc, payload: { expiry: NOW + 3 * DAY } });
  });
});
