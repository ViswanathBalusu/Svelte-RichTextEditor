// backend-dep against the reusable port contract suite and the smoke suite of the `core` profile
// (PRO-093, PRO-094; PRO-098 first version), over the in-memory network to the DEP server built on
// backend-mock. Universal: it runs in Node.js and in every browser engine, which shows that the
// protocol client and backend-dep need no Node.js or browser-only API (PRO-004).
import { describe, it } from 'vitest';
import { coreSmoke, portContract, type ContractCase } from '@docedit/protocol/contract';
import { depHarness, sleep } from '../test/support/harness.ts';

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases)
    it(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
};

describe('backend-dep over DEP: port contract', () => {
  register(portContract(depHarness(), { sleep }));
});

describe('backend-dep over DEP: smoke suite for the core profile', () => {
  register(coreSmoke(depHarness(), { sleep }));
});

describe('backend-dep against a server without presence: its cases are skipped and reported', () => {
  register(
    portContract(depHarness({ server: { presence: false } }), { sleep }).filter(
      (k) => k.port === 'presence',
    ),
  );
});
