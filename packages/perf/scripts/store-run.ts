/**
 * Stores a harness result in the store of performance results, or prints a trend from it
 * (FND-007 criterion 5; decision 103: the store is the branch `perf-results`).
 *
 * Usage (from the repository root):
 *   node packages/perf/scripts/store-run.ts <store-dir> [run.json] [--commit <sha>]
 *   node packages/perf/scripts/store-run.ts <store-dir> --trend <metric key> [--profile reference-1]
 *
 * Without a run file it takes the newest file in packages/perf/test-results/runs. The commit is
 * the run's own `commit` field (the harness takes it from DOCEDIT_COMMIT), or --commit. The
 * script only reads and writes files; committing and pushing the directory is the job's step.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from '../src/results.ts';
import {
  addEntry,
  emptyIndex,
  entryOf,
  INDEX_SCHEMA,
  metricKeys,
  runPath,
  trend,
  type StoreIndex,
} from '../src/store.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const valueFlags = new Set(['--commit', '--trend', '--profile']);
const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith('--')) return false;
  return !valueFlags.has(all[i - 1] ?? '');
});
const storeDir = positional[0];
if (!storeDir) throw new Error('usage: store-run.ts <store-dir> [run.json] [--commit <sha>]');
const store = resolve(storeDir);
const indexFile = join(store, 'index.json');

function readIndex(): StoreIndex {
  if (!existsSync(indexFile)) return emptyIndex();
  const index = JSON.parse(readFileSync(indexFile, 'utf8')) as StoreIndex;
  if (index.schema !== INDEX_SCHEMA) throw new Error(`${indexFile} has the schema ${index.schema}`);
  return index;
}

function newestRun(): string {
  const dir = join(pkg, 'test-results/runs');
  if (!existsSync(dir)) throw new Error('no runs in packages/perf/test-results/runs');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) throw new Error('no runs in packages/perf/test-results/runs');
  return files[0];
}

const trendKey = arg('--trend');
if (trendKey) {
  const profile = arg('--profile') ?? 'reference-1';
  const points = trend(readIndex(), trendKey, profile);
  if (points.length === 0) {
    console.log(`no stored run of ${profile} measured ${trendKey}`);
    console.log(`known keys: ${metricKeys(readIndex(), profile).join(', ') || 'none'}`);
  }
  for (const p of points)
    console.log(`${p.startedAt}  ${p.commit.slice(0, 10)}  ${p.value ?? 'n/a'}`);
} else {
  const file = resolve(positional[1] ?? newestRun());
  const run = JSON.parse(readFileSync(file, 'utf8')) as RunResult;
  const commit = arg('--commit') ?? run.commit ?? undefined;
  const stored = { ...run, commit: commit ?? null } as RunResult;
  const target = join(store, runPath(stored));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(stored, null, 2)}\n`);
  const index = addEntry(readIndex(), entryOf(stored));
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  console.log(
    `stored ${run.runId} as ${runPath(stored)} (${index.entries.length} runs in the index)`,
  );
}
