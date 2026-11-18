// PRO-131 against the reference service (lane U-PRO-120-131): the `perm-read` profile, with its leak
// oracle, runs against the service as an operator starts it, reached only through its discovery URL
// and a service credential. In-memory storage here; the PostgreSQL run is in
// services/document-service/test/postgres/pro-131-perm-read.pg.test.ts.
import { describe, expect, it } from 'vitest';
import { runKit } from '../src/runner.ts';
import { startReference } from './targets/reference.ts';

describe('PRO-131: the perm-read profile against the reference service (in memory)', () => {
  it('announces read-restrictions and passes the leak, convergence and placeholder scenarios', async () => {
    const target = await startReference();
    try {
      const report = await runKit({
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
        profiles: ['perm-read'],
      });
      const scenarios = report.profiles.flatMap((p) => p.scenarios);
      const byId = Object.fromEntries(scenarios.map((s) => [s.id, s]));
      for (const id of [
        'perm-read.leak',
        'perm-read.converge',
        'perm-read.placeholder',
        'perm-read.hidden-value',
      ])
        expect(byId[id]?.outcome, JSON.stringify(byId[id]?.failure)).toBe('passed');
    } finally {
      await target.stop();
    }
  }, 600_000);
});
