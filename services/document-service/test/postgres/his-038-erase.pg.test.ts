// HIS-038 criterion 1 (lane V-HIS-033-046): erasing a person deletes their one mapping row, their
// display name and their read markers, and nothing in the document or its log changes. Runs against
// the PostgreSQL of the test environment (infra/test-env.ps1 up); skips when it is not up. The
// database is made for this file and dropped afterwards.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgTenantRegistry } from '../../src/control-plane/tenants.ts';
import { PgUserDirectory } from '../../src/control-plane/users.ts';
import { inTenant } from '../../src/storage/db.ts';
import { PgReadMarkerStore } from '../../src/storage/read-markers.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

const CREATED_BY = 'V-HIS-033-046';

describe.skipIf(skip !== null)('erasing a person (HIS-038 criterion 1, PostgreSQL)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** Reads the rows of one tenant as the service role does (row-level security applies). */
  function read<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    return inTenant(db.service, tenant, fn, { readOnly: true });
  }

  it('deletes the mapping row, the display name and the read markers of the person only', async () => {
    const tenant = randomUUID();
    await new PgTenantRegistry(db.service).putTenant(tenant, 'V-HIS-033-046 erase');
    const users = new PgUserDirectory(db.service);
    const alice = await users.resolve(tenant, 'V-sub-alice', 'Alice Example');
    const bob = await users.resolve(tenant, 'V-sub-bob', 'Bob Example');

    const doc = randomUUID();
    await inTenant(db.service, tenant, async (c) => {
      await c.query(
        `INSERT INTO documents (id, tenant_id, cdm_version, created_by, created_at)
         VALUES ($1, $2, 1, $3, now())`,
        [doc, tenant, CREATED_BY],
      );
    });

    const markers = new PgReadMarkerStore(db.service);
    const ref = { tenant, doc };
    await markers.advance(ref, alice.surrogate, 4, Date.now());
    await markers.advance(ref, bob.surrogate, 7, Date.now());
    expect(await markers.get(ref, alice.surrogate)).toBe(4);

    // Before the erasure: the person's name is known.
    expect(await users.displayName(tenant, 'V-sub-alice')).toBe('Alice Example');

    expect(await users.erase(tenant, 'V-sub-alice')).toBe(true);
    // A second erasure of the same person finds nothing to delete.
    expect(await users.erase(tenant, 'V-sub-alice')).toBe(false);

    // The mapping row and its display name are gone.
    expect(await users.displayName(tenant, 'V-sub-alice')).toBeNull();
    const mapped = await read(tenant, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*) AS n FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
        [tenant, 'V-sub-alice'],
      );
      return Number(r.rows[0]!.n);
    });
    expect(mapped).toBe(0);

    // Their read marker is gone; the other person's marker and the document are untouched.
    expect(await markers.get(ref, alice.surrogate)).toBeUndefined();
    expect(await markers.get(ref, bob.surrogate)).toBe(7);
    const docs = await read(tenant, async (c) => {
      const r = await c.query<{ n: string }>(
        'SELECT count(*) AS n FROM documents WHERE tenant_id = $1',
        [tenant],
      );
      return Number(r.rows[0]!.n);
    });
    expect(docs).toBe(1);

    // The other person keeps their mapping and name.
    expect(await users.displayName(tenant, 'V-sub-bob')).toBe('Bob Example');
  });
});
