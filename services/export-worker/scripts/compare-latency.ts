/**
 * The export latency regression check (EXP-060 criterion 3).
 *
 *   node services/export-worker/scripts/compare-latency.ts <results.json>
 *        [--baseline services/export-worker/baseline/latency-reference-1.json]
 *   node services/export-worker/scripts/compare-latency.ts --write-baseline a.json,b.json,c.json
 *        --source "<machine, runs, date>" [--baseline <file>]
 *
 * The results are the `results.json` files of `scripts/latency.ts`. The check exits with 1 when a
 * metric is slower than the baseline by more than its tolerance, when a baseline metric is missing
 * from the result, or when the result used another image. A baseline is written from three or more
 * consecutive result files, and its tolerances are the measured spread between them
 * (`src/latency-baseline.ts`; ADR 0037 section 6).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineFrom,
  compareWithBaseline,
  type LatencyBaseline,
  type LatencyResult,
} from '../src/latency-baseline.ts';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const baselineFile = resolve(
  opt('--baseline') ??
    fileURLToPath(new URL('../baseline/latency-reference-1.json', import.meta.url)),
);
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(file), 'utf8')) as T;

const writeFrom = opt('--write-baseline');
if (writeFrom) {
  const source = opt('--source');
  if (!source) throw new Error('--write-baseline needs --source');
  const baseline = baselineFrom(
    writeFrom.split(',').map((f) => read<LatencyResult>(f)),
    source,
  );
  writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`baseline written to ${baselineFile}`);
} else {
  const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--baseline');
  if (!file) throw new Error('give the results.json of a latency run');
  const report = compareWithBaseline(
    read<LatencyResult>(file),
    read<LatencyBaseline>(baselineFile),
  );
  console.log(`${file} against ${baselineFile}`);
  for (const c of report.compared)
    console.log(
      `${c.regressed ? 'REGRESSED' : 'ok       '} ${c.key}: ${c.value} ms against ${c.baseline} ms (${(c.worseBy * 100).toFixed(1)} % ${c.worseBy > 0 ? 'slower' : 'faster'}; tolerance ${(c.tolerance * 100).toFixed(0)} %)`,
    );
  for (const m of report.missing) console.log(`MISSING   ${m}`);
  for (const i of report.incompatible) console.log(`INCOMPATIBLE ${i}`);
  if (!report.ok) process.exit(1);
}
