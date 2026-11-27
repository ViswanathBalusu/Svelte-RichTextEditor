/**
 * PRO-115 criterion 1, every row of the matrix of 07 §12. The `authz` profile of the conformance
 * kit runs against the document service on PostgreSQL and the S3-compatible store of the
 * integration environment, with the export worker's job handler in the same process (so that
 * `exports` is announced and row 12 is called) and with the features of the rows that need one
 * (`comments`, `history`, `leases`, `assets`) announced. Every row 1 to 14 must be called with and
 * without its capability: no scenario of the profile may be skipped, and none may fail.
 *
 * The database is created by this test as docedit_w5_pro_115_<hex> and dropped afterwards; the
 * objects are deleted under the test tenant's own prefix. The file skips, with the reason, when the
 * environment is not up: pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MATRIX } from '@docedit/authority';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { configFromEnv } from '../../src/config.ts';
import { ensureServiceRole, migrate } from '../../src/index.ts';
import { startService, type Service } from '../../src/server.ts';
import { ADMIN, SERVICE_USER, postgresUnavailable, settings } from '../support/env.ts';
import { runKit } from '../../../../packages/tck/src/runner.ts';
import type { KitReport } from '../../../../packages/tck/src/report.ts';
import { KIT_ORIGIN } from '../../../../packages/tck/test/targets/reference.ts';
import { imageFontManifest } from '../../../export-worker/src/fonts.ts';
import { createExportHandler, type ExportHandlerDeps } from '../../../export-worker/src/job.ts';
import { IMAGE } from '../../../export-worker/src/sandbox.ts';

const S = settings();
const s3 = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'PRO-115 criterion 1: authz, every row of the matrix, on PostgreSQL and S3',
  () => {
    const tenant = randomUUID();
    const keyId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const otherTenant = randomUUID();
    const otherKeyId = randomUUID();
    const otherSecret = randomBytes(32).toString('base64url');
    const dbName = `docedit_w5_pro_115_${randomBytes(6).toString('hex')}`;
    let service: Service | null = null;
    let report: KitReport | null = null;

    const savedCgroups = process.env['DOCEDIT_CONTAINER_CGROUPS'];
    beforeAll(async () => {
      process.env['DOCEDIT_CONTAINER_CGROUPS'] ??= 'disabled';
      const servicePassword = settings()['DOCEDIT_PG_SERVICE_PASSWORD'];
      if (!servicePassword) throw new Error('DOCEDIT_PG_SERVICE_PASSWORD is not set');
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
        try {
          await ensureServiceRole(root, SERVICE_USER, servicePassword);
        } finally {
          await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
        }
        await root.query(`CREATE DATABASE ${dbName}`);
      } finally {
        await root.end();
      }
      const admin = new pg.Client({ ...ADMIN, database: dbName });
      await admin.connect();
      try {
        await migrate(admin);
      } finally {
        await admin.end();
      }
      const pgUrl = `postgres://${SERVICE_USER}:${encodeURIComponent(servicePassword)}@${ADMIN.host}:${ADMIN.port}/${dbName}`;

      const dir = mkdtempSync(join(tmpdir(), 'docedit-w5-pro-115-'));
      const seedFile = join(dir, 'tenants.json');
      writeFileSync(
        seedFile,
        JSON.stringify({
          tenants: [
            {
              id: tenant,
              name: 'w5 PRO-115 authz',
              apiKeys: [
                {
                  id: keyId,
                  secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
                  label: 'w5-pro-115',
                },
              ],
              origins: [KIT_ORIGIN],
            },
            {
              // A second tenant, for the cross-tenant scenarios of the kit (UX-076).
              id: otherTenant,
              name: 'w5 PRO-115 second tenant',
              apiKeys: [
                {
                  id: otherKeyId,
                  secretSha256: createHash('sha256').update(otherSecret, 'utf8').digest('hex'),
                  label: 'w5-pro-115-other',
                },
              ],
              origins: ['https://other.pro-115.example'],
            },
          ],
        }),
      );

      const deps: ExportHandlerDeps = {
        stores: {
          get logs() {
            return service!.parts.logs;
          },
          get checkpoints() {
            return service!.checkpoints;
          },
          get documents() {
            return service!.parts.documents;
          },
        },
        outputs: {
          putExport: (t, j, n, b, c) => service!.assets.putExport(t, j, n, b, c),
        },
        fonts: () => imageFontManifest(IMAGE),
        image: IMAGE,
      };
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DOCEDIT_LISTEN_HOST: '127.0.0.1',
        DOCEDIT_LISTEN_PORT: '0',
        DOCEDIT_TENANTS_FILE: seedFile,
        DOCEDIT_WORKERS: '1',
        DOCEDIT_NODE_ID: `w5-pro-115-${process.pid}`,
        DOCEDIT_EXPORT_TARGETS: 'pdf,cdm',
        // The features of the rows that need one, with the exports and assets this process serves.
        DOCEDIT_FEATURES:
          'presence,regions,suggest-enforced,read-restrictions,comments,history,leases,exports,assets',
        DOCEDIT_DATABASE_URL: pgUrl,
        DOCEDIT_S3_ENDPOINT: s3.endpoint,
        DOCEDIT_S3_REGION: s3.region,
        DOCEDIT_S3_BUCKET: s3.bucket,
        DOCEDIT_S3_ACCESS_KEY: s3.accessKeyId,
        DOCEDIT_S3_SECRET_KEY: s3.secretAccessKey,
      };
      service = await startService({
        config: configFromEnv(env),
        jobHandlers: { export: createExportHandler(deps) },
      });
      report = await runKit({
        discovery: `${service.url}/.well-known/dep`,
        credential: `dsk_${tenant}_${keyId}_${secret}`,
        otherCredential: `dsk_${otherTenant}_${otherKeyId}_${otherSecret}`,
        origin: KIT_ORIGIN,
        testMode: false,
        profiles: ['authz'],
      });
    }, 900_000);

    afterAll(async () => {
      if (savedCgroups === undefined) delete process.env['DOCEDIT_CONTAINER_CGROUPS'];
      else process.env['DOCEDIT_CONTAINER_CGROUPS'] = savedCgroups;
      await service?.close();
      try {
        const store = new S3ObjectStore(s3);
        for (const key of await store.list(`tenants/${tenant}/`)) await store.delete(key);
      } catch {
        // The objects are under this run's tenant only; a failed cleanup leaves nothing shared.
      }
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await root.end();
      }
    }, 300_000);

    const scenarios = () => report?.profiles.flatMap((p) => p.scenarios) ?? [];

    it('has a scenario for every row of the published matrix, and each row passed', () => {
      const byId = new Map(scenarios().map((s) => [s.id, s]));
      expect(MATRIX.length).toBe(14);
      for (const r of MATRIX) {
        const s = byId.get(`authz.${r.id}`);
        expect(s, `row ${r.row} (${r.id}) has a scenario`).toBeDefined();
        expect(s?.outcome, `row ${r.row} (${r.id}): ${JSON.stringify(s?.failure)}`).toBe('passed');
      }
    });

    it('skips no scenario of the profile', () => {
      const skipped = scenarios().filter((s) => s.outcome === 'skipped');
      expect(skipped.map((s) => s.id)).toEqual([]);
    });

    it('passes every scenario of the profile', () => {
      const failed = scenarios().filter((s) => s.outcome !== 'passed');
      expect(failed.map((s) => `${s.id}: ${JSON.stringify(s.failure)}`)).toEqual([]);
    });
  },
);
