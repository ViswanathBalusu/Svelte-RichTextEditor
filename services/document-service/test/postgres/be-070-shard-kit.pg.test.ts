// BE-070 criterion 4 (the conformance half): the service runs over two PostgreSQL shards and the
// conformance kit passes against it. Two databases of the test cluster stand for the shards (as in
// be-070-shards.pg.test.ts), so routing is tested and a second primary is not. The service runs in
// this process with `shardedPgParts`; the kit is given only the discovery URL and a credential, as
// an operator's run is. The kit's tenant is on the second shard and a second tenant is on the
// first, so a query that went to a default shard would find nothing, or the wrong rows.
//
// Not covered: the fault tests of BE-080, which are not built. Skips when PostgreSQL is not up.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { ShardMap } from '../../src/control-plane/jobs/sharding.ts';
import { startService, type Service } from '../../src/server.ts';
import { shardedPgParts } from '../../src/sharded-parts.ts';
import { runKit } from '../../../../packages/tck/src/runner.ts';
import type { KitReport } from '../../../../packages/tck/src/report.ts';
import { judge } from '../../../../packages/tck/test/targets/judge.ts';
import { KIT_ORIGIN } from '../../../../packages/tck/test/targets/reference.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

/**
 * The defects the kit reports against the reference service on one store, in memory or on
 * PostgreSQL (packages/tck/test/reference.test.ts, REFERENCE_KNOWN). They do not depend on the
 * shard: the same two scenarios fail on a service with one database or none. Sharding adds none.
 */
const KNOWN: Readonly<Record<string, string>> = {
  'perm-suggest.suggestion-accepted': 'the suggester identity mismatch of the reference service',
  'perm-suggest.suggestion-accept-reject': 'the same identity mismatch',
};

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** The rows a tenant has, per table, in every table of a database that carries `tenant_id`. */
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

describe.skipIf(unavailable !== null)(
  'the conformance kit against a service on two PostgreSQL shards (BE-070 criterion 4)',
  () => {
    const kitTenant = randomUUID();
    const other = newTenant();
    const keyId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    let a: TestDatabase;
    let b: TestDatabase;
    let service: Service | null = null;
    let report: KitReport | null = null;

    beforeAll(async () => {
      a = await createTestDatabase();
      b = await createTestDatabase();
      const map = new ShardMap(['a', 'b'], { [other]: 'a', [kitTenant]: 'b' });
      const parts = shardedPgParts(map, { a: a.service, b: b.service });
      const dir = mkdtempSync(join(tmpdir(), 'docedit-be-070-'));
      const seedFile = join(dir, 'tenants.json');
      writeFileSync(
        seedFile,
        JSON.stringify({
          tenants: [
            {
              id: kitTenant,
              name: 'BE-070 sharded kit run',
              apiKeys: [
                {
                  id: keyId,
                  secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
                  label: 'be-070',
                },
              ],
              origins: [KIT_ORIGIN],
            },
          ],
        }),
      );
      service = await startService({
        config: configFromEnv({
          DOCEDIT_LISTEN_HOST: '127.0.0.1',
          DOCEDIT_LISTEN_PORT: '0',
          DOCEDIT_TENANTS_FILE: seedFile,
          DOCEDIT_WORKERS: '1',
          DOCEDIT_NODE_ID: `be-070-${process.pid}`,
        }),
        parts,
      });
      report = await runKit({
        discovery: `${service.url}/.well-known/dep`,
        credential: `dsk_${kitTenant}_${keyId}_${secret}`,
        origin: KIT_ORIGIN,
        testMode: false,
        fuzz: { budgetMs: 4000 },
        property: { runs: 8 },
      });
    }, 900_000);

    afterAll(async () => {
      await service?.close();
      await a?.drop();
      await b?.drop();
    });

    it('bootstraps from the discovery URL and the credential alone', () => {
      expect(report!.bootstrap).toEqual({ ok: true });
    });

    it('fails only with the known defects of the reference service, which one database has too', () => {
      const v = judge(report!, KNOWN);
      expect(v.unexpected).toEqual([]);
      const scenarios = report!.profiles.flatMap((p) => p.scenarios);
      expect(scenarios.filter((s) => s.outcome === 'passed').length).toBeGreaterThan(50);
    });
    it('stored the kit tenant on its shard and nothing on the other', async () => {
      const onB = await rowsOf(b.admin, kitTenant);
      const onA = await rowsOf(a.admin, kitTenant);
      expect(Object.keys(onB), 'the kit left documents and commits on its shard').toEqual(
        expect.arrayContaining(['documents', 'doc_commits']),
      );
      expect(onA).toEqual({});
      expect(await rowsOf(a.admin, other)).toEqual({});
      expect(await rowsOf(b.admin, other)).toEqual({});
    });
  },
);
