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
import {
  DEFAULT_RUNS,
  describeMachine,
  measureAll,
  tabulate,
} from '../test/harness/commit-cost.ts';

const arg = (i: number, fallback: number): number => Number(process.argv[i] ?? fallback);
const results = await measureAll({
  runs: {
    typical: arg(2, DEFAULT_RUNS.typical),
    rebased: arg(3, DEFAULT_RUNS.rebased),
    worst: arg(4, DEFAULT_RUNS.worst),
  },
  seed: arg(5, 1),
});
console.log(`Machine: ${describeMachine()}`);
console.log('Wall-clock milliseconds on one thread, "median / 99th percentile" per commit.');
console.log(tabulate(results));
