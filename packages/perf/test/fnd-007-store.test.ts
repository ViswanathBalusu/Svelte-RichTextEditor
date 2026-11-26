/**
 * The store of performance results and the regression exit code (FND-007 criterion 5; decision
 * 103). The store is a directory; the scheduled job keeps it as the branch `perf-results`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusStamp } from '@docedit/corpus';
import { afterAll, describe, expect, it } from 'vitest';
import { baselineFrom } from '../src/baseline.ts';
import { REFERENCE_PROFILE } from '../src/reference.ts';
import { RUN_SCHEMA, type Metric, type RunResult } from '../src/results.ts';
import {
  addEntry,
  commitFolder,
  emptyIndex,
  entryOf,
  metricKeys,
  runPath,
  trend,
} from '../src/store.ts';

const metric = (id: string, value: number | null): Metric => ({
  id,
  document: 'pages-100',
  value,
  unit: 'ms',
  better: 'lower',
  method: 'test',
});

const run = (runId: string, commit: string | null, typing: number, at: string): RunResult => ({
  schema: RUN_SCHEMA,
  runId,
  startedAt: at,
  finishedAt: at,
  machine: { cpu: 'x', logicalProcessors: 1, memoryBytes: 1, os: 'x', hostname: 'x' },
  browser: { name: 'chromium', version: '158' },
  profile: REFERENCE_PROFILE,
  corpus: corpusStamp(),
  commit,
  metrics: [metric('typing.p95', typing), metric('memory', null)],
});

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('the pure store functions', () => {
  it('names the folder of a run by its commit, or unknown', () => {
    expect(commitFolder(A)).toBe(A);
    expect(commitFolder(null)).toBe('unknown');
    expect(commitFolder('../../etc')).toBe('unknown');
    expect(runPath(run('r 1/x', A, 1, '2026-11-26T00:00:00Z'))).toBe(`runs/${A}/r_1_x.json`);
  });

  it('keeps one entry per run and reads a trend in the order stored', () => {
    let index = emptyIndex();
    index = addEntry(index, entryOf(run('r1', A, 40, '2026-11-25T03:41:00Z')));
    index = addEntry(index, entryOf(run('r2', B, 44, '2026-11-26T03:41:00Z')));
    index = addEntry(index, entryOf(run('r2', B, 45, '2026-11-26T03:41:00Z')));
    expect(index.entries).toHaveLength(2);
    expect(
      trend(index, 'typing.p95@pages-100', 'reference-1').map((p) => [p.commit, p.value]),
    ).toEqual([
      [A, 40],
      [B, 45],
    ]);
    expect(trend(index, 'typing.p95@pages-100', 'other')).toEqual([]);
    expect(metricKeys(index, 'reference-1')).toEqual(['memory@pages-100', 'typing.p95@pages-100']);
    expect(trend(index, 'memory@pages-100', 'reference-1').map((p) => p.value)).toEqual([
      null,
      null,
    ]);
  });
});

describe('the scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fnd007-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
  const node = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8' });

  it('stores two runs of different commits and prints their trend', () => {
    const store = join(dir, 'store');
    for (const r of [
      run('r1', A, 40, '2026-11-25T03:41:00Z'),
      run('r2', null, 44, '2026-11-26T03:41:00Z'),
    ]) {
      const file = join(dir, `${r.runId}.json`);
      writeFileSync(file, JSON.stringify(r));
      const out = node('store-run.ts', store, file, ...(r.commit ? [] : ['--commit', B]));
      expect(out.status, out.stderr).toBe(0);
    }
    expect(existsSync(join(store, 'runs', A, 'r1.json'))).toBe(true);
    expect(existsSync(join(store, 'runs', B, 'r2.json'))).toBe(true);
    const index = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8'));
    expect(index.entries.map((e: { commit: string }) => e.commit)).toEqual([A, B]);
    const shown = node('store-run.ts', store, '--trend', 'typing.p95@pages-100');
    expect(shown.status, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`${A.slice(0, 10)}  40`);
    expect(shown.stdout).toContain(`${B.slice(0, 10)}  44`);
  });

  it('exits with 1 when a run is worse than the baseline beyond its tolerance, and with 0 inside it', () => {
    const base = join(dir, 'baseline.json');
    writeFileSync(
      base,
      JSON.stringify(
        baselineFrom(run('b', A, 40, '2026-11-25T00:00:00Z'), { default: 0.1, source: 'test' }),
      ),
    );
    const ok = join(dir, 'ok.json');
    const bad = join(dir, 'bad.json');
    writeFileSync(ok, JSON.stringify(run('ok', A, 42, '2026-11-26T00:00:00Z')));
    writeFileSync(bad, JSON.stringify(run('bad', A, 60, '2026-11-26T00:00:00Z')));
    expect(node('compare-baseline.ts', ok, '--baseline', base).status).toBe(0);
    const failing = node('compare-baseline.ts', bad, '--baseline', base);
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('REGRESSED');
  });
});
