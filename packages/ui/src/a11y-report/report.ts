/**
 * The accessibility conformance report of a release (UX-069; 13 §8) as a release artefact. For each
 * WCAG 2.2 and ATAG 2.0 criterion of level A and AA it states whether the product supports it,
 * supports it in part, does not, or has nothing the criterion is about (`criteria.ts`), with notes
 * and the tests behind the statement. It draws on three inputs: the axe results of the release's
 * browser run, the manual screen-reader logs, and the list of known issues (`known-issues.ts`).
 * Pure: the script reads the files and passes them in.
 *
 * The report refuses to build (`problems` is not empty) when a criterion is missing, listed twice
 * or not at level A or AA, when a row names a test file that does not exist, when a `supported` or
 * `partly` row has no test behind it, when a `partly` or `not-supported` row has no known issue
 * with a tracking item, when axe reports a violation that no known issue lists, or when a manual
 * log is malformed or names an unknown issue.
 */
import { CRITERIA, type Criterion, type Status } from './criteria.ts';
import { KNOWN_ISSUES, type KnownIssue } from './known-issues.ts';

export const REPORT_MARKDOWN = 'ACCESSIBILITY-CONFORMANCE-REPORT.md';
export const REPORT_JSON = 'accessibility-conformance-report.json';

/** The criteria the report must cover: WCAG 2.2 level A and AA (55), ATAG 2.0 level A and AA (52). */
export const EXPECTED_COUNTS = { 'WCAG 2.2': { A: 31, AA: 24 }, 'ATAG 2.0': { A: 37, AA: 15 } };

/** One run of axe, recorded by the browser tests when `DOCEDIT_AXE_RESULTS` names a file. */
export interface AxeRecord {
  readonly browser: string;
  readonly version: string;
  readonly test: string;
  readonly violations: number;
  /** The axe rules that were violated. */
  readonly rules: readonly string[];
}

/** A manual pass with assistive technology, one JSON file in `docs/accessibility/manual-logs`. */
export interface ManualLog {
  readonly date: string;
  readonly release?: string;
  readonly at: { readonly name: string; readonly version: string };
  readonly browser: string;
  readonly os: string;
  readonly flows: readonly {
    readonly name: string;
    readonly result: 'pass' | 'issues';
    /** Ids of known issues. */
    readonly issues: readonly string[];
  }[];
}

export interface ReportInput {
  readonly release: string;
  readonly date: string;
  /** Whether a path from the repository root is a file. */
  readonly exists: (path: string) => boolean;
  /** Story ids (`UX-068`) that stand in docs/stories. */
  readonly storyIds: ReadonlySet<string>;
  readonly axe: readonly AxeRecord[];
  readonly manualLogs: readonly ManualLog[];
  readonly criteria?: readonly Criterion[];
  readonly issues?: readonly KnownIssue[];
}

export interface Artifact {
  readonly path: string;
  readonly text: string;
}

export interface ReportResult {
  readonly problems: readonly string[];
  readonly counts: Readonly<Record<Status, number>>;
  readonly artifacts: readonly Artifact[];
}

const STATUS_LABEL: Readonly<Record<Status, string>> = {
  supported: 'Supported',
  partly: 'Partly supported',
  'not-supported': 'Not supported',
  'not-applicable': 'Not applicable',
  'not-evaluated': 'Not evaluated',
};
const STATUS_ORDER: readonly Status[] = [
  'supported',
  'partly',
  'not-supported',
  'not-applicable',
  'not-evaluated',
];

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Checks the table, the issues and the inputs. */
export function checkReport(input: ReportInput): string[] {
  const criteria = input.criteria ?? CRITERIA;
  const issues = input.issues ?? KNOWN_ISSUES;
  const problems: string[] = [];
  const seen = new Set<string>();
  const levels: Record<string, Record<string, number>> = {
    'WCAG 2.2': { A: 0, AA: 0 },
    'ATAG 2.0': { A: 0, AA: 0 },
  };
  for (const c of criteria) {
    const key = `${c.standard} ${c.id}`;
    if (seen.has(key)) problems.push(`${key} is listed twice`);
    seen.add(key);
    const level = levels[c.standard];
    if (level) level[c.level] = (level[c.level] ?? 0) + 1;
    if (c.notes.trim() === '') problems.push(`${key} has no notes`);
    for (const path of c.evidence)
      if (!input.exists(path)) problems.push(`${key} names ${path}, which is not a file`);
    if ((c.status === 'supported' || c.status === 'partly') && c.evidence.length === 0)
      problems.push(`${key} is ${c.status} with no test behind it`);
    if ((c.status === 'supported' || c.status === 'partly') && c.basis === 'none')
      problems.push(`${key} is ${c.status} with the basis "none"`);
    if ((c.status === 'not-evaluated' || c.status === 'not-applicable') && c.basis !== 'none')
      problems.push(`${key} is ${c.status} but has a basis`);
    if (c.status === 'partly' || c.status === 'not-supported') {
      const named = issues.filter((i) => i.criteria.includes(c.id));
      if (named.length === 0) problems.push(`${key} is ${c.status} and no known issue lists it`);
    }
  }
  if (!input.criteria) {
    for (const standard of ['WCAG 2.2', 'ATAG 2.0'] as const)
      for (const level of ['A', 'AA'] as const) {
        const have = levels[standard]?.[level] ?? 0;
        const want = EXPECTED_COUNTS[standard][level];
        if (have !== want)
          problems.push(`${standard} level ${level}: ${have} criteria listed, ${want} expected`);
      }
  }
  const ids = new Set(criteria.map((c) => c.id));
  const issueIds = new Set<string>();
  for (const i of issues) {
    if (issueIds.has(i.id)) problems.push(`known issue ${i.id} is listed twice`);
    issueIds.add(i.id);
    if (i.criteria.length === 0) problems.push(`known issue ${i.id} names no criterion`);
    for (const id of i.criteria)
      if (!ids.has(id)) problems.push(`known issue ${i.id} names ${id}, which is not a criterion`);
    const m = /^([A-Z]{2,4}-\d{3})(?: criterion \d+)?$/.exec(i.tracking);
    if (!m || !input.storyIds.has(m[1]!))
      problems.push(`known issue ${i.id} has no tracking item that is a story (${i.tracking})`);
  }
  const listedRules = new Set(issues.flatMap((i) => i.axeRules ?? []));
  for (const r of input.axe)
    for (const rule of r.rules)
      if (!listedRules.has(rule))
        problems.push(
          `axe reports ${rule} in "${r.test}" (${r.browser}), which no known issue lists`,
        );
  for (const log of input.manualLogs) {
    const name = `manual log of ${log.date} (${log.at.name})`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(log.date)) problems.push(`${name} has no valid date`);
    if (!log.at.name || !log.at.version) problems.push(`${name} does not name the technology`);
    if (log.flows.length === 0) problems.push(`${name} records no flow`);
    for (const f of log.flows) {
      if (f.result === 'issues' && f.issues.length === 0)
        problems.push(`${name}: flow "${f.name}" has issues recorded but none named`);
      for (const id of f.issues)
        if (!issueIds.has(id))
          problems.push(`${name}: flow "${f.name}" names ${id}, which is not a known issue`);
    }
  }
  return problems;
}

function axeSummary(records: readonly AxeRecord[]): {
  browser: string;
  version: string;
  runs: number;
  violations: number;
}[] {
  const byBrowser = new Map<
    string,
    { browser: string; version: string; runs: number; violations: number }
  >();
  for (const r of records) {
    const key = `${r.browser} ${r.version}`;
    const e = byBrowser.get(key) ?? {
      browser: r.browser,
      version: r.version,
      runs: 0,
      violations: 0,
    };
    e.runs += 1;
    e.violations += r.violations;
    byBrowser.set(key, e);
  }
  return [...byBrowser.values()].sort((x, y) => x.browser.localeCompare(y.browser));
}

export function buildConformanceReport(input: ReportInput): ReportResult {
  const criteria = input.criteria ?? CRITERIA;
  const issues = input.issues ?? KNOWN_ISSUES;
  const problems = checkReport(input);
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  for (const c of criteria) counts[c.status] += 1;
  const browsers = axeSummary(input.axe);
  const technologies = [
    ...new Map(
      input.manualLogs.map((l) => [
        `${l.at.name} ${l.at.version} ${l.browser} ${l.os}`,
        `${l.at.name} ${l.at.version} with ${l.browser} on ${l.os}`,
      ]),
    ).values(),
  ];

  const md: string[] = [
    `# Accessibility conformance report, release ${input.release}`,
    '',
    `Date: ${input.date}. Standards: WCAG 2.2 and ATAG 2.0, level A and AA. All names are working names (SPK-007).`,
    '',
    '**This report does not claim that the product conforms.** It says, for each criterion, what has been assessed and how. A row that rests on automated tests alone says so in its basis column, and an automated tool finds only part of what a criterion asks. No manual pass with assistive technology has been made unless a log is listed below.',
    '',
    '## Scope',
    '',
    'The shell of the editor (`packages/ui`): header, toolbar, menus, panes, dialogs and status bar, and the accessibility checker. The editing surface has its own stories (FE-103 to FE-108) and is reported here only where a test of the shell reaches it. The host page is the host’s.',
    '',
    '## Summary',
    '',
    '| Status | Criteria |',
    '|---|---:|',
    ...STATUS_ORDER.map((s) => `| ${STATUS_LABEL[s]} | ${counts[s]} |`),
    `| Total | ${criteria.length} |`,
    '',
    '## Browsers and assistive technologies tested',
    '',
    browsers.length
      ? 'Automated runs of axe (WCAG 2.0 to 2.2 level A and AA rule sets) on the states of the shell:'
      : 'No axe results were supplied for this release. Run the browser tests with `DOCEDIT_AXE_RESULTS=<file>` and pass the file to the report script.',
    '',
    ...(browsers.length
      ? [
          '| Browser | Version | Runs | Violations |',
          '|---|---|---:|---:|',
          ...browsers.map((b) => `| ${b.browser} | ${b.version} | ${b.runs} | ${b.violations} |`),
          '',
        ]
      : []),
    technologies.length
      ? `Manual passes with assistive technology: ${technologies.join('; ')}.`
      : 'Assistive technologies tested: none. No manual screen-reader pass has been logged for this release (UX-068, criterion 8).',
    '',
  ];
  if (input.manualLogs.length) {
    md.push(
      '| Date | Technology | Browser | System | Flow | Result | Issues |',
      '|---|---|---|---|---|---|---|',
    );
    for (const l of input.manualLogs)
      for (const f of l.flows)
        md.push(
          `| ${l.date} | ${escapeCell(`${l.at.name} ${l.at.version}`)} | ${escapeCell(l.browser)} | ${escapeCell(l.os)} | ${escapeCell(f.name)} | ${f.result} | ${f.issues.join(', ') || 'none'} |`,
        );
    md.push('');
  }
  md.push('## Known issues', '');
  if (issues.length === 0) md.push('None.', '');
  else {
    md.push('| Issue | Criteria | What is wrong | Tracking |', '|---|---|---|---|');
    for (const i of issues)
      md.push(
        `| ${i.id} | ${i.criteria.join(', ')} | ${escapeCell(i.summary)} | ${escapeCell(i.tracking)} |`,
      );
    md.push('');
  }
  for (const standard of ['WCAG 2.2', 'ATAG 2.0'] as const) {
    md.push(
      `## ${standard}${standard === 'ATAG 2.0' ? ': part A (the interface) and part B (producing accessible content)' : ''}`,
      '',
      '| Criterion | Level | Title | Status | Basis | Notes | Tests | Issues |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const c of criteria.filter((x) => x.standard === standard))
      md.push(
        `| ${c.id} | ${c.level} | ${escapeCell(c.title)} | ${STATUS_LABEL[c.status]} | ${c.basis} | ${escapeCell(c.notes)} | ${c.evidence.map((e) => `\`${e}\``).join('<br>') || 'none'} | ${
          issues
            .filter((i) => i.criteria.includes(c.id))
            .map((i) => i.id)
            .join(', ') || 'none'
        } |`,
      );
    md.push('');
  }
  md.push(
    '## ATAG 2.0 part B: the checker and the prompts',
    '',
    'Part B asks the tool to help authors produce accessible content. The accessibility checker (UX-066, UX-067) is the product’s answer to B.3: it lists five kinds of issue, explains each, moves to it and updates the count when a fix is made. The rows B.2.1.1, B.2.2.2, B.3.1.1 to B.3.1.4 and B.3.2.1 above state how far it goes. The prompts that guide an author while writing (for example for alternative text when a picture is inserted) are the subject of B.2.2.1, B.2.2.2 and B.2.3.1. Only B.2.2.2 is assessed, and only as far as the checker’s fix offers go; the other two rows are not evaluated, so this report says nothing yet about prompts at the time of writing.',
    '',
    '## How this report is made',
    '',
    'The table is `packages/ui/src/a11y-report/criteria.ts`, the issues are `known-issues.ts`, and `packages/ui/scripts/a11y-report.ts` builds this file and its JSON twin. It draws on the axe results of the browser run, the manual logs in `docs/accessibility/manual-logs` and the known issues. It refuses to build while a row names a missing test, a partly supported row has no known issue with a tracking item, or axe reports a violation that no known issue lists.',
    '',
  );
  const json = {
    release: input.release,
    date: input.date,
    counts,
    axe: browsers,
    manualLogs: input.manualLogs,
    knownIssues: issues,
    criteria,
  };
  return {
    problems,
    counts,
    artifacts: [
      { path: REPORT_MARKDOWN, text: `${md.join('\n')}` },
      { path: REPORT_JSON, text: `${JSON.stringify(json, null, 2)}\n` },
    ],
  };
}
