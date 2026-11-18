/**
 * PRO-111 criterion 6 (lane U-PRO-103-119): the `core` profile against the reference service
 * running on PostgreSQL, the way an operator runs it. The database is created for this run with a
 * name that carries the lane, is migrated by the admin role, and is dropped at the end. The
 * service reaches it through its service role (no superuser, no BYPASSRLS). The kit sees only the
 * discovery URL and the service credential (startReference, packages/tck/test/targets/reference.ts).
 *
 * Skips, with the reason, when PostgreSQL is not up (infra/test-env.ps1 up).
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureServiceRole, migrate } from '../../src/index.ts';
import { ADMIN, postgresUnavailable, settings, SERVICE_USER } from '../support/env.ts';
import { runKit } from '../../../../packages/tck/src/runner.ts';
import { judge } from '../../../../packages/tck/test/targets/judge.ts';
import {
  startReference,
  type StartedTarget,
} from '../../../../packages/tck/test/targets/reference.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/**
 * No scenario of the core profile is a known difference. A silent peer is closed with 1001, as the
 * owner decided on 2026-11-15 (decision 194; 05 §4).
 */
const CORE_KNOWN: Readonly<Record<string, string>> = {};

describe.skipIf(unavailable !== null)(
  'the core profile on the reference service over PostgreSQL (PRO-111 criterion 6)',
  () => {
    const name = `docedit_u_pro_103_119_${randomBytes(4).toString('hex')}`;
    const password = settings()['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';
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
        // Test mode shortens the timers the two session scenarios wait on (PRO-109, BE-079).
        target = await startReference({
          env: { DOCEDIT_TEST_MODE: 'true', DOCEDIT_ENVIRONMENT: 'test' },
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

    it('passes every core scenario against the service on PostgreSQL', async () => {
      expect(target, 'the reference service started').not.toBeNull();
      const t = target!;
      const report = await runKit({
        discovery: t.discovery,
        credential: t.credential,
        origin: t.origin,
        testMode: true,
        profiles: ['core'],
        fuzz: { budgetMs: 4000 },
        property: { runs: 8 },
      });
      const v = judge(report, CORE_KNOWN);
      expect(report.bootstrap, t.logs().slice(-2000)).toEqual({ ok: true });
      expect(v.unexpected).toEqual([]);
      const core = report.profiles.find((p) => p.id === 'core');
      expect(core, 'the core profile ran').toBeDefined();
      // Every core scenario must pass, not only be free of failures: a skip is reported here.
      const notPassed = (core?.scenarios ?? [])
        .filter((s) => s.outcome !== 'passed' && !(s.id in CORE_KNOWN))
        .map(
          (s) =>
            `${s.id}: ${s.outcome}${'reason' in s && s.reason ? ` (${String(s.reason)})` : ''}`,
        );
      const errors = t
        .logs()
        .split('\n')
        .filter((l) => /"level":"(error|warn)"|status":5/.test(l))
        .slice(-20)
        .join('\n');
      // Every scenario passes, core.channel.page included: it makes catchUpCommits + 1 commits.
      expect(notPassed, errors).toEqual([]);
    }, 900_000);
  },
);
