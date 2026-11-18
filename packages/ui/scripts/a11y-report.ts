/**
 * Writes the accessibility conformance report of a release (UX-069): `ACCESSIBILITY-CONFORMANCE-REPORT.md`
 * and `accessibility-conformance-report.json`.
 *
 *   node packages/ui/scripts/a11y-report.ts --release <version> [--out <dir>] [--date YYYY-MM-DD]
 *        [--axe <axe-results.jsonl>]
 *
 * `--axe` is the file the browser tests write when `DOCEDIT_AXE_RESULTS` names it (one JSON record
 * per line, see `AxeRecord`). The manual logs are read from `docs/accessibility/manual-logs`.
 * `--out` defaults to `dist/a11y` under the repository root; the release script passes the
 * directory of the release notes. Exits with 1 and writes nothing while a check fails.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildConformanceReport,
  type AxeRecord,
  type ManualLog,
  type ReportResult,
} from '../src/a11y-report/report.ts';

const NOT_EPICS = /^(README|BACKLOG|PLAN-.*|PROGRESS|TRACEABILITY)\.md$/;

export function readStoryIds(root: string): Set<string> {
  const dir = join(root, 'docs', 'stories');
  const ids = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || NOT_EPICS.test(name)) continue;
    for (const m of readFileSync(join(dir, name), 'utf8').matchAll(/^### ([A-Z]{2,4}-\d{3})\b/gm))
      ids.add(m[1]!);
  }
  return ids;
}

export function readManualLogs(root: string): ManualLog[] {
  const dir = join(root, 'docs', 'accessibility', 'manual-logs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')) as ManualLog);
}

export function readAxeRecords(file: string): AxeRecord[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AxeRecord);
}

export function conformanceReportFor(
  root: string,
  release: string,
  date: string,
  axeFile?: string,
): ReportResult {
  return buildConformanceReport({
    release,
    date,
    exists: (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile(),
    storyIds: readStoryIds(root),
    axe: axeFile ? readAxeRecords(axeFile) : [],
    manualLogs: readManualLogs(root),
  });
}

function main(argv: readonly string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const release = arg('--release');
  if (!release) {
    console.error(
      'usage: a11y-report.ts --release <version> [--out <dir>] [--date YYYY-MM-DD] [--axe <file>]',
    );
    return 2;
  }
  const out = resolve(arg('--out') ?? join(root, 'dist', 'a11y'));
  const axeFile = arg('--axe');
  const result = conformanceReportFor(
    root,
    release,
    arg('--date') ?? new Date().toISOString().slice(0, 10),
    axeFile ? resolve(axeFile) : undefined,
  );
  if (result.problems.length) {
    console.error(
      `The accessibility conformance report fails its checks (${result.problems.length}):`,
    );
    for (const p of result.problems) console.error(`  - ${p}`);
    return 1;
  }
  mkdirSync(out, { recursive: true });
  for (const a of result.artifacts) {
    writeFileSync(join(out, a.path), a.text, 'utf8');
    console.log(`wrote ${join(out, a.path)}`);
  }
  const c = result.counts;
  console.log(
    `accessibility report: supported ${c.supported}, partly ${c.partly}, not supported ${c['not-supported']}, not applicable ${c['not-applicable']}, not evaluated ${c['not-evaluated']}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
