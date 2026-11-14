/**
 * The S3 schedules (packages/authority/test/convergence.property.test.ts, spike S3) and the property
 * that runs them through the data plane (SYN-047). The operation weights are the S3 suite's; the
 * checks are the harness's, on the real log.
 */
import fc from 'fast-check';
import { expect } from 'vitest';
import type { WriteRequest, WriteResult } from '@docedit/authority';
import type { Op } from '../../../../../packages/authority/test/harness/sim.ts';
import type { UserName } from '../../../../../packages/authority/test/fixtures.ts';
import type { MemoryStore } from '../../../src/storage/memory.ts';
import type { DocRef } from '../../../src/storage/types.ts';
import { DepSimulation, type Fault, type SimStores } from './dep-sim.ts';

const text = fc.string({
  minLength: 1,
  maxLength: 3,
  unit: fc.constantFrom('a', 'b', 'c', ' ', 'ü', '中'),
});
const n = fc.noBias(fc.nat(1000));

export const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({ k: fc.constant('edit' as const), c: n, a: n, b: n, s: text }),
  },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('evil' as const), c: n, a: n, b: n }) },
  { weight: 10, arbitrary: fc.record({ k: fc.constant('send' as const), c: n }) },
  { weight: 12, arbitrary: fc.record({ k: fc.constant('toServer' as const), c: n }) },
  { weight: 12, arbitrary: fc.record({ k: fc.constant('toClient' as const), c: n }) },
  { weight: 7, arbitrary: fc.record({ k: fc.constant('write' as const), a: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('drop' as const), c: n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('reconnect' as const), c: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('grants' as const), a: n, b: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('crash' as const), a: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('tick' as const), a: n }) },
);

export const CAST: UserName[] = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory'];

/** The faults on `MemoryStore`, with the conditions first, as src/storage/faults.ts does on PostgreSQL. */
export function memorySimStores(mem: MemoryStore): SimStores {
  return {
    logs: mem,
    ownership: mem,
    grants: mem,
    documents: mem,
    async writeWithFault(ref: DocRef, req: WriteRequest, fault: Fault): Promise<WriteResult> {
      if (fault === 'none') return mem.append(ref, req);
      const head = await mem.head(ref);
      const perms = await mem.current(ref);
      if (req.epoch !== head.epoch || req.fromSeq !== head.seq + 1) return { status: 'fenced' };
      if (req.revision !== perms.revision) return { status: 'revision_moved', perms };
      switch (fault) {
        case 'fail':
          return { status: 'failed' };
        case 'unknown-applied': {
          const r = await mem.append(ref, req);
          return r.status === 'ok'
            ? { status: 'unknown', tail: await mem.read(ref, req.fromSeq) }
            : r;
        }
        case 'unknown-lost':
          return { status: 'unknown', tail: await mem.read(ref, req.fromSeq) };
      }
    },
  };
}

export interface Totals {
  schedules: number;
  commits: number;
  steps: number;
  controls: number;
  rejected: number;
  faults: number;
  writes: number;
  fenced: number;
  crashes: number;
  splitBrains: number;
  grants: number;
  lost: number;
  recovered: number;
  ordered: number;
  codes: Record<string, number>;
}

/** Runs `runs` schedules through the data plane over `stores`; returns the totals. */
export async function runSchedules(
  runs: number,
  stores: () => SimStores,
  tenant: string,
  seed?: number,
): Promise<Totals> {
  const totals: Totals = {
    schedules: 0,
    commits: 0,
    steps: 0,
    controls: 0,
    rejected: 0,
    faults: 0,
    writes: 0,
    fenced: 0,
    crashes: 0,
    splitBrains: 0,
    grants: 0,
    lost: 0,
    recovered: 0,
    ordered: 0,
    codes: {},
  };
  await fc.assert(
    fc.asyncProperty(
      fc.array(op, { minLength: 60, maxLength: 240 }),
      fc.subarray(CAST, { minLength: 2 }),
      async (ops, users) => {
        const sim = await DepSimulation.create({
          users,
          malicious: ['mallory'],
          stores: stores(),
          tenant,
        });
        let failures: string[];
        try {
          await sim.run(ops);
          failures = await sim.check();
          const log = await sim.log();
          totals.schedules++;
          totals.commits += log.filter((c) => c.kind === 'steps').length;
          totals.controls += log.filter((c) => c.kind === 'control').length;
          totals.steps += log.reduce((a, c) => a + c.steps.length, 0);
          totals.faults += sim.stats.faults;
          totals.writes += sim.stats.writes;
          totals.fenced += sim.stats.fenced;
          totals.crashes += sim.stats.crashes;
          totals.splitBrains += sim.stats.splitBrains;
          totals.grants += sim.stats.grantChanges;
          totals.lost += sim.stats.lostNotifications;
          totals.ordered += sim.orderChecked;
          for (const [k, v] of sim.stats.rejected) {
            totals.codes[k] = (totals.codes[k] ?? 0) + v;
            totals.rejected += v;
          }
          for (const c of sim.clients) totals.recovered += c.recovered;
        } finally {
          await sim.dispose();
        }
        expect(
          failures,
          `${failures.join('\n')}\nregression: ${JSON.stringify({ users, ops })}`,
        ).toEqual([]);
      },
    ),
    { numRuns: runs, ...(seed !== undefined ? { seed } : {}) },
  );
  return totals;
}
