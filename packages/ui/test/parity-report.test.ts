/**
 * The parity report as a release artefact (UX-002): criterion 1, every row of the published profile
 * has one of the four states in the generated files; criterion 2, a shipped row links to automated
 * tests that exist, and the report is refused otherwise; criterion 3, a row of the tier "through
 * ports and extensions" names its demonstrator or says none exists; criterion 4, the report states
 * that it is judged by capability only, and nothing but story progress moves a state.
 *
 * The last block runs the script itself (`scripts/parity-report.ts`) on this repository, into a
 * temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PROFILE, PROFILE_VERSION, type ProfileRow } from '../src/parity/profile.ts';
import {
  JUDGED_BY,
  REPORT_JSON,
  REPORT_MARKDOWN,
  buildParityReport,
  type ReportInput,
} from '../src/parity/report.ts';
import type { StoryProgress } from '../src/parity/status.ts';
import { ROW_TESTS, isTestFile, type TestLink } from '../src/parity/tests.ts';
import { parityReportFor } from '../scripts/parity-report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const row = (id: string, over: Partial<ProfileRow> = {}): ProfileRow => ({
  id,
  tier: 'built-in',
  can: `Do ${id}.`,
  items: [],
  spec: '13 §2',
  stories: ['UX-900'],
  ...over,
});
const story = (id: string, ticked: number, total: number, phase = '1b'): StoryProgress => ({
  id,
  phase,
  ticked,
  total,
});
const input = (over: Partial<ReportInput>): ReportInput => ({
  rows: [row('a')],
  progress: new Map([['UX-900', story('UX-900', 2, 2)]]),
  tests: new Map<string, readonly TestLink[]>([
    ['a', [{ path: 'packages/x/e2e/a.spec.ts', kind: 'playwright' }]],
  ]),
  exists: () => true,
  release: '0.0.0-test',
  date: '2026-11-15',
  profileVersion: 1,
  ...over,
});

describe('UX-002: the report of a release', () => {
  it('gives every row one of the four states, with the phase of a planned row', () => {
    const r = buildParityReport(
      input({
        rows: [
          row('done'),
          row('half', { stories: ['UX-901'] }),
          row('later', { stories: ['UX-902'] }),
          row('never', { tier: 'non-goal', stories: [] }),
        ],
        progress: new Map([
          ['UX-900', story('UX-900', 2, 2)],
          ['UX-901', story('UX-901', 1, 3)],
          ['UX-902', story('UX-902', 0, 3, '2')],
        ]),
        tests: new Map([['done', [{ path: 'packages/x/test/done.test.ts', kind: 'unit' }]]]),
      }),
    );
    expect(r.problems).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual([
      { state: 'shipped' },
      { state: 'partial' },
      { state: 'planned', phase: '2' },
      { state: 'not-planned' },
    ]);
    expect(r.counts).toEqual({ shipped: 1, partial: 1, planned: 1, 'not-planned': 1 });
    const md = r.artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    expect(md).toContain('| shipped |');
    expect(md).toContain('| partial |');
    expect(md).toContain('| planned (phase 2) |');
    expect(md).toContain('| not planned |');
  });

  it('links a shipped row to its automated tests, in both artefacts', () => {
    const r = buildParityReport(input({}));
    expect(r.problems).toEqual([]);
    expect(r.rows[0]!.tests).toEqual([{ path: 'packages/x/e2e/a.spec.ts', kind: 'playwright' }]);
    const md = r.artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    expect(md).toContain('[`packages/x/e2e/a.spec.ts`](packages/x/e2e/a.spec.ts) (playwright)');
    const json = JSON.parse(r.artifacts.find((a) => a.path === REPORT_JSON)!.text) as {
      rows: Array<{ tests?: TestLink[] }>;
    };
    expect(json.rows[0]!.tests?.[0]?.path).toBe('packages/x/e2e/a.spec.ts');
  });

  it('refuses a shipped row with no test, a missing file, or a screenshot', () => {
    expect(buildParityReport(input({ tests: new Map() })).problems).toEqual([
      'row "a" is shipped but links to no automated test (packages/ui/src/parity/tests.ts)',
    ]);
    expect(buildParityReport(input({ exists: () => false })).problems).toEqual([
      'row "a" links to packages/x/e2e/a.spec.ts, which does not exist',
    ]);
    const shot = new Map<string, readonly TestLink[]>([
      ['a', [{ path: 'packages/x/e2e/a.spec.ts-snapshots/a.png', kind: 'playwright' }]],
    ]);
    expect(buildParityReport(input({ tests: shot })).problems).toEqual([
      'row "a" links to packages/x/e2e/a.spec.ts-snapshots/a.png, which is not a test file',
    ]);
    expect(isTestFile('a.png')).toBe(false);
    expect(isTestFile('packages/x/test/a.test.ts')).toBe(true);
  });

  it('gives no test links to a row that is not shipped, whatever the table says', () => {
    const r = buildParityReport(input({ progress: new Map([['UX-900', story('UX-900', 1, 2)]]) }));
    expect(r.rows[0]!.status).toEqual({ state: 'partial' });
    expect(r.rows[0]!.tests).toBeUndefined();
  });

  it('states that it is judged by capability only, and only story progress moves a state', () => {
    const base = input({});
    const r = buildParityReport(base);
    for (const a of r.artifacts) expect(a.text).toContain(JUDGED_BY.slice(0, 40));
    // The same stories give the same states, whatever else differs in the input.
    const other = buildParityReport({
      ...base,
      rows: base.rows.map((x) => ({ ...x, can: 'Looks finished.' })),
      release: '9.9.9',
      date: '2030-01-01',
    });
    expect(other.rows.map((x) => x.status)).toEqual(r.rows.map((x) => x.status));
  });
});

describe('UX-002: the report of this repository', () => {
  const report = parityReportFor(root, '0.0.0-test', '2026-11-15');

  it('passes its checks and covers every row of the profile', () => {
    expect(report.problems).toEqual([]);
    expect(report.rows.map((r) => r.id)).toEqual(PROFILE.map((r) => r.id));
    for (const r of report.rows)
      expect(['shipped', 'partial', 'planned', 'not-planned']).toContain(r.status.state);
  });

  it('links every shipped row to test files that exist', () => {
    for (const r of report.rows.filter((x) => x.status.state === 'shipped')) {
      expect(r.tests?.length, r.id).toBeGreaterThan(0);
      for (const t of r.tests ?? []) {
        expect(isTestFile(t.path), t.path).toBe(true);
        expect(existsSync(join(root, t.path)), t.path).toBe(true);
      }
    }
  });

  it('has no entry in the test table for a row the profile does not have', () => {
    const ids = new Set(PROFILE.map((r) => r.id));
    for (const id of ROW_TESTS.keys()) expect(ids.has(id), id).toBe(true);
  });

  it('names a demonstrator, or says none exists, on every ports-and-extensions row', () => {
    const rows = report.rows.filter((r) => r.tier === 'ports-and-extensions');
    expect(rows.length).toBeGreaterThan(0);
    const md = report.artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    for (const r of rows) {
      expect(r.demonstrator, r.id).toBeDefined();
      const line = md.split('\n').find((l) => l.includes(`(\`${r.id}\`)`))!;
      expect(line).toMatch(/No port or reference extension demonstrates it|Demonstrated by the/);
    }
  });
});

describe('UX-002: the script', () => {
  const out = mkdtempSync(join(tmpdir(), 'docedit-parity-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('writes both files for a release into the directory it is given', () => {
    const script = join(root, 'packages/ui/scripts/parity-report.ts');
    const stdout = execFileSync(
      process.execPath,
      [script, '--release', '0.1.0-rc.1', '--date', '2026-11-15', '--out', out],
      { encoding: 'utf8' },
    );
    expect(stdout).toContain('parity report:');
    const md = readFileSync(join(out, REPORT_MARKDOWN), 'utf8');
    expect(md).toContain('# Parity report, release 0.1.0-rc.1');
    const json = JSON.parse(readFileSync(join(out, REPORT_JSON), 'utf8')) as {
      release: string;
      profileVersion: number;
      rows: unknown[];
    };
    expect(json.release).toBe('0.1.0-rc.1');
    expect(json.profileVersion).toBe(PROFILE_VERSION);
    expect(json.rows.length).toBe(PROFILE.length);
  });

  it('exits with 2 when no release is named', () => {
    const script = join(root, 'packages/ui/scripts/parity-report.ts');
    let status = 0;
    try {
      execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
