// backend-mock against the reusable port contract suite and the smoke suite for the `core` profile
// (SPK-019; PRO-098 first version; PRO-099). The suites import only the port typings; this file is
// the only place that knows the implementation.
import { describe, it } from 'vitest';
import { coreSmoke, portContract, type ContractCase } from '@docedit/protocol/contract';
import { mockHarness, sleep } from './harness.ts';

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases)
    it(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
};

describe('backend-mock: port contract', () => {
  register(portContract(mockHarness(), { sleep }));
});

describe('backend-mock: smoke suite for the core profile', () => {
  register(coreSmoke(mockHarness(), { sleep }));
});

describe('backend-mock without the presence port: its cases are skipped and reported', () => {
  register(
    portContract(mockHarness({ presence: false }), { sleep }).filter((k) => k.port === 'presence'),
  );
});
