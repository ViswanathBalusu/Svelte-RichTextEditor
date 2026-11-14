/**
 * The schedules of the S3 simulation as fast-check arbitraries (SPK-016, SYN-047), shared by the
 * convergence suites so that they generate the same mix of operations.
 */
import fc from 'fast-check';
import type { UserName } from '../fixtures.ts';
import type { Op } from './sim.ts';

const text = fc.string({
  minLength: 1,
  maxLength: 3,
  unit: fc.constantFrom('a', 'b', 'c', ' ', 'ü', '中'),
});
// Unbiased: fast-check favours small integers by default, which would make client 0 do everything.
const n = fc.noBias(fc.nat(1000));

/** One operation; `snapshotWeight` above 0 adds the control plane's restores (SYN-005). */
export function opArbitrary(snapshotWeight = 0): fc.Arbitrary<Op> {
  const ops: Array<fc.WeightedArbitrary<Op>> = [
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
  ];
  if (snapshotWeight > 0)
    ops.push({
      weight: snapshotWeight,
      arbitrary: fc.record({ k: fc.constant('snapshot' as const), a: n }),
    });
  return fc.oneof(...ops);
}

export const CAST: UserName[] = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory'];
