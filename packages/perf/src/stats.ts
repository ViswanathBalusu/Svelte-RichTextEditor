/** Summary statistics for the harness's samples. Percentiles use the nearest-rank method. */

export interface Summary {
  n: number;
  min: number;
  median: number;
  p95: number;
  max: number;
  mean: number;
}

/** The nearest-rank `q` quantile (0 < q ≤ 1) of ascending `sorted` values. */
export function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function summarise(values: readonly number[]): Summary {
  const s = [...values].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? Number.NaN,
    median: nearestRank(s, 0.5),
    p95: nearestRank(s, 0.95),
    max: s[s.length - 1] ?? Number.NaN,
    mean: s.length ? sum / s.length : Number.NaN,
  };
}

/**
 * A quantile of a sample whose small values were not observed: `total` events happened, but only
 * those of at least `threshold` were reported (`reported`), as with the Event Timing API, which
 * reports nothing below its 16 ms duration threshold. Returns the quantile when it falls among the
 * reported values, or `below: true` when it falls among the unreported ones and is therefore
 * smaller than `threshold`.
 */
export function censoredQuantile(
  reported: readonly number[],
  total: number,
  q: number,
  threshold: number,
): { value: number; below: boolean } {
  const desc = [...reported].sort((a, b) => b - a);
  // Nearest rank from the top: the quantile is the value with this many values at or above it.
  const fromTop = total - Math.max(1, Math.ceil(q * total)) + 1;
  if (fromTop <= desc.length && fromTop >= 1) return { value: desc[fromTop - 1]!, below: false };
  return { value: threshold, below: true };
}

/** Relative spread of repeated measurements: (max − min) / median. */
export function relativeSpread(values: readonly number[]): number {
  const s = summarise(values);
  return s.median ? (s.max - s.min) / s.median : Number.NaN;
}

/** A histogram with fixed-width bins, as `[lowerEdge, count]` pairs for the occupied bins. */
export function histogram(values: readonly number[], width: number): [number, number][] {
  const bins = new Map<number, number>();
  for (const v of values) {
    const edge = Math.floor(v / width) * width;
    const key = Math.round(edge * 1e6) / 1e6;
    bins.set(key, (bins.get(key) ?? 0) + 1);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]);
}
