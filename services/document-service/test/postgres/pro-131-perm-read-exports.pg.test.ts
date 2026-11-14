/**
 * PRO-131 criterion 1, the export branch (lane V-PRO-120-131). The `perm-read` profile of the
 * conformance kit runs against the document service with the export worker's job handler in the
 * same process, on PostgreSQL and the S3-compatible store of the integration environment. A CDM
 * export is built by the real handler from the requester's projection, stored, and delivered by a
 * signed URL that the leak oracle reads. The test asserts that the owner's export carries the
 * confidential region (so the canary is real), and that the leak scenario reports the export branch
 * as proven, not as unproven.
 *
 * The database is created by this test as docedit_v_pro_120_131_<hex> and dropped afterwards; the
 * objects are deleted under the test tenant's own prefix. The file skips, with the reason, when the
 * environment is not up: pwsh -NoProfile -File infra/test-env.ps1 up
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  'PRO-131 criterion 1: perm-read with the export branch on PostgreSQL and S3',
  () => {
    const tenant = randomUUID();
    const keyId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const dbName = `docedit_v_pro_120_131_${randomBytes(6).toString('hex')}`;
    let service: Service | null = null;
    let report: KitReport | null = null;

    // The font manifest and the export sandbox run `podman run`; on the WSL machine that needs
    // --cgroups=disabled (infra/test-env.ps1, export-worker container.ts). Set for this run only.
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

      const dir = mkdtempSync(join(tmpdir(), 'docedit-v-pro-120-131-'));
      const seedFile = join(dir, 'tenants.json');
      writeFileSync(
        seedFile,
        JSON.stringify({
          tenants: [
            {
              id: tenant,
              name: 'V-PRO-120-131 perm-read exports',
              apiKeys: [
                {
                  id: keyId,
                  secretSha256: createHash('sha256').update(secret, 'utf8').digest('hex'),
                  label: 'v-pro-120-131',
                },
              ],
              origins: [KIT_ORIGIN],
            },
          ],
        }),
      );

      // The real export handler: the S3 store and the database are the service's own.
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
        DOCEDIT_NODE_ID: `v-pro-120-131-${process.pid}`,
        // The worker below builds the canonical JSON (`cdm`) target; it needs no sandbox.
        DOCEDIT_EXPORT_TARGETS: 'pdf,cdm',
        DOCEDIT_DATABASE_URL: pgUrl,
        DOCEDIT_S3_ENDPOINT: s3.endpoint,
        DOCEDIT_S3_REGION: s3.region,
        DOCEDIT_S3_BUCKET: s3.bucket,
        DOCEDIT_S3_ACCESS_KEY: s3.accessKeyId,
        DOCEDIT_S3_SECRET_KEY: s3.secretAccessKey,
      };
      // The font manifest is read from the image once, here, and cached by the handler's own
      // reader, so that each job does not wait for a `podman run` (slow on a shared machine).
      for (let attempt = 1; ; attempt++) {
        try {
          await imageFontManifest(IMAGE);
          break;
        } catch (e) {
          if (attempt === 3) throw e;
        }
      }
      service = await startService({
        config: configFromEnv(env),
        jobHandlers: { export: createExportHandler(deps) },
      });
      report = await runKit({
        discovery: `${service.url}/.well-known/dep`,
        credential: `dsk_${tenant}_${keyId}_${secret}`,
        origin: KIT_ORIGIN,
        testMode: false,
        profiles: ['perm-read'],
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
    }, 120_000);

    const scenario = (id: string) =>
      report?.profiles.flatMap((p) => p.scenarios).find((s) => s.id === id);

    it('the leak scenario passes with the export branch proven (not unproven)', () => {
      const s = scenario('perm-read.leak');
      expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
      expect(s?.notes ?? [], 'the notes of the leak scenario').toEqual(
        expect.arrayContaining([expect.stringMatching(/^export branch proven/)]),
      );
    });

    it('both readers without access had their export answered and scanned', () => {
      const notes = scenario('perm-read.leak')?.notes ?? [];
      for (const who of ['editor-without-grant', 'viewer-without-grant'])
        expect(notes, `${who} export`).toEqual(
          expect.arrayContaining([expect.stringMatching(new RegExp(`^${who}: export`))]),
        );
    });

    it('converge and placeholder pass', () => {
      for (const id of ['perm-read.converge', 'perm-read.placeholder'])
        expect(scenario(id)?.outcome, JSON.stringify(scenario(id)?.failure)).toBe('passed');
    });

    it('announces exports and read restrictions in discovery', async () => {
      const res = await fetch(`${service!.url}/.well-known/dep`);
      const doc = (await res.json()) as { features?: string[] };
      expect(doc.features ?? []).toEqual(expect.arrayContaining(['exports', 'read-restrictions']));
    });
  },
);
