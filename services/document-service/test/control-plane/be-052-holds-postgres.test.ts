// Scheduled maintenance and legal holds (BE-052 criterion 4), run through the scheduler. A task that
// deletes (the abandoned-upload sweep of BE-046) runs once per tenant under that tenant's context
// (row-level security is on, so a tenant whose context was not set would see no row), and the
// scheduler gives it the documents a legal hold covers, which it keeps. Against PostgreSQL, with
// the job queue, the asset registry and the hold store of the test environment and an in-memory
// object store. Skips, with the reason, when PostgreSQL is not up (infra/test-env.ps1 up).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAssetRegistry } from '../../src/control-plane/assets-pg.ts';
import { abandonedUploadsTask } from '../../src/control-plane/asset-sweep.ts';
import { HoldService, type HoldServiceDeps } from '../../src/control-plane/holds.ts';
import { PgHoldStore } from '../../src/control-plane/holds-pg.ts';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { JobRunner } from '../../src/control-plane/jobs/runner.ts';
import { SCHEDULE_KIND, Scheduler } from '../../src/control-plane/scheduler.ts';
import { MemoryObjectStore } from '../../src/objects/store.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const why = await postgresUnavailable();
if (why) console.warn(`be-052-holds-postgres: skipped: ${why}`);

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe.skipIf(why !== null)('scheduled tasks honour legal holds (BE-052 criterion 4)', () => {
  const now = Date.now();
  const old = now - 10 * DAY;
  let db: TestDatabase;
  let assets: PgAssetRegistry;
  let store: PgHoldStore;
  let holds: HoldService;
  let queue: PgJobQueue;

  beforeAll(async () => {
    db = await createTestDatabase();
    assets = new PgAssetRegistry(db.service);
    store = new PgHoldStore(db.service);
    queue = new PgJobQueue(db.service);
    holds = new HoldService({
      store,
      audit: { record: async () => [] } as unknown as HoldServiceDeps['audit'],
      documentExists: async () => true,
      now: () => now,
    });
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function expiredUpload(tenant: string, doc: string): Promise<string> {
    const id = randomUUID();
    await assets.create(
      tenant,
      {
        id,
        doc,
        filename: 'late.png',
        mime: 'image/png',
        declaredBytes: 4,
        createdBy: 'be-052',
        uploadExpiresAt: old,
      },
      old - DAY,
    );
    return id;
  }

  /** Runs the one slot of the sweep, as the scheduler's job, for the tenants given. */
  let slots = 0;
  async function runSlot(tenants: readonly string[], withHolds: boolean): Promise<void> {
    // Each call is a new slot: a slot's job is queued once (BE-052 criterion 1).
    const at = now + ++slots * 2 * HOUR;
    const task = abandonedUploadsTask({
      assets,
      objects: new MemoryObjectStore(),
      batch: 500,
    });
    const scheduler = new Scheduler({
      queue,
      tasks: [task],
      tenants: async () => tenants,
      ...(withHolds ? { heldDocuments: (t: string) => holds.heldDocuments(t) } : {}),
      now: () => at,
    });
    await scheduler.ensure();
    const runner = new JobRunner({
      queue,
      handlers: { [SCHEDULE_KIND]: scheduler.handler },
      worker: `be-052-${randomUUID()}`,
      leaseMs: 60_000,
      idleMs: 1,
      retryAfterMs: 1,
      now: () => at,
    });
    for (let i = 0; i < 3; i++) await runner.runOnce();
  }

  it("runs the sweep under each listed tenant's context and keeps a held document's upload", async () => {
    const a = newTenant();
    const b = newTenant();
    const heldDoc = randomUUID();
    await store.add({
      id: randomUUID(),
      tenant: a,
      document: heldDoc,
      reason: 'legal hold for BE-052 criterion 4',
      placedBy: 'be-052',
      placedAt: now - DAY,
    });
    const keptA = await expiredUpload(a, heldDoc);
    const goneA = await expiredUpload(a, randomUUID());
    const goneB = await expiredUpload(b, heldDoc); // another tenant's hold does not cover it

    // Only tenant a is listed: its rows are reached, tenant b's are not.
    await runSlot([a], true);
    expect(await assets.get(a, keptA)).not.toBeNull();
    expect(await assets.get(a, goneA)).toBeNull();
    expect(await assets.get(b, goneB)).not.toBeNull();
  });

  it('reaches every listed tenant, and a hold of one tenant keeps nothing of another', async () => {
    const a = newTenant();
    const b = newTenant();
    const doc = randomUUID();
    await store.add({
      id: randomUUID(),
      tenant: a,
      document: doc,
      reason: 'legal hold for BE-052 criterion 4',
      placedBy: 'be-052',
      placedAt: now - DAY,
    });
    const keptA = await expiredUpload(a, doc);
    const goneB = await expiredUpload(b, doc);

    await runSlot([a, b], true);
    expect(await assets.get(a, keptA)).not.toBeNull();
    expect(await assets.get(b, goneB)).toBeNull();
  });

  it("removes a held document's upload when the scheduler has no hold source (the contrast)", async () => {
    const t = newTenant();
    const doc = randomUUID();
    await store.add({
      id: randomUUID(),
      tenant: t,
      document: doc,
      reason: 'legal hold for BE-052 criterion 4',
      placedBy: 'be-052',
      placedAt: now - DAY,
    });
    const id = await expiredUpload(t, doc);
    await runSlot([t], false);
    expect(await assets.get(t, id)).toBeNull();
  });
});
