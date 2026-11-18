// BE-073 and BE-074 on PostgreSQL: the home regions of a tenant and of one of its documents
// (migration 0092), and the region and dedicated document a node writes on its lease row (0091).
// Skips when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eligibleHosts, Placement } from '../../src/control-plane/room-routing.ts';
import { PgNodeLeases } from '../../src/data-plane/pg/leases.ts';
import { PgHomeRegions } from '../../src/storage/home-regions.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('home regions and node traits (PostgreSQL)', () => {
  let db: TestDatabase;
  let regions: PgHomeRegions;
  let leases: PgNodeLeases;
  const tenant = newTenant();
  const other = newTenant();

  beforeAll(async () => {
    db = await createTestDatabase();
    regions = new PgHomeRegions(db.service);
    leases = new PgNodeLeases(db.service);
  });
  afterAll(() => db?.drop());

  it('stores the region of a tenant, and of a document, which wins for that document', async () => {
    const doc = randomUUID();
    const sibling = randomUUID();
    expect(await regions.resolve({ tenant, doc })).toBeNull();
    await regions.assign(tenant, 'eu-west', 'operator');
    expect(await regions.resolve({ tenant, doc })).toBe('eu-west');
    await regions.assign(tenant, 'us-east', 'operator', doc);
    expect(await regions.resolve({ tenant, doc })).toBe('us-east');
    expect(await regions.resolve({ tenant, doc: sibling })).toBe('eu-west');
    // An assignment is replaced, not added to.
    await regions.assign(tenant, 'eu-north', 'operator');
    expect(await regions.list(tenant)).toEqual([
      { doc: null, region: 'eu-north' },
      { doc, region: 'us-east' },
    ]);
    expect(await regions.clear(tenant, doc)).toBe(true);
    expect(await regions.clear(tenant, doc)).toBe(false);
    expect(await regions.resolve({ tenant, doc })).toBe('eu-north');
  });

  it('keeps the regions of one tenant from another (row-level security)', async () => {
    const doc = randomUUID();
    await regions.assign(tenant, 'eu-west', 'operator');
    expect(await regions.resolve({ tenant: other, doc })).toBeNull();
    expect(await regions.list(other)).toEqual([]);
    expect(await regions.clear(other)).toBe(false);
    expect(await regions.resolve({ tenant, doc })).toBe('eu-west');
  });

  it('refuses a region that is empty, too long or has control characters', async () => {
    await expect(regions.assign(tenant, '', 'operator')).rejects.toBeInstanceOf(RangeError);
    await expect(regions.assign(tenant, 'x'.repeat(101), 'operator')).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(regions.assign(tenant, 'eu\nwest', 'operator')).rejects.toBeInstanceOf(RangeError);
  });

  it('carries the region and the dedicated document of a node on its lease row, for routing', async () => {
    const hot = randomUUID();
    await leases.renew('n-eu', 60_000, 'wss://eu.example.test/dep', { region: 'eu-west' });
    await leases.renew('n-us', 60_000, 'wss://us.example.test/dep', { region: 'us-east' });
    await leases.renew('n-hot', 60_000, undefined, { region: 'eu-west', dedicated: hot });
    await leases.renew('n-plain', 60_000);
    const live = await leases.live();
    const by = (n: string) => live.find((x) => x.node === n);
    expect(by('n-eu')).toMatchObject({ region: 'eu-west', dedicated: null });
    expect(by('n-hot')).toMatchObject({ region: 'eu-west', dedicated: hot });
    expect(by('n-plain')).toMatchObject({ region: null, dedicated: null });

    // The hot document goes to its node; any other document of the region to a general node there.
    expect(eligibleHosts(hot, live, 'eu-west').map((n) => n.node)).toEqual(['n-hot']);
    const elsewhere = eligibleHosts(randomUUID(), live, 'eu-west').map((n) => n.node);
    expect(elsewhere).toEqual(['n-eu']);
    expect((await new Placement(leases).route(randomUUID(), 'us-east'))?.node).toBe('n-us');
    expect(await new Placement(leases).route(randomUUID(), 'ap-south')).toBeNull();

    // A renewal without traits clears them: the row says what the node says now.
    await leases.renew('n-hot', 60_000);
    expect((await leases.live()).find((x) => x.node === 'n-hot')).toMatchObject({
      region: null,
      dedicated: null,
    });
  });
});
