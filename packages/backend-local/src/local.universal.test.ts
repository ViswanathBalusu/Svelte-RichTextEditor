// backend-local over IndexedDB (PRO-100, PRO-098): the port contract suite, the smoke suite of the
// `core` profile and the scenarios of test/scenarios.ts, in every browser engine. Node.js has no
// IndexedDB, so the file skips there (the same cases run over a memory store in test/).
import { describe, it } from 'vitest';
import { coreSmoke, portContract, type ContractCase } from '@docedit/protocol/contract';
import { IndexedDbStore } from './index.ts';
import { localHarness, sleep } from '../test/harness.ts';
import { localScenarios } from '../test/scenarios.ts';

const has = typeof indexedDB !== 'undefined';
let n = 0;
const run = `de-test-${Date.now().toString(36)}`;
const fresh = (): string => `${run}-${++n}`;

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases)
    it.skipIf(!has)(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
};

describe('backend-local over IndexedDB: port contract', () => {
  register(
    portContract(
      localHarness(() => new IndexedDbStore(fresh())),
      { sleep },
    ),
  );
});

describe('backend-local over IndexedDB: smoke suite for the core profile', () => {
  register(
    coreSmoke(
      localHarness(() => new IndexedDbStore(fresh())),
      { sleep },
    ),
  );
});

if (has) localScenarios({ openStore: (name) => new IndexedDbStore(name), fresh });
else
  describe.skip('backend-local over IndexedDB: scenarios (no IndexedDB in this runtime)', () => {});
