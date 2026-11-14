// SYN-047: the S3 property suite through the data plane over PostgreSQL. Every client speaks DEP
// over a real WebSocket to createDataPlane, whose rooms write to the PostgreSQL stores; the faults
// of the simulation act on the real transaction (src/storage/faults.ts). Skips when PostgreSQL is
// not up: pwsh -NoProfile -File infra/test-env.ps1 up
//
// Runs: SYN047_DEP_RUNS schedules (default 30). A failure prints fast-check's seed and the
// schedule as JSON; SYN047_SEED replays the same schedules.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendWithFault } from '../../src/storage/faults.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';
import type { SimStores } from './sim/dep-sim.ts';
import { runSchedules } from './sim/schedules.ts';

const RUNS = Number(process.env['SYN047_DEP_RUNS'] ?? 30);
const SEED = process.env['SYN047_SEED'] ? Number(process.env['SYN047_SEED']) : undefined;
const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)(
  'SYN-047: the S3 schedules through the data plane (PostgreSQL)',
  () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db?.drop();
    });

    it(
      'converges, stores nothing twice, attributes every commit, and keeps every writable set',
      async () => {
        const s = pgStores(db.service);
        const stores: SimStores = {
          logs: s.logs,
          ownership: s.logs,
          grants: s.grants,
          documents: s.docs,
          writeWithFault: (ref, req, fault, failAt) =>
            appendWithFault(s.logs, ref, req, fault, failAt),
        };
        const started = performance.now();
        const totals = await runSchedules(RUNS, () => stores, newTenant(), SEED);
        const line = `SYN-047 through the data plane (PostgreSQL): ${RUNS} schedules in ${((performance.now() - started) / 1000).toFixed(1)} s; ${JSON.stringify(totals)}`;
        console.log(line);
        // SYN047_REPORT names a file that collects the totals of every run.
        if (process.env['SYN047_REPORT']) appendFileSync(process.env['SYN047_REPORT'], `${line}\n`);
        expect(totals.commits).toBeGreaterThan(RUNS);
        expect(totals.rejected).toBeGreaterThan(RUNS / 5);
        expect(totals.faults).toBeGreaterThan(RUNS / 10);
        expect(totals.ordered).toBeGreaterThan(RUNS * 10);
      },
      Math.max(180_000, RUNS * 6000),
    );
  },
);
