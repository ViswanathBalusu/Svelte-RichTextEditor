// BE-070: tenants spread over several PostgreSQL shards. Two databases of the test cluster stand
// for two shards. They are separate databases with their own schema, pools and roles, so a query
// on one cannot see the other's rows; they are not separate servers, so nothing here measures a
// second primary's insert rate. Skips when PostgreSQL is not up.
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CrossShardError,
  ShardMap,
  UnknownTenantShard,
} from '../../src/control-plane/jobs/sharding.ts';
import { uuid7 } from '@docedit/model';
import { shardedPgParts } from '../../src/sharded-parts.ts';
import {
  migrateShards,
  shardCompatibility,
  ShardMigrationError,
} from '../../src/storage/shards.ts';
import {
  loadMigrations,
  MIGRATIONS_DIR,
  migrate,
  schemaVersion,
} from '../../src/storage/migrate.ts';
import type { AuditEvent, DocRef, LogStore, OwnershipStore } from '../../src/index.ts';
import {
  GRANT_STORE_CHECKS,
  LOG_STORE_CHECKS,
  initialPermissions,
  stepCommit,
  write,
} from '../contract/checks.ts';
import {
  ADMIN,
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** The rows a tenant has in every table of a database that carries `tenant_id`. */
async function rowsOf(pool: pg.Pool, tenant: string): Promise<Record<string, number>> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`,
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM "${table_name}" WHERE tenant_id::text = $1`,
      [tenant],
    );
    const n = Number(r.rows[0]?.n ?? 0);
    if (n > 0) out[table_name] = n;
  }
  return out;
}

/** Counts the connections a pool hands out, so a test can tell which shard a call used. */
function countConnects(pool: pg.Pool): { count(): number } {
  let n = 0;
  const connect = pool.connect.bind(pool) as (...a: unknown[]) => unknown;
  (pool as unknown as { connect: (...a: unknown[]) => unknown }).connect = (...a: unknown[]) => {
    n += 1;
    return connect(...a);
  };
  return { count: () => n };
}

describe.skipIf(unavailable !== null)('tenants spread over shards (PostgreSQL)', () => {
  let a: TestDatabase;
  let b: TestDatabase;
  const tenantA = newTenant();
  const tenantB = newTenant();
  const stranger = newTenant();
  let map: ShardMap;
  let parts: ReturnType<typeof shardedPgParts>;
  let connectsA: { count(): number };
  let connectsB: { count(): number };

  beforeAll(async () => {
    a = await createTestDatabase();
    b = await createTestDatabase();
    map = new ShardMap(['a', 'b'], { [tenantA]: 'a', [tenantB]: 'b' });
    connectsA = countConnects(a.service);
    connectsB = countConnects(b.service);
    parts = shardedPgParts(map, { a: a.service, b: b.service });
  });
  afterAll(async () => {
    await a?.drop();
    await b?.drop();
  });

  async function newDoc(tenant: string): Promise<DocRef> {
    const rec = await parts.documents.create(tenant, {
      cdmVersion: 1,
      requires: ['fields'],
      createdBy: 'BE-070',
      permissions: initialPermissions(),
    });
    return { tenant, doc: rec.id };
  }

  it('sends each request and job of a tenant to its own shard and stores nothing on the other', async () => {
    const refA = await newDoc(tenantA);
    await newDoc(tenantB);
    const job = { kind: 'be-070', payload: {}, createdBy: 'BE-070' };
    const jobA = await parts.queue.enqueue(tenantA, job);
    await parts.queue.enqueue(tenantB, job);
    await parts.audit!.record([
      {
        id: uuid7(),
        tenant: tenantA,
        doc: refA.doc,
        actor: 'system',
        kind: 'be-070',
        data: {},
        at: Date.now(),
      },
    ]);

    const onA = await rowsOf(a.admin, tenantA);
    const onB = await rowsOf(b.admin, tenantB);
    expect(Object.keys(onA)).toEqual(expect.arrayContaining(['documents', 'doc_heads']));
    expect(Object.keys(onB)).toEqual(expect.arrayContaining(['documents', 'doc_heads']));
    // The other shard holds nothing of the tenant: not a document, not a job, not an audit event.
    expect(await rowsOf(b.admin, tenantA)).toEqual({});
    expect(await rowsOf(a.admin, tenantB)).toEqual({});

    // Reads come back from the right shard, and a read of the other tenant's document finds none.
    expect((await parts.documents.get(refA))?.id).toBe(refA.doc);
    expect(await parts.documents.get({ tenant: tenantB, doc: refA.doc })).toBeNull();
    expect((await parts.queue.get(tenantA, jobA.id))?.id).toBe(jobA.id);
    expect(await parts.queue.get(tenantB, jobA.id)).toBeNull();
    expect(await parts.audit!.query(tenantA, { limit: 10 })).toHaveLength(1);
    expect(await parts.audit!.query(tenantB, { limit: 10 })).toHaveLength(0);
  });

  it('refuses a tenant the map does not know before any shard is touched', async () => {
    const before = connectsA.count() + connectsB.count();
    await expect(parts.documents.list(stranger, { limit: 5 } as never)).rejects.toBeInstanceOf(
      UnknownTenantShard,
    );
    await expect(
      parts.logs.head({ tenant: stranger, doc: randomBytes(4).toString('hex') }),
    ).rejects.toBeInstanceOf(UnknownTenantShard);
    await expect(
      parts.queue.enqueue(stranger, { kind: 'be-070', payload: {}, createdBy: 'BE-070' }),
    ).rejects.toBeInstanceOf(UnknownTenantShard);
    expect(connectsA.count() + connectsB.count()).toBe(before);
  });

  it('runs a commit on one shard only, and refuses a call that names tenants of two shards', async () => {
    const ref = await newDoc(tenantA);
    const epoch = await parts.ownership.claim(ref, 'node-be-070');
    const beforeA = connectsA.count();
    const beforeB = connectsB.count();
    expect(await parts.logs.append(ref, write(epoch, [stepCommit(1)]))).toEqual({ status: 'ok' });
    expect(connectsA.count()).toBeGreaterThan(beforeA);
    expect(connectsB.count()).toBe(beforeB);
    expect(await rowsOf(b.admin, tenantA)).toEqual({});

    const event = (tenant: string): AuditEvent => ({
      id: uuid7(),
      tenant,
      doc: null,
      actor: 'system',
      kind: 'be-070.span',
      data: {},
      at: Date.now(),
    });
    const afterA = connectsA.count();
    const afterB = connectsB.count();
    await expect(parts.audit!.record([event(tenantA), event(tenantB)])).rejects.toBeInstanceOf(
      CrossShardError,
    );
    // Refused before either shard was asked, so neither event was written.
    expect(connectsA.count()).toBe(afterA);
    expect(connectsB.count()).toBe(afterB);
    expect(await parts.audit!.query(tenantA, { kind: 'be-070.span', limit: 5 })).toEqual([]);
  });

  it('keeps a node lease on every shard, so each shard judges the owner by its own table', async () => {
    const node = `node-${randomBytes(3).toString('hex')}`;
    await parts.leases!.renew(node, 60_000);
    for (const db of [a, b]) {
      const r = await db.admin.query('SELECT 1 FROM node_leases WHERE node = $1', [node]);
      expect(r.rowCount).toBe(1);
    }
    expect(await parts.leases!.alive(node)).toBe(true);
    const ref = await newDoc(tenantB);
    expect(await parts.ownership.claimIfFree!(ref, node)).toBe(1);
    await parts.leases!.release(node);
    expect(await parts.leases!.alive(node)).toBe(false);
  });

  it('is ready only when every shard is ready', async () => {
    expect(await parts.readiness!()).toMatchObject({ ready: true });
    const last = await b.admin.query(
      'DELETE FROM docedit_schema_migrations WHERE version = (SELECT max(version) FROM docedit_schema_migrations) RETURNING version, checksum, phase',
    );
    const r = await parts.readiness!();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/^shard b: /);
    const row = last.rows[0] as { version: string; checksum: string; phase: string };
    await b.admin.query(
      'INSERT INTO docedit_schema_migrations (version, checksum, phase) VALUES ($1, $2, $3)',
      [row.version, row.checksum, row.phase],
    );
    expect(await parts.readiness!()).toMatchObject({ ready: true });
  });

  describe('the conformance kit over the shards', () => {
    // The tenant of the kit is on shard a and its other tenant on shard b, so the checks that
    // look for leaks between tenants also look across shards.
    const harness = () => ({
      tenant: tenantA,
      otherTenant: tenantB,
      docs: parts.documents,
      logs: parts.logs as LogStore & OwnershipStore,
      grants: parts.grants,
    });
    for (const c of [...LOG_STORE_CHECKS, ...GRANT_STORE_CHECKS])
      it(c.name, () => c.run(harness()));
  });
});

describe.skipIf(unavailable !== null)('migrating every shard (PostgreSQL)', () => {
  const names: string[] = [];
  const pools: pg.Pool[] = [];
  let tmp = '';

  async function emptyShard(upTo: number | null): Promise<pg.Pool> {
    const name = `docedit_t_${randomBytes(6).toString('hex')}`;
    const root = new pg.Client(ADMIN);
    await root.connect();
    try {
      await root.query(`CREATE DATABASE ${name}`);
    } finally {
      await root.end();
    }
    names.push(name);
    const pool = new pg.Pool({ ...ADMIN, database: name, max: 2 });
    pool.on('error', () => {});
    pools.push(pool);
    if (upTo !== null) {
      const first = (await loadMigrations()).slice(0, upTo).map((m) => m.version);
      const c = await pool.connect();
      try {
        await migrate(c, MIGRATIONS_DIR, { only: new Set(first) });
      } finally {
        c.release();
      }
    }
    return pool;
  }

  beforeAll(async () => {
    // Roles are cluster-wide; a test database creates them.
    const seed = await createTestDatabase();
    await seed.drop();
  });
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const root = new pg.Client(ADMIN);
    await root.connect();
    try {
      for (const n of names) await root.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
    } finally {
      await root.end();
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('brings every shard to the same schema, one after the other, with the same rules', async () => {
    const behind = await emptyShard(5);
    const empty = await emptyShard(null);
    const map = new ShardMap(['behind', 'empty'], {});
    const known = (await loadMigrations()).map((m) => m.version);

    const before = await shardCompatibility(map, { behind, empty });
    expect(before.map((s) => s.ok)).toEqual([false, false]);
    expect(before[0]!.pending).toEqual(known.slice(5));
    expect(before[1]!.pending).toEqual(known);

    const applied = await migrateShards(map, { behind, empty });
    expect(applied['behind']).toEqual(known.slice(5));
    expect(applied['empty']).toEqual(known);

    const after = await shardCompatibility(map, { behind, empty });
    expect(after.every((s) => s.ok)).toBe(true);
    expect(await schemaVersion(behind)).toBe(known.at(-1));
    expect(await schemaVersion(empty)).toBe(known.at(-1));

    // A second rollout changes nothing.
    expect(await migrateShards(map, { behind, empty })).toEqual({ behind: [], empty: [] });
  });

  it('stops at the shard that fails and leaves the shards after it untouched', async () => {
    const first = await emptyShard(null);
    const second = await emptyShard(null);
    const third = await emptyShard(null);
    // The second shard already has a migration applied that the rollout's files then change.
    tmp = await mkdtemp(join(tmpdir(), 'be-070-'));
    await cp(MIGRATIONS_DIR, tmp, { recursive: true });
    const files = (await readdir(tmp)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    const c = await second.connect();
    try {
      await migrate(c, MIGRATIONS_DIR, { only: new Set([files[0]!.slice(0, -4)]) });
    } finally {
      c.release();
    }
    await writeFile(
      join(tmp, files[0]!),
      `${await readFile(join(tmp, files[0]!), 'utf8')}\n-- edited\n`,
    );

    const map = new ShardMap(['one', 'two', 'three'], {});
    const error = await migrateShards(map, { one: first, two: second, three: third }, tmp).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ShardMigrationError);
    expect((error as ShardMigrationError).shard).toBe('two');
    expect((error as ShardMigrationError).done).toEqual(['one']);
    expect(await schemaVersion(third)).toBeNull();
  });
});
