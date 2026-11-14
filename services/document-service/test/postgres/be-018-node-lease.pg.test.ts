// BE-018 (lane U-BE-015-028), criteria 3 and 5 at the storage level: a document whose owner's node
// lease has expired in the database is claimed by another node with the next epoch, the first
// node's appends are then fenced, and a restarted node with a new identifier gets the dead node's
// document only once that lease has expired (PgLogStore.claimIfFree, migration 0033, 06 §2.1).
// Runs against PostgreSQL; skips when it is not up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/index.ts';
import { PgNodeLeases } from '../../src/data-plane/pg/leases.ts';
import { initialPermissions, stepCommit, write } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const CREATED_BY = 'U-BE-015-028';

describe.skipIf(unavailable !== null)('node lease fencing (PostgreSQL)', () => {
  let db: TestDatabase;
  let stores: ReturnType<typeof pgStores>;
  let leases: PgNodeLeases;
  const tenant = newTenant();

  beforeAll(async () => {
    db = await createTestDatabase();
    stores = pgStores(db.service);
    leases = new PgNodeLeases(db.service);
  });
  afterAll(() => db?.drop());

  async function newDoc(): Promise<DocRef> {
    const rec = await stores.docs.create(tenant, {
      cdmVersion: 1,
      requires: ['fields'],
      createdBy: CREATED_BY,
      permissions: initialPermissions(),
    });
    return { tenant, doc: rec.id };
  }

  it('a claim is refused while the owner lease is valid, then succeeds with the next epoch once it expired', async () => {
    const ref = await newDoc();
    await leases.renew('u-be-015-028-node-a', 60_000);
    const epochA = await stores.logs.claimIfFree(ref, 'u-be-015-028-node-a');
    expect(epochA).toBe(1);

    // Node B may not take a document whose owner still holds a valid lease.
    expect(await stores.logs.claimIfFree(ref, 'u-be-015-028-node-b')).toBeNull();

    // The lease expires by the database clock alone; node A's renewals have stopped.
    await db.admin.query(
      `UPDATE node_leases SET expires_at = now() - interval '1 second' WHERE node = $1`,
      ['u-be-015-028-node-a'],
    );
    const epochB = await stores.logs.claimIfFree(ref, 'u-be-015-028-node-b');
    expect(epochB).toBe(epochA! + 1);

    // Node A's appends fail: the write carries its old epoch and nothing is stored.
    expect(await stores.logs.append(ref, write(epochA!, [stepCommit(1)]))).toEqual({
      status: 'fenced',
    });
    expect(await stores.logs.read(ref)).toEqual([]);
    expect(await stores.logs.append(ref, write(epochB!, [stepCommit(1)]))).toEqual({
      status: 'ok',
    });
  });

  it('a restarted node with a new identifier gets the dead node documents only after its lease expired', async () => {
    const ref = await newDoc();
    const dead = 'u-be-015-028-dead-node';
    const restarted = 'u-be-015-028-restarted-node';
    await leases.renew(dead, 60_000);
    expect(await stores.logs.claimIfFree(ref, dead)).toBe(1);

    // The restarted process asks before the dead node's lease has run out: refused.
    expect(await stores.logs.claimIfFree(ref, restarted)).toBeNull();

    await db.admin.query(
      `UPDATE node_leases SET expires_at = now() - interval '1 second' WHERE node = $1`,
      [dead],
    );
    expect(await stores.logs.claimIfFree(ref, restarted)).toBe(2);
  });
});
