/**
 * SEC-056 criteria 2 and 4 against PostgreSQL (10 §4; 08 §13; BE-013). Lane U-SEC-049-064.
 *
 * The in-memory directory is covered by surrogates-erasure.test.ts. This file runs the same
 * erasure rules through PgUserDirectory, the storage the control plane uses in production, in a
 * database of its own (createTestDatabase names it docedit_sec_<random>; it is dropped afterwards).
 * Each test uses fresh random tenant identifiers. The PostgreSQL cases skip when the shared
 * container is not reachable, with the reason, as the other PostgreSQL cases do.
 *
 * Run: pnpm vitest run tests/security/test/sec-056-surrogates-erasure-postgres.test.ts
 * (with infra/test-env.ps1 up -NoExport). Criterion 1 (the sub in no other table) and the
 * history rendering stay open; see the story's Notes.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgUserDirectory } from '../../../services/document-service/src/control-plane/users.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from './support/harness.ts';

const skip = await postgresUnavailable(); // probed at collection, as the other PostgreSQL cases

describe.skipIf(skip !== null)('SEC-056 PostgreSQL directory (U-SEC-049-064)', () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let users: PgUserDirectory;

  beforeAll(async () => {
    if (skip) return;
    db = await createTestDatabase();
    pool = new pg.Pool({ connectionString: db.url, max: 2 });
    pool.on('error', () => {});
    users = new PgUserDirectory(pool);
  });

  afterAll(async () => {
    if (skip) return;
    await pool?.end().catch(() => {});
    await db?.drop();
  });

  /** A tenant row, inserted by the admin role (tenant_users references tenants). */
  async function tenant(): Promise<string> {
    const id = randomUUID();
    await db.admin.query(
      'INSERT INTO tenants (id, tenant_id, name, created_at) VALUES ($1, $1, $2, now())',
      [id, 'U-SEC-049-064 tenant'],
    );
    return id;
  }

  it('criterion 2: after erasure the name is gone and the surrogate leads to no sub', async () => {
    const t = await tenant();
    const sub = `ann.lee+${randomUUID()}@example.test`;
    const before = await users.resolve(t, sub, 'Ann Lee');
    expect(await users.displayName(t, sub)).toBe('Ann Lee');
    expect((await users.subsOf(t, [before.surrogate])).get(before.surrogate)).toBe(sub);

    expect(await users.erase(t, sub)).toBe(true);

    expect(await users.displayName(t, sub)).toBeNull();
    expect((await users.subsOf(t, [before.surrogate])).has(before.surrogate)).toBe(false);
    expect(await users.erase(t, sub)).toBe(false);
  });

  it('criterion 4: erasing a sub in one tenant leaves the same sub in another tenant untouched', async () => {
    const a = await tenant();
    const b = await tenant();
    const sub = `shared-sub-${randomUUID()}`;
    const inA = await users.resolve(a, sub, 'Ann in A');
    const inB = await users.resolve(b, sub, 'Ann in B');
    expect(inB.surrogate).not.toBe(inA.surrogate);

    expect(await users.erase(a, sub)).toBe(true);

    expect(await users.displayName(a, sub)).toBeNull();
    expect(await users.displayName(b, sub)).toBe('Ann in B');
    expect((await users.subsOf(b, [inB.surrogate])).get(inB.surrogate)).toBe(sub);
    expect((await users.resolve(b, sub)).surrogate).toBe(inB.surrogate);
  });

  it('criterion 4: the other tenant cannot see the erased tenant mapping through its surrogate', async () => {
    const a = await tenant();
    const b = await tenant();
    const sub = `cross-${randomUUID()}`;
    const inA = await users.resolve(a, sub, 'Cross A');
    await users.resolve(b, sub, 'Cross B');
    // Row-level security: tenant B asking for tenant A's surrogate gets nothing back, before and after A's erasure.
    expect((await users.subsOf(b, [inA.surrogate])).size).toBe(0);
    await users.erase(a, sub);
    expect((await users.subsOf(b, [inA.surrogate])).size).toBe(0);
  });
});
