/**
 * The result file of one harness run (FND-007): what was measured, on which machine, browser,
 * throttling profile and corpus version, and against which target. One JSON file per run, so a
 * scheduled job can keep them per commit and compare each with a baseline (`baseline.ts`).
 */
import type { CorpusStamp } from '@docedit/corpus';

export const RUN_SCHEMA = 'docedit-perf-run/1';

export type Unit = 'ms' | 'MB' | 'count' | 'ratio' | 'px';

export interface Target {
  /** The target from the spec; a measurement passes when it is at most this value. */
  readonly max: number;
  /** Where the target is written, for example "00 §9". */
  readonly source: string;
}

export interface Metric {
  /** Stable identifier, for example `typing.p95` or `tti`. */
  readonly id: string;
  /** The corpus document it ran on. */
  readonly document: string;
  /** The measured value; null when it could not be measured (see `note`). */
  readonly value: number | null;
  readonly unit: Unit;
  /** For a censored quantile: the value is below this bound and was not observed exactly. */
  readonly below?: number;
  readonly better: 'lower' | 'higher';
  readonly target?: Target;
  /** How it was measured. */
  readonly method: string;
  readonly note?: string;
  readonly samples?: number;
}

export interface MachineInfo {
  readonly cpu: string;
  readonly logicalProcessors: number;
  readonly memoryBytes: number;
  readonly os: string;
  readonly hostname: string;
}

export interface Profile {
  /** The name of the reference profile, or `custom`. */
  readonly name: string;
  /** `Emulation.setCPUThrottlingRate` (1 is no slowdown). */
  readonly cpuThrottlingRate: number;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly deviceScaleFactor: number;
  readonly headless: boolean;
}

export interface RunResult {
  readonly schema: typeof RUN_SCHEMA;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly machine: MachineInfo;
  readonly browser: { readonly name: string; readonly version: string };
  readonly profile: Profile;
  readonly corpus: CorpusStamp;
  /** The commit the run measured, when CI provides one. */
  readonly commit: string | null;
  readonly metrics: readonly Metric[];
}

/** Whether a metric meets its target; null when it has none or was not measured. */
export function meetsTarget(m: Metric): boolean | null {
  if (!m.target) return null;
  if (m.value === null) return m.below !== undefined ? m.below <= m.target.max : null;
  return m.value <= m.target.max;
}

export const metricKey = (m: Pick<Metric, 'id' | 'document'>): string => `${m.id}@${m.document}`;
