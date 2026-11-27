// The cost of one commit through the room, stage by stage, on the shared corpus (SYN-040; 04 §12).
// Run from the repository root:
//
//   node packages/authority/scripts/commit-cost.ts [typical runs] [rebased runs] [worst-case runs] [seed]
//
// Prints the machine, then a Markdown table of the median and 99th percentile (milliseconds) of each
// stage of 04 §5 steps 2 to 7 for a typical commit (one `replace` step of one character), the same
// commit rebased over ten stored commits, and a worst-case commit (500 such steps), on documents of
// 1, 20 and 100 pages. The harness is `test/harness/commit-cost.ts`; the gate on the same numbers is
// `test/syn-040-commit-cost.test.ts`.
import { writeFileSync } from 'node:fs';
import {
  DEFAULT_RUNS,
  budgetViolations,
  describeMachine,
  measureAll,
  tabulate,
  toJson,
} from '../test/harness/commit-cost.ts';

// Flags: `--json <file>` writes the results with the machine and the budget as JSON, for a workflow
// that stores them per commit (owner decisions 103 and 225); `--commit <revision>` names the
// revision measured. The exit status is 1 when a typical or rebased commit exceeds the budget.
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === '--json' || a === '--commit') flags.set(a, process.argv[++i] ?? '');
  else positional.push(a);
}
const arg = (i: number, fallback: number): number => Number(positional[i] ?? fallback);
const results = await measureAll({
  runs: {
    typical: arg(0, DEFAULT_RUNS.typical),
    rebased: arg(1, DEFAULT_RUNS.rebased),
    worst: arg(2, DEFAULT_RUNS.worst),
  },
  seed: arg(3, 1),
});
console.log(`Machine: ${describeMachine()}`);
console.log('Wall-clock milliseconds on one thread, "median / 99th percentile" per commit.');
console.log(tabulate(results));
const violations = budgetViolations(results);
if (violations.length > 0) console.log(`\nOver the budget:\n${violations.join('\n')}`);
else console.log('\nWithin the budget of a typical commit (04 §12).');
const json = flags.get('--json');
if (json) writeFileSync(json, `${toJson(results, flags.get('--commit') ?? null)}\n`);
process.exitCode = violations.length > 0 ? 1 : 0;
