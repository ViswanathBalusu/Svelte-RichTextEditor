/**
 * The scheduled run's regression check (FND-007 criterion 5): compares a harness result
 * (test-results/runs/*.json) with the committed baseline (baseline/reference-1.json) and exits
 * with 1 when a metric is worse than the baseline by more than the baseline's tolerance, when a
 * baseline metric is missing, or when the run used another corpus version or profile. It also exits
 * with 1 when a gated budget is exceeded (`BUDGET_GATED_METRICS`: the 95th percentile of typing).
 *
 * Usage (from packages/perf):
 *   node scripts/compare-baseline.ts [run.json] [--baseline baseline/reference-1.json]
 *   node scripts/compare-baseline.ts --write-baseline run.json --tolerance 0.25 --source "..."
 *
 * Without a run file it takes the newest file in test-results/runs. `--write-baseline` writes a
 * new baseline from a run instead of comparing; the tolerance and its source are required, because
 * the tolerance must come from a measurement of run-to-run spread (ADR 0037).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineFrom,
  budgetBreaches,
  compareWithBaseline,
  type Baseline,
} from '../src/baseline.ts';
import type { RunResult } from '../src/results.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function newestRun(): string {
  const dir = join(pkg, 'test-results/runs');
  if (!existsSync(dir)) throw new Error('no runs in test-results/runs');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) throw new Error('no runs in test-results/runs');
  return files[0];
}

const writeFrom = arg('--write-baseline');
if (writeFrom) {
  const tolerance = Number(arg('--tolerance'));
  const source = arg('--source');
  if (!Number.isFinite(tolerance) || !source)
    throw new Error('--write-baseline needs --tolerance and --source');
  const run = JSON.parse(readFileSync(resolve(writeFrom), 'utf8')) as RunResult;
  const out = resolve(arg('--baseline') ?? join(pkg, `baseline/${run.profile.name}.json`));
  writeFileSync(
    out,
    `${JSON.stringify(baselineFrom(run, { default: tolerance, source }), null, 2)}\n`,
  );
  console.log(`baseline written to ${out}`);
} else {
  const positional = process.argv
    .slice(2)
    .find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--baseline');
  const runFile = positional ? resolve(positional) : newestRun();
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as RunResult;
  const baselineFile = resolve(arg('--baseline') ?? join(pkg, `baseline/${run.profile.name}.json`));
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline;
  const report = compareWithBaseline(run, baseline);
  console.log(
    `run ${run.runId} (${run.profile.name}, corpus ${run.corpus.version}) against ${baselineFile}`,
  );
  for (const c of report.compared)
    console.log(
      `${c.regressed ? 'REGRESSED' : 'ok       '} ${c.key}: ${c.value} against ${c.baseline} (${(c.worseBy * 100).toFixed(1)} % worse; tolerance ${(c.tolerance * 100).toFixed(0)} %)`,
    );
  for (const m of report.missing) console.log(`MISSING   ${m}`);
  for (const i of report.incompatible) console.log(`INCOMPATIBLE ${i}`);
  const breaches = budgetBreaches(run);
  for (const b of breaches)
    console.log(`OVER BUDGET ${b.key}: ${b.value} against a target of at most ${b.max}`);
  if (!report.ok || breaches.length > 0) process.exit(1);
}
