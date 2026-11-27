import { describe, expect, it } from 'vitest';
import {
  baselineFrom,
  compareWithBaseline,
  metricsOf,
  toleranceOf,
  type LatencyResult,
} from './latency-baseline.ts';

const IMAGE = 'localhost/docedit-export-worker:test';

function result(jobMs: number[], passes: number[][], image = IMAGE): LatencyResult {
  return {
    image,
    rows: jobMs.map((j, i) => ({
      doc: 's4-01p',
      profile: 'preview',
      state: 'completed',
      jobMs: j,
      metrics: { passMs: passes[i] ?? [] },
    })),
  };
}

describe('EXP-060 criterion 3: the latency baseline and its check', () => {
  it('reduces a result to the median job time and the median time of all passes', () => {
    const m = metricsOf(result([5000, 7000, 6000], [[4000], [5000, 1000], [4500]]));
    expect(m.get('s4-01p/preview/jobMs')).toBe(6000);
    expect(m.get('s4-01p/preview/passesMs')).toBe(4500);
  });

  it('ignores a run that did not complete', () => {
    const r = result([5000, 99_000], [[4000], [90_000]]);
    r.rows[1]!.state = 'failed';
    expect(metricsOf(r).get('s4-01p/preview/jobMs')).toBe(5000);
  });

  it('measures the tolerance as the spread, rounded up to 5 percent, never under 5', () => {
    expect(toleranceOf([100, 100, 100])).toBe(0.05);
    expect(toleranceOf([100, 101, 102])).toBe(0.05);
    // spread 12 over a median of 100 is 12 percent, so 15
    expect(toleranceOf([95, 100, 107])).toBe(0.15);
    expect(toleranceOf([90, 100, 110])).toBe(0.2);
  });

  it('writes a baseline from three runs and refuses fewer or mixed images', () => {
    const a = result([5000], [[4000]]);
    const b = result([5200], [[4200]]);
    const c = result([5100], [[4100]]);
    const base = baselineFrom([a, b, c], 'test');
    expect(base.metrics['s4-01p/preview/jobMs']).toEqual({ value: 5100, tolerance: 0.05 });
    expect(() => baselineFrom([a, b], 'test')).toThrow(/three/);
    expect(() => baselineFrom([a, b, result([5000], [[4000]], 'other')], 'test')).toThrow(/images/);
  });

  it('passes a result within the tolerance and a faster one', () => {
    const base = baselineFrom(
      [result([5000], [[4000]]), result([5000], [[4000]]), result([5000], [[4000]])],
      'test',
    );
    expect(compareWithBaseline(result([5200], [[4150]]), base).ok).toBe(true);
    expect(compareWithBaseline(result([3000], [[2000]]), base).ok).toBe(true);
  });

  it('fails a regression beyond the tolerance and names the metric', () => {
    const base = baselineFrom(
      [result([5000], [[4000]]), result([5000], [[4000]]), result([5000], [[4000]])],
      'test',
    );
    const report = compareWithBaseline(result([6000], [[4100]]), base);
    expect(report.ok).toBe(false);
    expect(report.compared.filter((c) => c.regressed).map((c) => c.key)).toEqual([
      's4-01p/preview/jobMs',
    ]);
  });

  it('fails when a baseline metric is missing or the image differs', () => {
    const base = baselineFrom(
      [result([5000], [[4000]]), result([5000], [[4000]]), result([5000], [[4000]])],
      'test',
    );
    expect(compareWithBaseline({ image: IMAGE, rows: [] }, base).missing).toHaveLength(2);
    const other = compareWithBaseline(result([5000], [[4000]], 'other'), base);
    expect(other.ok).toBe(false);
    expect(other.incompatible).toHaveLength(1);
  });
});
