// backend-local over a store in memory (PRO-100): the scenarios of test/scenarios.ts in Node.js.
// The same scenarios run over IndexedDB in src/local.universal.test.ts.
import { MemoryStore, type LocalStore } from '../src/index.ts';
import { localScenarios } from './scenarios.ts';

const stores = new Map<string, MemoryStore>();
let n = 0;

localScenarios({
  openStore: (name): LocalStore => {
    let store = stores.get(name);
    if (!store) stores.set(name, (store = new MemoryStore()));
    return store;
  },
  fresh: () => `mem-${++n}`,
});
