// PRO-131 against the reference service on PostgreSQL (lane U-PRO-120-131). The service runs as an
// operator starts it, as a separate process, on a database this test creates (named
// docedit_u_pro_120_131_<hex>) and drops afterwards; the conformance kit's `perm-read` profile
// (packages/tck) runs against it through the discovery URL and a service credential only.
// Skips, with the reason, when the integration environment is not up (infra/test-env.ps1 up).
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureServiceRole, migrate } from '../../src/index.ts';
import { runKit } from '../../../../packages/tck/src/runner.ts';
import {
  startReference,
  type StartedTarget,
} from '../../../../packages/tck/test/targets/reference.ts';
import { ADMIN, SERVICE_USER, postgresUnavailable, settings } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'PRO-131: perm-read against the reference service on PostgreSQL',
  () => {
    const name = `docedit_u_pro_120_131_${randomBytes(6).toString('hex')}`;
    const savedUrl = process.env['DOCEDIT_TCK_DATABASE_URL'];
    let target: StartedTarget | null = null;
    let scenarios: Array<{ id: string; outcome: string; failure?: unknown }> = [];

    beforeAll(async () => {
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
      process.env['DOCEDIT_TCK_DATABASE_URL'] =
        `postgres://${SERVICE_USER}:${encodeURIComponent(servicePassword)}@${ADMIN.host}:${ADMIN.port}/${name}`;
      target = await startReference();
      const report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['perm-read'],
      });
      scenarios = report.profiles.flatMap((p) => p.scenarios);
    }, 600_000);

    afterAll(async () => {
      await target?.stop();
      if (savedUrl === undefined) delete process.env['DOCEDIT_TCK_DATABASE_URL'];
      else process.env['DOCEDIT_TCK_DATABASE_URL'] = savedUrl;
      const root = new pg.Client(ADMIN);
      await root.connect();
      try {
        await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await root.end();
      }
    }, 120_000);

    for (const id of [
      'perm-read.leak',
      'perm-read.converge',
      'perm-read.placeholder',
      'perm-read.hidden-value',
    ])
      it(`${id} passes on PostgreSQL`, () => {
        const s = scenarios.find((x) => x.id === id);
        expect(s?.outcome, JSON.stringify(s?.failure)).toBe('passed');
      });

    it('announces read restrictions in discovery (PRO-130 criterion 4, first half)', async () => {
      const res = await fetch(target!.discovery);
      const doc = (await res.json()) as { features?: string[] };
      expect(doc.features ?? []).toContain('read-restrictions');
    });
  },
);
