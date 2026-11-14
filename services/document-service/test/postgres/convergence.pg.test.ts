// SYN-047: the S3 property suite (packages/authority/test/convergence.property.test.ts) against
// PostgreSQL. The suite and its harness run unchanged; only the harness's in-memory storage is
// replaced, through vi.mock, by PgSimStorage, which sends every write, read, grant change and
// ownership claim to the real stores. The faults of the simulation (failed writes, unknown
// outcomes stored or lost) are applied to the real transaction (src/storage/faults.ts).
//
// Runs: SYN047_RUNS schedules, default 300 like the suite's own default; its thresholds scale with
// it (below 300 they fail by chance too often). The long run is SYN047_RUNS=3000. A failure prints
// fast-check's seed; SYN047_SEED=<seed> replays the same schedules. With the same seed the suite's
// totals are identical in memory and against PostgreSQL. Skips when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
import fc from 'fast-check';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import { SyncBridge } from '../sim/sync-bridge.ts';
import { useBridge } from '../sim/pg-sim-storage.ts';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

vi.mock('../../../../packages/authority/test/harness/storage.ts', async () => {
  const m = await import('../sim/pg-sim-storage.ts');
  return { MemoryStorage: m.PgSimStorage };
});

const unavailable = await postgresUnavailable();

if (unavailable) {
  console.warn(`skipped: ${unavailable}`);
  describe.skip('SYN-047: S3 property suite against PostgreSQL', () => {
    it('needs PostgreSQL', () => {});
  });
} else {
  const runs = Number(process.env['SYN047_RUNS'] ?? 300);
  const db: TestDatabase = await createTestDatabase();
  const bridge = new SyncBridge(db.serviceConfig, newTenant());
  useBridge(bridge);
  let started = 0;
  beforeAll(() => {
    started = performance.now();
  });
  afterAll(async () => {
    const seconds = (performance.now() - started) / 1000;
    const stats = bridge.call<Record<string, unknown>>('stats');
    console.log(
      `SYN-047 against PostgreSQL: ${runs} schedules in ${seconds.toFixed(1)} s; ${bridge.calls} storage calls; ${JSON.stringify(stats)}`,
    );
    await bridge.close();
    useBridge(null);
    await db.drop();
  });

  // SYN047_SEED replays the schedules of a failing run (fast-check prints its seed).
  const seed = process.env['SYN047_SEED'];
  if (seed) fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: Number(seed) });
  // The suite reads S3_RUNS when it is loaded; restore it so other files in this worker see theirs.
  const saved = process.env['S3_RUNS'];
  process.env['S3_RUNS'] = String(runs);
  // Measured on 2026-11-06 on the development machine (Windows 11, PostgreSQL 17.11 on tmpfs in
  // the Podman WSL machine): 300 schedules in 25 to 29 s, 3,000 in 297.7 s. Allow ten times that.
  vi.setConfig({ testTimeout: Math.max(60_000, runs * 1000) });
  try {
    await import('../../../../packages/authority/test/convergence.property.test.ts');
  } finally {
    if (saved === undefined) delete process.env['S3_RUNS'];
    else process.env['S3_RUNS'] = saved;
  }
}
