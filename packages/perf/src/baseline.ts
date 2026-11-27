/**
 * Comparing a run with a baseline (FND-007 criterion 5). A baseline holds one value per metric and
 * a tolerance; a metric regresses when it is worse than the baseline by more than the tolerance,
 * relative to the baseline value. The tolerance is not chosen here: the baseline file carries it,
 * with the measurement it came from (ADR 0037).
 */
import { metricKey, type Metric, type RunResult } from './results.ts';

export const BASELINE_SCHEMA = 'docedit-perf-baseline/1';

export interface Baseline {
  readonly schema: typeof BASELINE_SCHEMA;
  /** The run the values were taken from. */
  readonly fromRun: string;
  readonly profile: string;
  readonly corpusVersion: number;
  /** Relative tolerance, and where it comes from. */
  readonly tolerance: {
    readonly default: number;
    readonly source: string;
    readonly perMetric?: Readonly<Record<string, number>>;
  };
  /** Metric key (`id@document`) to value and direction. */
  readonly metrics: Readonly<
    Record<string, { readonly value: number; readonly better: 'lower' | 'higher' }>
  >;
}

export interface Comparison {
  readonly key: string;
  readonly baseline: number;
  readonly value: number;
  /** (value − baseline) / baseline, signed so that positive is worse. */
  readonly worseBy: number;
  readonly tolerance: number;
  readonly regressed: boolean;
}

export interface ComparisonReport {
  readonly ok: boolean;
  readonly compared: readonly Comparison[];
  readonly regressions: readonly Comparison[];
  /** Baseline metrics the run does not have, or has without a value. */
  readonly missing: readonly string[];
  /** The run and the baseline used different corpus versions or profiles. */
  readonly incompatible: readonly string[];
}

export function compareWithBaseline(run: RunResult, baseline: Baseline): ComparisonReport {
  const incompatible: string[] = [];
  if (run.corpus.version !== baseline.corpusVersion)
    incompatible.push(`corpus version ${run.corpus.version}, baseline ${baseline.corpusVersion}`);
  if (run.profile.name !== baseline.profile)
    incompatible.push(`profile ${run.profile.name}, baseline ${baseline.profile}`);
  const byKey = new Map<string, Metric>(run.metrics.map((m) => [metricKey(m), m]));
  const compared: Comparison[] = [];
  const missing: string[] = [];
  for (const [key, base] of Object.entries(baseline.metrics)) {
    const m = byKey.get(key);
    // A censored value ("below 16 ms") counts as its bound: it cannot be worse than that.
    const value = m ? (m.value ?? m.below ?? null) : null;
    if (value === null) {
      missing.push(key);
      continue;
    }
    const tolerance = baseline.tolerance.perMetric?.[key] ?? baseline.tolerance.default;
    const delta = base.value === 0 ? 0 : (value - base.value) / base.value;
    const worseBy = base.better === 'lower' ? delta : -delta;
    compared.push({
      key,
      baseline: base.value,
      value,
      worseBy,
      tolerance,
      regressed: worseBy > tolerance,
    });
  }
  const regressions = compared.filter((c) => c.regressed);
  return {
    ok: regressions.length === 0 && missing.length === 0 && incompatible.length === 0,
    compared,
    regressions,
    missing,
    incompatible,
  };
}

/**
 * The metrics whose target is a budget that fails the build when it is exceeded, without regard to
 * the baseline (FE-118 criterion 2): the 95th percentile of keystroke to paint on 100 pages, which
 * the target of 00 §9 puts at 50 ms. The median target (16 ms) is reported, not gated: the
 * baseline's tolerance already stops it getting worse, and the recorded figure does not meet it yet.
 */
export const BUDGET_GATED_METRICS: readonly string[] = ['typing.p95@pages-100'];

export interface BudgetBreach {
  readonly key: string;
  /** The measured value, or the bound of a censored quantile. */
  readonly value: number;
  readonly max: number;
}

/**
 * The gated metrics that a run measured over their budget. A gated metric the run does not have, or
 * has without a value, is not listed here: when the baseline holds it, `compareWithBaseline` lists
 * it as missing and fails the comparison. A censored quantile ("below 16 ms") is within a budget
 * above its bound.
 */
export function budgetBreaches(
  run: RunResult,
  keys: readonly string[] = BUDGET_GATED_METRICS,
): BudgetBreach[] {
  const byKey = new Map<string, Metric>(run.metrics.map((m) => [metricKey(m), m]));
  const out: BudgetBreach[] = [];
  for (const key of keys) {
    const m = byKey.get(key);
    const max = m?.target?.max;
    const value = m ? (m.value ?? m.below ?? null) : null;
    if (max !== undefined && value !== null && value > max) out.push({ key, value, max });
  }
  return out;
}
/** A baseline from a run, with the given tolerance. */
export function baselineFrom(run: RunResult, tolerance: Baseline['tolerance']): Baseline {
  const metrics: Record<string, { value: number; better: 'lower' | 'higher' }> = {};
  for (const m of run.metrics) {
    const v = m.value ?? m.below;
    if (v !== undefined && v !== null) metrics[metricKey(m)] = { value: v, better: m.better };
  }
  return {
    schema: BASELINE_SCHEMA,
    fromRun: run.runId,
    profile: run.profile.name,
    corpusVersion: run.corpus.version,
    tolerance,
    metrics,
  };
}
