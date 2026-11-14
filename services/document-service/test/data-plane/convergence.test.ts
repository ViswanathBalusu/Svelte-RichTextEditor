// SYN-047: the S3 property suite through the data plane over MemoryStore. Every client speaks DEP
// over a real WebSocket to createDataPlane; the schedules, the reference clients and the oracle are
// the S3 harness's (packages/authority/test/harness). The same run against PostgreSQL is
// convergence.pg.test.ts.
//
// Runs: SYN047_DEP_RUNS schedules (default 60). A failure prints fast-check's seed and the
// schedule as JSON; SYN047_SEED replays the same schedules.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/memory.ts';
import { memorySimStores, runSchedules } from './sim/schedules.ts';

const RUNS = Number(process.env['SYN047_DEP_RUNS'] ?? 60);
const SEED = process.env['SYN047_SEED'] ? Number(process.env['SYN047_SEED']) : undefined;

describe('SYN-047: the S3 schedules through the data plane (memory)', () => {
  it(
    'converges, stores nothing twice, attributes every commit, and keeps every writable set',
    async () => {
      const started = performance.now();
      const mem = new MemoryStore();
      const totals = await runSchedules(
        RUNS,
        () => memorySimStores(mem),
        crypto.randomUUID(),
        SEED,
      );
      const line = `SYN-047 through the data plane (memory): ${RUNS} schedules in ${((performance.now() - started) / 1000).toFixed(1)} s; ${JSON.stringify(totals)}`;
      console.log(line);
      // SYN047_REPORT names a file that collects the totals of every run.
      if (process.env['SYN047_REPORT']) appendFileSync(process.env['SYN047_REPORT'], `${line}\n`);
      // Not vacuous: commits stored and refused, faults, failovers, lost notifications, and
      // messages whose order was checked; the thresholds scale with the number of runs.
      expect(totals.commits).toBeGreaterThan(RUNS);
      expect(totals.rejected).toBeGreaterThan(RUNS / 5);
      expect(totals.faults).toBeGreaterThan(RUNS / 10);
      expect(totals.crashes).toBeGreaterThan(RUNS / 20);
      expect(totals.lost).toBeGreaterThan(RUNS / 20);
      expect(totals.ordered).toBeGreaterThan(RUNS * 10);
      for (const code of ['permission_denied', 'invalid_op', 'unavailable'])
        expect(totals.codes[code] ?? 0, code).toBeGreaterThan(0);
    },
    Math.max(120_000, RUNS * 3000),
  );
});
