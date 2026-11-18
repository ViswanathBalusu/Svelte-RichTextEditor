// backend-local over a store in memory against the reusable port contract suite and the smoke
// suite of the `core` profile (PRO-098, PRO-100). The same suite runs over IndexedDB in the
// browsers (src/local.universal.test.ts). The suites import only the port typings.
import { describe, it } from 'vitest';
import { coreSmoke, portContract, type ContractCase } from '@docedit/protocol/contract';
import { MemoryStore } from '../src/index.ts';
import { localHarness, sleep } from './harness.ts';

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases)
    it(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
};

describe('backend-local (memory store): port contract', () => {
  register(
    portContract(
      localHarness(() => new MemoryStore()),
      { sleep },
    ),
  );
});

describe('backend-local (memory store): smoke suite for the core profile', () => {
  register(
    coreSmoke(
      localHarness(() => new MemoryStore()),
      { sleep },
    ),
  );
});

describe('backend-local without the presence port: its cases are skipped and reported', () => {
  register(
    portContract(
      localHarness(() => new MemoryStore(), { presence: false }),
      { sleep },
    ).filter((k) => k.port === 'presence'),
  );
});
