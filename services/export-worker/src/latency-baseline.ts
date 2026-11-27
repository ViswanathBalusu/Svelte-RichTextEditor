/**
 * The export latency baseline and its regression check (EXP-060 criterion 3).
 *
 * `scripts/latency.ts` writes `results.json`: one row per document, profile and run, with the
 * job's time and the worker's stage times. This module reduces such a file to a few metrics (the
 * median job time and the median time of all passes, per document and profile), writes a
 * baseline from three or more consecutive result files, and compares a new result with it.
 *
 * The tolerance is not chosen. As in ADR 0037 section 6 it is measured: the spread of a metric
 * across the consecutive runs (maximum minus minimum, over the median), rounded up to the next
 * 5 percent and never under 5 percent. The baseline records where it came from.
 *
 * A compile that got faster is never a failure. A metric that is missing from the new result, or
 * a result taken with another image or class version than the baseline's, is reported and fails
 * the check, because the two cannot be compared.
 */

/** One row of `results.json`, reduced to what the baseline reads. */
export interface LatencyRow {
  doc: string;
  profile: string;
  state: string;
  jobMs: number;
  metrics: { passMs: number[] } | null;
}

export interface LatencyResult {
  image: string;
  rows: LatencyRow[];
}

export interface BaselineMetric {
  value: number;
  tolerance: number;
}

export interface LatencyBaseline {
  version: 1;
  image: string;
  /** Where the tolerances come from: the machine, the number of runs, the date. */
  source: string;
  /** Milliseconds, keyed `<document>/<profile>/<jobMs|passesMs>`. */
  metrics: Record<string, BaselineMetric>;
}

export interface Comparison {
  key: string;
  value: number;
  baseline: number;
  /** Relative change against the baseline; positive is slower. */
  worseBy: number;
  tolerance: number;
  regressed: boolean;
}

export interface LatencyReport {
  ok: boolean;
  compared: Comparison[];
  missing: string[];
  incompatible: string[];
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The medians of one result file, over its completed rows only. */
export function metricsOf(result: LatencyResult): Map<string, number> {
  const groups = new Map<string, LatencyRow[]>();
  for (const r of result.rows) {
    if (r.state !== 'completed' || r.metrics === null) continue;
    const key = `${r.doc}/${r.profile}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = new Map<string, number>();
  for (const [key, rows] of groups) {
    out.set(`${key}/jobMs`, median(rows.map((r) => r.jobMs)));
    out.set(
      `${key}/passesMs`,
      median(rows.map((r) => r.metrics!.passMs.reduce((a, b) => a + b, 0))),
    );
  }
  return out;
}

/** The measured tolerance: the relative spread, rounded up to the next 5 percent, at least 5. */
export function toleranceOf(values: readonly number[]): number {
  const med = median(values);
  if (!(med > 0) || values.length < 2) return 0.05;
  const spread = (Math.max(...values) - Math.min(...values)) / med;
  return Math.max(0.05, Math.ceil(spread * 20 - 1e-9) / 20);
}

/** A baseline from three or more consecutive result files of one image. */
export function baselineFrom(results: readonly LatencyResult[], source: string): LatencyBaseline {
  if (results.length < 3) throw new Error('a baseline needs at least three consecutive runs');
  const image = results[0]!.image;
  if (results.some((r) => r.image !== image)) throw new Error('the runs used different images');
  const per = results.map(metricsOf);
  const metrics: Record<string, BaselineMetric> = {};
  for (const key of [...per[0]!.keys()].sort()) {
    const values = per.map((m) => m.get(key));
    if (values.some((v) => v === undefined || Number.isNaN(v))) continue;
    const vs = values as number[];
    metrics[key] = { value: Math.round(median(vs)), tolerance: toleranceOf(vs) };
  }
  return { version: 1, image, source, metrics };
}

/** Compares a result with the baseline. A slower metric beyond its tolerance fails. */
export function compareWithBaseline(
  result: LatencyResult,
  baseline: LatencyBaseline,
): LatencyReport {
  const now = metricsOf(result);
  const compared: Comparison[] = [];
  const missing: string[] = [];
  const incompatible: string[] = [];
  if (result.image !== baseline.image)
    incompatible.push(`image ${result.image} differs from the baseline's ${baseline.image}`);
  for (const [key, b] of Object.entries(baseline.metrics)) {
    const value = now.get(key);
    if (value === undefined || Number.isNaN(value)) {
      missing.push(key);
      continue;
    }
    const worseBy = (value - b.value) / b.value;
    compared.push({
      key,
      value,
      baseline: b.value,
      worseBy,
      tolerance: b.tolerance,
      regressed: worseBy > b.tolerance,
    });
  }
  return {
    ok: incompatible.length === 0 && missing.length === 0 && compared.every((c) => !c.regressed),
    compared,
    missing,
    incompatible,
  };
}
