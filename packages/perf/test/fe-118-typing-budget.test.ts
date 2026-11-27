/**
 * The typing budget gate (FE-118 criterion 2), in Node.js: the scheduled run's comparison step
 * fails when the 95th percentile of keystroke to paint on 100 pages is over its 50 ms target. This
 * checks the decision (`budgetBreaches`); the CI job that calls it runs on the reference runner.
 */
import { corpusStamp } from '@docedit/corpus';
import { describe, expect, it } from 'vitest';
import { budgetBreaches, BUDGET_GATED_METRICS } from '../src/baseline.ts';
import { REFERENCE_PROFILE } from '../src/reference.ts';
import { RUN_SCHEMA, type Metric, type RunResult } from '../src/results.ts';

const p95 = (value: number | null, extra: Partial<Metric> = {}): Metric => ({
  id: 'typing.p95',
  document: 'pages-100',
  value,
  unit: 'ms',
  better: 'lower',
  target: { max: 50, source: '00 §9' },
  method: 'test',
  ...extra,
});

const run = (metrics: Metric[]): RunResult => ({
  schema: RUN_SCHEMA,
  runId: 'r',
  startedAt: '2026-11-27T00:00:00Z',
  finishedAt: '2026-11-27T00:01:00Z',
  machine: { cpu: 'x', logicalProcessors: 1, memoryBytes: 1, os: 'x', hostname: 'x' },
  browser: { name: 'chromium', version: '158' },
  profile: REFERENCE_PROFILE,
  corpus: corpusStamp(),
  commit: null,
  metrics,
});

describe('the typing budget gate (FE-118)', () => {
  it('gates the 95th percentile of typing on 100 pages', () => {
    expect(BUDGET_GATED_METRICS).toEqual(['typing.p95@pages-100']);
  });

  it('passes a 95th percentile within the budget, at the budget and censored below it', () => {
    expect(budgetBreaches(run([p95(40)]))).toEqual([]);
    expect(budgetBreaches(run([p95(50)]))).toEqual([]);
    expect(budgetBreaches(run([p95(null, { below: 16 })]))).toEqual([]);
  });

  it('fails a 95th percentile over the budget', () => {
    expect(budgetBreaches(run([p95(58)]))).toEqual([
      { key: 'typing.p95@pages-100', value: 58, max: 50 },
    ]);
  });

  it('fails when nothing was measured, so that a missing metric cannot pass the gate', () => {
    expect(budgetBreaches(run([])).map((b) => b.key)).toEqual(['typing.p95@pages-100']);
    expect(budgetBreaches(run([p95(null)])).map((b) => b.value)).toEqual([null]);
  });

  it('does not gate the median, which the baseline tolerance watches', () => {
    const median: Metric = { ...p95(40), id: 'typing.p50', target: { max: 16, source: '00 §9' } };
    expect(budgetBreaches(run([p95(40), median]))).toEqual([]);
  });
});
