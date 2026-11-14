// The scenarios of spike HIS-043 as regression fixtures of HIS-011 and HIS-012: both comparison
// methods give exactly the recorded output, and that output names the changes a reader expects.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, type ScenarioResult, runScenario } from './scenarios.ts';

describe('comparison quality fixtures (HIS-043)', () => {
  for (const s of SCENARIOS)
    it(`${s.name}: ${s.description}`, () => {
      const recorded = JSON.parse(
        readFileSync(new URL(`../fixtures/comparison/${s.name}.json`, import.meta.url), 'utf8'),
      ) as ScenarioResult;
      const now = runScenario(s);
      expect(JSON.parse(JSON.stringify(now))).toEqual(recorded);
      // Every scenario names what a reader would expect, by either method.
      expect(now.matches).toEqual({ steps: true, aligned: true });
    });
});
