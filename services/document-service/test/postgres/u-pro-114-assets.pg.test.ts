/**
 * PRO-114 criteria 1 and 3 (lane U-PRO-103-119): the `assets` profile against the reference
 * service running on PostgreSQL and on the S3-compatible store of the test environment (FND-010).
 * The database is created for this run with a name that carries the lane and is dropped at the
 * end. Assets are written under `tenants/{tenant}/...` in the shared test bucket; the tenant is
 * random to this run, so the keys are under a prefix of their own. The service reaches the store
 * with the test environment's credentials; the kit sees only the discovery URL and the credential.
 *
 * Skips, with the reason, when PostgreSQL or the S3-compatible store is not up
 * (infra/test-env.ps1 up).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore, type S3Settings } from '../../src/objects/s3.ts';
import { ensureServiceRole, migrate } from '../../src/index.ts';
import { ADMIN, postgresUnavailable, settings, SERVICE_USER } from '../support/env.ts';
import { judge } from '../../../../packages/tck/test/targets/judge.ts';
import {
  startReference,
  type StartedTarget,
} from '../../../../packages/tck/test/targets/reference.ts';

const S = settings();
// The kit reads its asset-event wait when its profiles load, so the wait is raised before the
// runner is imported (lane U-PRO-103-119, PRO-114 leftover): a loaded host needs more than 150 s.
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
    await new S3ObjectStore(s3Settings).get('tenants/probe-u-pro-103-119/none');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Settings.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const unavailable = (await postgresUnavailable()) ?? (await s3Unavailable());
if (unavailable) console.warn(`u-pro-114-assets: skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'the assets profile on the reference service over PostgreSQL and S3 (PRO-114, U-PRO-103-119)',
  () => {
    const name = `docedit_u_pro_103_119_assets_${randomBytes(4).toString('hex')}`;
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
            DOCEDIT_ASSET_WORKER: 'true',
            // The WSL Podman machine delegates no cgroup controllers, so the sandbox's --memory and
            // --pids-limit fail through the remote client; the machine route is the development one
            // (services/asset-worker/src/container.ts).
            DOCEDIT_PODMAN_MACHINE: S['DOCEDIT_PODMAN_MACHINE'] ?? 'podman-machine-default',
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

    it('passes every assets scenario, and refuses a caller of another document', async () => {
      expect(target, 'the reference service started').not.toBeNull();
      const t = target!;
      const report = await runKit({
        discovery: t.discovery,
        credential: t.credential,
        origin: t.origin,
        testMode: true,
        profiles: ['assets'],
      });
      expect(report.bootstrap, t.logs().slice(-2000)).toEqual({ ok: true });
      const v = judge(report, {});
      const assets = report.profiles.find((p) => p.id === 'assets');
      expect(assets, 'the assets profile ran').toBeDefined();
      const notPassed = (assets?.scenarios ?? [])
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
      expect(v.unexpected).toEqual([]);
      // Every scenario of criteria 1 and 3 ran and passed: a profile with fewer would not pass.
      const passed = (assets?.scenarios ?? [])
        .filter((s) => s.outcome === 'passed')
        .map((s) => s.id);
      expect(passed).toEqual(
        expect.arrayContaining(['assets.ready', 'assets.failed', 'assets.other-document']),
      );
      // Each scenario waits up to 150 s for its asset event (jobs.ts, ASSET_EVENT_WAIT_MS).
    }, 600_000);
  },
);
