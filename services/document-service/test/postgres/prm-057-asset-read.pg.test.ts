/**
 * PRM-057 criterion 8: the matrix scenarios of the `perm-doc` and `perm-region` profiles
 * (`packages/tck/src/profiles/perm-matrix.ts`), row 7 included, against the reference service
 * running on PostgreSQL and on the S3-compatible store of the test environment (FND-010), with the
 * asset worker in its Podman sandbox. Row 7 (`perm-doc.asset-read`) needs that environment: an
 * editor uploads an image, waits for `asset.ready`, attaches it by a commit, and a viewer resolves
 * it while a caller with no view on the document is refused.
 *
 * The database is created for this run, with a name that carries the lane, and dropped at the end.
 * Skips, with the reason, when PostgreSQL or the S3-compatible store is not up
 * (`pwsh -NoProfile -File infra/test-env.ps1 up`).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { ensureServiceRole, migrate } from '../../src/index.ts';
import { ADMIN, machineEnv, postgresUnavailable, settings, SERVICE_USER } from '../support/env.ts';
import {
  startReference,
  type StartedTarget,
} from '../../../../packages/tck/test/targets/reference.ts';

const S = settings();
// The kit reads its asset-event wait when its profiles load, so the wait is raised before the
// runner is imported: a loaded host needs more than 150 s.
process.env['DOCEDIT_TCK_ASSET_WAIT_MS'] ??= '300000';
const { runKit } = await import('../../../../packages/tck/src/runner.ts');
const s3Settings: S3Settings = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore(s3Settings).get('tenants/probe-prm-057-w9/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`prm-057-asset-read: skipped: ${unavailable}`);

const MATRIX = [
  'perm-doc.view-required',
  'perm-doc.export-view',
  'perm-doc.service-routes',
  'perm-doc.asset-upload',
  'perm-doc.asset-read',
  'perm-region.wrap-structure',
  'perm-region.manage-only',
];

describe.skipIf(unavailable !== null)(
  'the permission matrix scenarios on the reference service over PostgreSQL and S3 (PRM-057)',
  () => {
    const name = `docedit_w9_prm057_${randomBytes(4).toString('hex')}`;
    const password = S['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
    let target: StartedTarget | null = null;
    const saved = process.env['DOCEDIT_TCK_DATABASE_URL'];

    beforeAll(async () => {
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
      const admin = new pg.Client({ ...ADMIN, database: name });
      await admin.connect();
      try {
        await migrate(admin);
      } finally {
        await admin.end();
      }
      const host = ADMIN.host as string;
      process.env['DOCEDIT_TCK_DATABASE_URL'] =
        `postgres://${encodeURIComponent(SERVICE_USER)}:${encodeURIComponent(password)}@${host}:${ADMIN.port}/${name}`;
      try {
        target = await startReference({
          env: {
            DOCEDIT_TEST_MODE: 'true',
            DOCEDIT_ENVIRONMENT: 'test',
            DOCEDIT_FEATURES: 'presence,regions,suggest-enforced,read-restrictions,assets,exports',
            DOCEDIT_ASSET_WORKER: 'true',
            // The WSL Podman machine delegates no cgroup controllers (see u-pro-114-assets.pg.test.ts).
            ...machineEnv(S),
            DOCEDIT_S3_HOST: S['DOCEDIT_S3_HOST'] ?? '127.0.0.1',
            DOCEDIT_S3_PORT: S['DOCEDIT_S3_PORT'] ?? '57070',
            DOCEDIT_S3_REGION: s3Settings.region,
            DOCEDIT_S3_BUCKET: s3Settings.bucket,
            DOCEDIT_S3_ACCESS_KEY: s3Settings.accessKeyId,
            DOCEDIT_S3_SECRET_KEY: s3Settings.secretAccessKey,
          },
          startTimeoutMs: 60_000,
        });
      } finally {
        if (saved === undefined) delete process.env['DOCEDIT_TCK_DATABASE_URL'];
        else process.env['DOCEDIT_TCK_DATABASE_URL'] = saved;
      }
    }, 120_000);

    afterAll(async () => {
      await target?.stop();
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await root.end();
      }
    }, 60_000);

    it('passes every matrix scenario, row 7 (asset read) included', async () => {
      expect(target, 'the reference service started').not.toBeNull();
      const t = target!;
      const report = await runKit({
        discovery: t.discovery,
        credential: t.credential,
        origin: t.origin,
        testMode: true,
        profiles: ['perm-doc', 'perm-region'],
        scenarios: MATRIX,
      });
      expect(report.bootstrap, t.logs().slice(-2000)).toEqual({ ok: true });
      const ran = report.profiles.flatMap((p) => p.scenarios).filter((s) => MATRIX.includes(s.id));
      const notPassed = ran
        .filter((s) => s.outcome !== 'passed')
        .map(
          (s) =>
            `${s.id}: ${s.outcome}${'reason' in s && s.reason ? ` (${String(s.reason)})` : ''}${s.failure ? ` [${s.failure.message}; expected ${s.failure.expected ?? '-'}; received ${(s.failure.received ?? '-').slice(0, 300)}]` : ''}`,
        );
      const errors = t
        .logs()
        .split('\n')
        .filter((l) => /"level":"(error|warn)"|status":5/.test(l))
        .slice(-20)
        .join('\n');
      expect(notPassed, errors).toEqual([]);
      expect(ran.map((s) => s.id).sort()).toEqual([...MATRIX].sort());
    }, 600_000);
  },
);
