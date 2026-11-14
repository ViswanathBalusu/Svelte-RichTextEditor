/**
 * The harness's statistics and the baseline comparison of the scheduled run (FND-007 criterion 5).
 */
import { corpusStamp } from '@docedit/corpus';
import { describe, expect, it } from 'vitest';
import { baselineFrom, compareWithBaseline, type Baseline } from '../src/baseline.ts';
import { REFERENCE_PROFILE } from '../src/reference.ts';
import { meetsTarget, RUN_SCHEMA, type Metric, type RunResult } from '../src/results.ts';
import {
  censoredQuantile,
  histogram,
  nearestRank,
  relativeSpread,
  summarise,
} from '../src/stats.ts';

describe('statistics', () => {
  it('takes nearest-rank quantiles', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(s, 0.5)).toBe(5);
    expect(nearestRank(s, 0.95)).toBe(10);
    expect(nearestRank([7], 0.5)).toBe(7);
    expect(Number.isNaN(nearestRank([], 0.5))).toBe(true);
    expect(summarise([3, 1, 2])).toMatchObject({ n: 3, min: 1, median: 2, max: 3, mean: 2 });
  });

  it('places a quantile among unreported values below the threshold', () => {
    // 100 keystrokes, 4 of them reported at or over 16 ms: the median is below 16 ms, and so is the
    // 95th percentile (rank 95 from the bottom is the 6th from the top, which was not reported).
    expect(censoredQuantile([24, 32, 16, 48], 100, 0.5, 16)).toEqual({ value: 16, below: true });
    expect(censoredQuantile([24, 32, 16, 48], 100, 0.95, 16)).toEqual({ value: 16, below: true });
    // 6 reported: the 95th percentile is the 6th largest.
    expect(censoredQuantile([24, 32, 16, 48, 40, 56], 100, 0.95, 16)).toEqual({
      value: 16,
      below: false,
    });
    // Everything reported: the ordinary nearest-rank quantile.
    const all = [16, 24, 32, 40, 48];
    expect(censoredQuantile(all, 5, 0.5, 16)).toEqual({
      value: nearestRank(all, 0.5),
      below: false,
    });
  });

  it('bins a histogram and measures spread', () => {
    expect(histogram([0.01, 0.04, 0.06, -0.01], 0.05)).toEqual([
      [-0.05, 1],
      [0, 2],
      [0.05, 1],
    ]);
    expect(relativeSpread([90, 100, 110])).toBeCloseTo(0.2);
  });
});

const metric = (
  id: string,
  value: number | null,
  better: 'lower' | 'higher' = 'lower',
  extra: Partial<Metric> = {},
): Metric => ({
  id,
  document: 'pages-100',
  value,
  unit: 'ms',
  better,
  method: 'test',
  ...extra,
});

const run = (metrics: Metric[], over: Partial<RunResult> = {}): RunResult => ({
  schema: RUN_SCHEMA,
  runId: 'r',
  startedAt: '2026-11-06T00:00:00Z',
  finishedAt: '2026-11-06T00:01:00Z',
  machine: { cpu: 'x', logicalProcessors: 1, memoryBytes: 1, os: 'x', hostname: 'x' },
  browser: { name: 'chromium', version: '158' },
  profile: REFERENCE_PROFILE,
  corpus: corpusStamp(),
  commit: null,
  metrics,
  ...over,
});

describe('baseline comparison', () => {
  const base = baselineFrom(
    run([metric('typing.p95', 40), metric('memory', 200), metric('score', 50, 'higher')]),
    {
      default: 0.1,
      source: 'test',
    },
  );

  it('passes within the tolerance and fails beyond it', () => {
    expect(
      compareWithBaseline(
        run([metric('typing.p95', 43.9), metric('memory', 210), metric('score', 46)]),
        base,
      ).ok,
    ).toBe(true);
    const bad = compareWithBaseline(
      run([metric('typing.p95', 44.5), metric('memory', 150), metric('score', 44)]),
      base,
    );
    expect(bad.ok).toBe(false);
    expect(bad.regressions.map((r) => r.key).sort()).toEqual([
      'score@pages-100',
      'typing.p95@pages-100',
    ]);
  });

  it('treats improvements as passing and a censored value as its bound', () => {
    const b = baselineFrom(run([metric('typing.p50', null, 'lower', { below: 16 })]), {
      default: 0.1,
      source: 'test',
    });
    expect(b.metrics['typing.p50@pages-100']).toEqual({ value: 16, better: 'lower' });
    expect(
      compareWithBaseline(run([metric('typing.p50', null, 'lower', { below: 16 })]), b).ok,
    ).toBe(true);
    expect(compareWithBaseline(run([metric('typing.p50', 18)]), b).ok).toBe(false);
    expect(compareWithBaseline(run([metric('typing.p50', 8)]), b).ok).toBe(true);
  });

  it('fails on missing metrics and on a different corpus version or profile', () => {
    const missing = compareWithBaseline(run([metric('typing.p95', 40)]), base);
    expect(missing.missing).toEqual(['memory@pages-100', 'score@pages-100']);
    expect(missing.ok).toBe(false);
    const other: Baseline = {
      ...base,
      corpusVersion: base.corpusVersion + 1,
      profile: 'custom-2x',
    };
    const same = run([
      metric('typing.p95', 40),
      metric('memory', 200),
      metric('score', 50, 'higher'),
    ]);
    expect(compareWithBaseline(same, other).incompatible).toHaveLength(2);
  });

  it('judges targets, including censored values', () => {
    expect(meetsTarget(metric('t', 15, 'lower', { target: { max: 16, source: '00 §9' } }))).toBe(
      true,
    );
    expect(meetsTarget(metric('t', 17, 'lower', { target: { max: 16, source: '00 §9' } }))).toBe(
      false,
    );
    expect(
      meetsTarget(metric('t', null, 'lower', { below: 16, target: { max: 16, source: '00 §9' } })),
    ).toBe(true);
    expect(meetsTarget(metric('t', 3))).toBeNull();
  });
});
