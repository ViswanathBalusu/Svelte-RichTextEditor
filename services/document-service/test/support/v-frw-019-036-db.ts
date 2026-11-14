/**
 * A PostgreSQL database for one test file of lane V-FRW-019-036, named with the lane. It is made by
 * the admin role, migrated, and used through the service role, as `test/postgres/frw-043.purge.pg.test.ts`
 * does. The caller drops it in `afterAll`. Skipped by the caller when PostgreSQL is not up.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createPool, ensureServiceRole, migrate } from '../../src/index.ts';
import { ADMIN, SERVICE_USER, settings } from './env.ts';

export interface LaneDatabase {
  readonly service: pg.Pool;
  drop(): Promise<void>;
}

export async function createLaneDatabase(): Promise<LaneDatabase> {
  const name = `docedit_t_v_frw_019_036_${randomBytes(4).toString('hex')}`;
  const password = settings().DOCEDIT_PG_SERVICE_PASSWORD ?? '';
  const root = new pg.Client(ADMIN);
  await root.connect();
  try {
    await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
    try {
      await ensureServiceRole(root, SERVICE_USER, password);
    } finally {
      await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
    }
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  const admin = new pg.Pool({ ...ADMIN, database: name, max: 4 });
  admin.on('error', () => {});
  const c = await admin.connect();
  try {
    await migrate(c);
  } finally {
    c.release();
  }
  await admin.end().catch(() => {});
  const service = createPool({
    host: ADMIN.host,
    port: ADMIN.port,
    user: SERVICE_USER,
    password,
    database: name,
    max: 6,
  });
  return {
    service,
    async drop() {
      await service.end().catch(() => {});
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    },
  };
}
