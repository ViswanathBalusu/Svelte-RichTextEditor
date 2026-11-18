// The accessibility conformance report (UX-069): the table covers every criterion of level A and AA,
// the report refuses to build on an inconsistent table, and it draws on the axe results, the manual
// logs and the known issues.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { conformanceReportFor, readStoryIds } from '../scripts/a11y-report.ts';
import { CRITERIA, type Criterion } from '../src/a11y-report/criteria.ts';
import { KNOWN_ISSUES } from '../src/a11y-report/known-issues.ts';
import {
  EXPECTED_COUNTS,
  REPORT_JSON,
  REPORT_MARKDOWN,
  buildConformanceReport,
  checkReport,
  type AxeRecord,
  type ManualLog,
  type ReportInput,
} from '../src/a11y-report/report.ts';

const root = resolve(import.meta.dirname, '../../..');
const exists = (p: string) => existsSync(join(root, p)) && statSync(join(root, p)).isFile();
const storyIds = readStoryIds(root);

const base: ReportInput = {
  release: '0.0.1',
  date: '2026-11-17',
  exists,
  storyIds,
  axe: [],
  manualLogs: [],
};

const AXE: AxeRecord[] = [
  { browser: 'chromium', version: '140.0', test: 'shell > full toolbar', violations: 0, rules: [] },
  { browser: 'firefox', version: '141.0', test: 'shell > full toolbar', violations: 0, rules: [] },
  { browser: 'webkit', version: '26.0', test: 'shell > full toolbar', violations: 0, rules: [] },
];
const LOG: ManualLog = {
  date: '2026-12-01',
  at: { name: 'NVDA', version: '2026.1' },
  browser: 'Firefox 140',
  os: 'Windows 11',
  flows: [
    { name: 'Fix an issue from the checker', result: 'issues', issues: [KNOWN_ISSUES[4]!.id] },
  ],
};

describe('the table of criteria', () => {
  it('has every WCAG 2.2 and ATAG 2.0 criterion of level A and AA, once each', () => {
    const count = (standard: string, level: string) =>
      CRITERIA.filter((c) => c.standard === standard && c.level === level).length;
    expect(count('WCAG 2.2', 'A')).toBe(EXPECTED_COUNTS['WCAG 2.2'].A);
    expect(count('WCAG 2.2', 'AA')).toBe(EXPECTED_COUNTS['WCAG 2.2'].AA);
    expect(count('ATAG 2.0', 'A')).toBe(EXPECTED_COUNTS['ATAG 2.0'].A);
    expect(count('ATAG 2.0', 'AA')).toBe(EXPECTED_COUNTS['ATAG 2.0'].AA);
    expect(new Set(CRITERIA.map((c) => `${c.standard} ${c.id}`)).size).toBe(CRITERIA.length);
  });

  it('lists the WCAG 2.2 criteria that WCAG 2.1 does not have, and not the one it removed', () => {
    const ids = CRITERIA.filter((c) => c.standard === 'WCAG 2.2').map((c) => c.id);
    for (const id of ['2.4.11', '2.5.7', '2.5.8', '3.2.6', '3.3.7', '3.3.8'])
      expect(ids).toContain(id);
    expect(ids).not.toContain('4.1.1');
  });

  it('passes its own checks against the repository', () => {
    expect(checkReport(base)).toEqual([]);
  });
});

describe('the report', () => {
  it('states a status, notes and tests for each criterion, and names no assistive technology it did not use', () => {
    const r = buildConformanceReport(base);
    expect(r.problems).toEqual([]);
    const md = r.artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    for (const c of CRITERIA)
      expect(md).toContain(`| ${c.id} | ${c.level} | ${c.title.replace(/\|/g, '\\|')} |`);
    expect(md).toContain('does not claim that the product conforms');
    expect(md).toContain('Assistive technologies tested: none');
    expect(md).toContain('No axe results were supplied');
    const json = JSON.parse(r.artifacts.find((a) => a.path === REPORT_JSON)!.text);
    expect(json.criteria).toHaveLength(CRITERIA.length);
    expect(Object.values(r.counts).reduce((x, y) => x + y, 0)).toBe(CRITERIA.length);
  });

  it('draws on the axe results, the manual logs and the known issues, and names browsers and technology', () => {
    const r = buildConformanceReport({ ...base, axe: AXE, manualLogs: [LOG] });
    expect(r.problems).toEqual([]);
    const md = r.artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    expect(md).toContain('| chromium | 140.0 | 1 | 0 |');
    expect(md).toContain('| firefox | 141.0 | 1 | 0 |');
    expect(md).toContain('| webkit | 26.0 | 1 | 0 |');
    expect(md).toContain('NVDA 2026.1 with Firefox 140 on Windows 11');
    expect(md).toContain('Fix an issue from the checker');
    for (const i of KNOWN_ISSUES) expect(md).toContain(`| ${i.id} |`);
    expect(md).not.toContain('Assistive technologies tested: none');
  });

  it('covers the checker under ATAG 2.0 part B, with its tests', () => {
    const md = buildConformanceReport(base).artifacts.find((a) => a.path === REPORT_MARKDOWN)!.text;
    const b31 = md.split('\n').find((l) => l.startsWith('| B.3.1.2 |'))!;
    expect(b31).toContain('Supported');
    expect(b31).toContain('packages/ui/test/accessibility-check.test.ts');
    expect(md).toContain('accessibility checker (UX-066, UX-067)');
  });

  it('fails on a new axe violation that no known issue lists, and passes when one does', () => {
    const bad: AxeRecord = {
      browser: 'chromium',
      version: '140.0',
      test: 'shell > dialog',
      violations: 1,
      rules: ['aria-required-attr'],
    };
    expect(buildConformanceReport({ ...base, axe: [bad] }).problems).toEqual([
      'axe reports aria-required-attr in "shell > dialog" (chromium), which no known issue lists',
    ]);
    const listed = KNOWN_ISSUES.map((i, n) =>
      n === 0 ? { ...i, axeRules: ['aria-required-attr'] } : i,
    );
    expect(
      buildConformanceReport({ ...base, axe: [bad], issues: listed, criteria: CRITERIA }).problems,
    ).toEqual([]);
  });
});

describe('the checks refuse an inconsistent table', () => {
  const one = (patch: Partial<Criterion>): ReportInput => ({
    ...base,
    criteria: [{ ...CRITERIA.find((c) => c.id === '1.4.4')!, ...patch }],
  });
  it('a row that names a missing test file', () => {
    expect(checkReport(one({ evidence: ['packages/ui/test/no-such.test.ts'] }))).toContain(
      'WCAG 2.2 1.4.4 names packages/ui/test/no-such.test.ts, which is not a file',
    );
  });
  it('a supported row with no test, and a basis on a row that was not evaluated', () => {
    expect(checkReport(one({ status: 'supported', evidence: [] }))).toContain(
      'WCAG 2.2 1.4.4 is supported with no test behind it',
    );
    expect(checkReport(one({ status: 'not-evaluated', basis: 'automated' }))).toContain(
      'WCAG 2.2 1.4.4 is not-evaluated but has a basis',
    );
  });
  it('a partly supported row that no known issue lists', () => {
    expect(checkReport({ ...one({}), issues: [] })).toContain(
      'WCAG 2.2 1.4.4 is partly and no known issue lists it',
    );
  });
  it('a known issue without a tracking item that is a story, or naming an unknown criterion', () => {
    const p = checkReport({
      ...base,
      issues: [{ id: 'KI-900', criteria: ['9.9.9'], summary: 'x', tracking: 'soon' }],
    });
    expect(p).toContain('known issue KI-900 names 9.9.9, which is not a criterion');
    expect(p).toContain('known issue KI-900 has no tracking item that is a story (soon)');
  });
  it('every tracking item of the real issues is a story that stands', () => {
    for (const i of KNOWN_ISSUES) expect(storyIds.has(i.tracking.split(' ')[0]!)).toBe(true);
  });
  it('a manual log that names an unknown issue or records no flow', () => {
    const p = checkReport({
      ...base,
      manualLogs: [
        { ...LOG, flows: [{ name: 'f', result: 'issues', issues: ['KI-404'] }] },
        { ...LOG, date: '2026-12-02', flows: [] },
      ],
    });
    expect(p).toContain(
      'manual log of 2026-12-01 (NVDA): flow "f" names KI-404, which is not a known issue',
    );
    expect(p).toContain('manual log of 2026-12-02 (NVDA) records no flow');
  });
});

describe('the script', () => {
  it('writes both artefacts and reads the axe records the browser tests write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docedit-a11y-'));
    try {
      const axeFile = join(dir, 'axe.jsonl');
      const lines = AXE.map((r) => JSON.stringify(r)).join('\n');
      writeFileSync(axeFile, `${lines}\n`);
      const out = join(dir, 'out');
      const run = spawnSync(
        process.execPath,
        [
          join(root, 'packages/ui/scripts/a11y-report.ts'),
          '--release',
          '0.0.1',
          '--date',
          '2026-11-17',
          '--out',
          out,
          '--axe',
          axeFile,
        ],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      const md = readFileSync(join(out, REPORT_MARKDOWN), 'utf8');
      expect(md).toContain('| webkit | 26.0 | 1 | 0 |');
      expect(existsSync(join(out, REPORT_JSON))).toBe(true);
      const real = conformanceReportFor(root, '0.0.1', '2026-11-17');
      expect(real.problems).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
