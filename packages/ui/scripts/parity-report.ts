/**
 * Writes the parity report of a release (UX-002): `PARITY-REPORT.md` and `parity-report.json`.
 *
 *   node packages/ui/scripts/parity-report.ts --release <version> [--out <dir>] [--date YYYY-MM-DD]
 *
 * `--out` defaults to `dist/parity` under the repository root. The release script passes the
 * directory of the release notes, so the report is published with them. Refuses to write, and exits
 * with 1, while a check fails: a shipped row that links to no automated test or to a missing file,
 * a row that names an unknown story, or a "through ports and extensions" row with no demonstrator
 * entry.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, PROFILE_VERSION } from '../src/parity/profile.ts';
import { buildParityReport, type ReportResult } from '../src/parity/report.ts';
import { parseCriteria } from '../src/parity/status.ts';
import { ROW_TESTS } from '../src/parity/tests.ts';

/** Files of docs/stories that hold no stories. */
const NOT_EPICS = /^(README|BACKLOG|PLAN-.*|PROGRESS|TRACEABILITY)\.md$/;

export function parityReportFor(root: string, release: string, date: string): ReportResult {
  const storiesDir = join(root, 'docs', 'stories');
  const files = readdirSync(storiesDir)
    .filter((name) => name.endsWith('.md') && !NOT_EPICS.test(name))
    .sort()
    .map((name) => ({ text: readFileSync(join(storiesDir, name), 'utf8').replace(/\r\n/g, '\n') }));
  return buildParityReport({
    rows: PROFILE,
    progress: parseCriteria(files),
    tests: ROW_TESTS,
    exists: (path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile(),
    release,
    date,
    profileVersion: PROFILE_VERSION,
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
    console.error('usage: parity-report.ts --release <version> [--out <dir>] [--date YYYY-MM-DD]');
    return 2;
  }
  const out = resolve(arg('--out') ?? join(root, 'dist', 'parity'));
  const result = parityReportFor(
    root,
    release,
    arg('--date') ?? new Date().toISOString().slice(0, 10),
  );
  if (result.problems.length) {
    console.error(`The parity report fails its checks (${result.problems.length}):`);
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
    `parity report: ${result.rows.length} rows; shipped ${c.shipped}, partial ${c.partial}, planned ${c.planned}, not planned ${c['not-planned']}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
