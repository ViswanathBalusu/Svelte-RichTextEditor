/**
 * The store of performance results (FND-007 criterion 5; owner decision 103: a dedicated branch of
 * the repository). Pure functions: the store is a directory, `scripts/store-run.ts` reads and
 * writes it, and the scheduled job keeps that directory as the branch `perf-results`.
 *
 * Layout of the directory:
 *   runs/<commit>/<runId>.json   the full run result, as the harness wrote it
 *   index.json                   one entry per run, oldest first, with the metric values
 *
 * The index is what a trend reads: for one metric key and one profile, the values of successive
 * commits in the order the runs were stored.
 */
import { metricKey, type RunResult } from './results.ts';

export const INDEX_SCHEMA = 'docedit-perf-index/1';

/** The values of one run, without its detail. A metric the run did not measure is null. */
export interface IndexEntry {
  readonly runId: string;
  readonly commit: string;
  readonly startedAt: string;
  readonly profile: string;
  readonly corpusVersion: number;
  readonly browser: string;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface StoreIndex {
  readonly schema: typeof INDEX_SCHEMA;
  readonly entries: readonly IndexEntry[];
}

export interface TrendPoint {
  readonly commit: string;
  readonly startedAt: string;
  readonly value: number | null;
}

export const emptyIndex = (): StoreIndex => ({ schema: INDEX_SCHEMA, entries: [] });

/** A commit id or the word `unknown`, safe as a folder name. */
export function commitFolder(commit: string | null | undefined): string {
  const c = (commit ?? '').trim();
  return /^[0-9a-f]{7,64}$/u.test(c) ? c : 'unknown';
}

/** The path of a run's full result inside the store, with forward slashes. */
export function runPath(run: Pick<RunResult, 'runId' | 'commit'>): string {
  return `runs/${commitFolder(run.commit)}/${run.runId.replace(/[^A-Za-z0-9._-]/gu, '_')}.json`;
}

/** The index entry of a run. */
export function entryOf(run: RunResult, commitOverride?: string): IndexEntry {
  const metrics: Record<string, number | null> = {};
  for (const m of run.metrics) metrics[metricKey(m)] = m.value;
  return {
    runId: run.runId,
    commit: commitFolder(commitOverride ?? run.commit),
    startedAt: run.startedAt,
    profile: run.profile.name,
    corpusVersion: run.corpus.version,
    browser: `${run.browser.name} ${run.browser.version}`,
    metrics,
  };
}

/** The index with the entry added; an entry with the same run id replaces the earlier one. */
export function addEntry(index: StoreIndex, entry: IndexEntry): StoreIndex {
  const kept = index.entries.filter((e) => e.runId !== entry.runId);
  return { schema: INDEX_SCHEMA, entries: [...kept, entry] };
}

/** The values of one metric over the stored runs of one profile, in the order they were stored. */
export function trend(index: StoreIndex, key: string, profile: string): TrendPoint[] {
  return index.entries
    .filter((e) => e.profile === profile && key in e.metrics)
    .map((e) => ({ commit: e.commit, startedAt: e.startedAt, value: e.metrics[key] ?? null }));
}

/** The metric keys that any stored run of the profile measured, sorted. */
export function metricKeys(index: StoreIndex, profile: string): string[] {
  const keys = new Set<string>();
  for (const e of index.entries)
    if (e.profile === profile) for (const k of Object.keys(e.metrics)) keys.add(k);
  return [...keys].sort();
}
