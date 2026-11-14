/**
 * Run-to-run spread of the harness (FND-007 criterion 5; ADR 0037 §6). For each metric present in
 * every given run: the relative spread (max − min) / median, and the tolerance it implies, which
 * is the spread rounded up to the next 5 % (at least 5 %), and for the Event Timing quantiles at
 * least one step of the API's 8 ms rounding relative to the median. With `--write`, it writes a
 * baseline whose values are the medians of the runs, with these per-metric tolerances.
 *
 * Usage: node scripts/spread.ts run1.json run2.json run3.json [--write baseline/reference-1.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { baselineFrom } from '../src/baseline.ts';
import { metricKey, type Metric, type RunResult } from '../src/results.ts';
import { summarise } from '../src/stats.ts';

const args = process.argv.slice(2);
const writeAt = args.indexOf('--write');
const out = writeAt >= 0 ? args[writeAt + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith('--') && (writeAt < 0 || i !== writeAt + 1));
const runs = files.map((f) => JSON.parse(readFileSync(resolve(f), 'utf8')) as RunResult);
if (runs.length < 2) throw new Error('give at least two run files');

const value = (m: Metric): number | null => m.value ?? m.below ?? null;
const perMetric: Record<string, number> = {};
const medians = new Map<string, number>();
let widest = 0;
for (const key of runs[0]!.metrics.map(metricKey)) {
  const found = runs.map((r) => r.metrics.find((m) => metricKey(m) === key));
  const values = found.map((m) => (m ? value(m) : null));
  if (values.some((v) => v === null)) continue;
  const s = summarise(values as number[]);
  const spread = s.median ? (s.max - s.min) / s.median : 0;
  const floor = /typing\.p(50|95)@/.test(key) && s.median ? 8 / s.median : 0;
  const tolerance = Math.max(0.05, Math.ceil(Math.max(spread, floor) * 20 - 1e-9) / 20);
  perMetric[key] = tolerance;
  medians.set(key, s.median);
  widest = Math.max(widest, tolerance);
  console.log(
    `${key.padEnd(38)} ${(values as number[]).map((v) => v.toFixed(1).padStart(8)).join(' ')}  spread ${(spread * 100).toFixed(1).padStart(5)} %  tolerance ${(tolerance * 100).toFixed(0)} %`,
  );
}
if (out) {
  const last = runs[runs.length - 1]!;
  const median: RunResult = {
    ...last,
    runId: `median of ${runs.map((r) => r.runId).join(', ')}`,
    metrics: last.metrics
      .filter((m) => medians.has(metricKey(m)))
      .map((m) => ({ ...m, value: medians.get(metricKey(m))! })),
  };
  const source = `per-metric relative spread (max − min) / median over the runs ${runs.map((r) => r.runId).join(', ')} on the reference machine, rounded up to the next 5 % (at least 5 %, and at least one 8 ms Event Timing step for the typing quantiles); ADR 0037 §6. Measured on a shared machine: provisional until the scheduled job has a dedicated runner`;
  writeFileSync(
    resolve(out),
    `${JSON.stringify(baselineFrom(median, { default: widest, source, perMetric }), null, 2)}\n`,
  );
  console.log(`baseline written to ${out} (default tolerance ${(widest * 100).toFixed(0)} %)`);
}
