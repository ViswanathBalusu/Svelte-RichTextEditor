// Writes the regression fixtures of spike HIS-043: for every scenario of test/scenarios.ts, the
// output of both comparison methods next to the changes a reader would expect.
//
//   node packages/history/scripts/comparison-fixtures.ts
//
// test/comparison-fixtures.test.ts fails when the output no longer matches a fixture; run this
// script after a deliberate change and review the difference.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SCENARIOS, runScenario } from '../test/scenarios.ts';

const dir = new URL('../fixtures/comparison/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of SCENARIOS) {
  const r = runScenario(s);
  writeFileSync(new URL(`${s.name}.json`, dir), `${JSON.stringify(r, null, 2)}\n`);
  console.log(
    `${s.name}: steps ${r.matches.steps ? 'as expected' : 'differs'}, aligned ${r.matches.aligned ? 'as expected' : 'differs'}`,
  );
}
