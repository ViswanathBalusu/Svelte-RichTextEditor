/**
 * The parity report as a release artefact (UX-002; 13 §2; ADR 0014): for every row of the parity
 * profile its state (`status.ts`), for a shipped row the automated tests that exercise it
 * (`tests.ts`), and for a row of the tier "through ports and extensions" what demonstrates it
 * (`demonstrators.ts`). Pure: the caller reads the epic files and says which files exist.
 *
 * The report is built for a release candidate and published beside the release notes
 * (`scripts/parity-report.ts`). It is not committed under `spec/`: its content changes with every
 * ticked criterion.
 */
import type { Artifact } from './build.ts';
import type { ProfileRow } from './profile.ts';
import { parityReport, type ReportRow, type StoryProgress } from './status.ts';
import { isTestFile, type TestLink } from './tests.ts';

export const REPORT_JSON = 'parity-report.json';
export const REPORT_MARKDOWN = 'PARITY-REPORT.md';

/** How the report is judged (UX-002 criterion 4). Printed in both artefacts. */
export const JUDGED_BY =
  'Judged by capability only. A state is derived from the acceptance criteria of the stories that deliver the row, and from nothing else: no row is partial or shipped because of how the product looks.';

export interface ReportInput {
  readonly rows: readonly ProfileRow[];
  readonly progress: ReadonlyMap<string, StoryProgress>;
  readonly tests: ReadonlyMap<string, readonly TestLink[]>;
  /** Whether a path from the repository root is a file. */
  readonly exists: (path: string) => boolean;
  /** The release the report is for, for example `0.3.0-rc.1`. */
  readonly release: string;
  /** The day the report was generated, `YYYY-MM-DD`. */
  readonly date: string;
  readonly profileVersion: number;
}

export interface PublishedRow extends ReportRow {
  readonly can: string;
  readonly stories: readonly string[];
  /** Present on a shipped row only. */
  readonly tests?: readonly TestLink[];
}

export interface ReportResult {
  readonly rows: readonly PublishedRow[];
  readonly counts: Readonly<Record<ReportRow['status']['state'], number>>;
  /** Not empty: the report must not be published. */
  readonly problems: readonly string[];
  readonly artifacts: readonly Artifact[];
}

function stateText(row: ReportRow): string {
  switch (row.status.state) {
    case 'shipped':
      return 'shipped';
    case 'partial':
      return 'partial';
    case 'planned':
      return `planned (phase ${row.status.phase})`;
    case 'not-planned':
      return 'not planned';
  }
}

const TIER_TEXT: Readonly<Record<ProfileRow['tier'], string>> = {
  'built-in': 'built in',
  'ports-and-extensions': 'through ports and extensions',
  'non-goal': 'non-goal',
};

function evidenceText(row: PublishedRow): string {
  const parts: string[] = [];
  if (row.tests)
    parts.push(row.tests.map((t) => `[\`${t.path}\`](${t.path}) (${t.kind})`).join(', '));
  const d = row.demonstrator;
  if (d)
    parts.push(
      d.state === 'none'
        ? `No port or reference extension demonstrates it: ${d.reason}.`
        : `Demonstrated by the ${d.state === 'port' ? 'port' : 'reference extension'} ${d.name}.`,
    );
  return parts.join(' ');
}

const cell = (text: string) => text.replace(/\|/g, '\\|');

export function buildParityReport(input: ReportInput): ReportResult {
  const base = parityReport(input.rows, input.progress);
  const problems = [...base.problems];
  const byId = new Map(input.rows.map((r) => [r.id, r]));
  const rows: PublishedRow[] = base.rows.map((row) => {
    const source = byId.get(row.id)!;
    const published = { ...row, can: source.can, stories: source.stories };
    if (row.status.state !== 'shipped') return published;
    const tests = input.tests.get(row.id) ?? [];
    if (tests.length === 0)
      problems.push(
        `row "${row.id}" is shipped but links to no automated test (packages/ui/src/parity/tests.ts)`,
      );
    for (const t of tests) {
      if (!isTestFile(t.path))
        problems.push(`row "${row.id}" links to ${t.path}, which is not a test file`);
      else if (!input.exists(t.path))
        problems.push(`row "${row.id}" links to ${t.path}, which does not exist`);
    }
    return { ...published, tests };
  });

  const counts = { shipped: 0, partial: 0, planned: 0, 'not-planned': 0 };
  for (const row of rows) counts[row.status.state]++;

  const json = {
    release: input.release,
    date: input.date,
    profileVersion: input.profileVersion,
    judgedBy: JUDGED_BY,
    counts,
    rows,
  };
  const md = [
    `# Parity report, release ${input.release}`,
    '',
    `Generated on ${input.date} from the parity profile, version ${input.profileVersion}, and the acceptance criteria in \`docs/stories\`.`,
    '',
    JUDGED_BY,
    '',
    `Rows: ${rows.length}. Shipped: ${counts.shipped}. Partial: ${counts.partial}. Planned: ${counts.planned}. Not planned: ${counts['not-planned']}.`,
    '',
    '| Capability | Tier | State | Stories | Tests and demonstrators |',
    '|---|---|---|---|---|',
    ...rows.map(
      (row) =>
        `| ${cell(row.can)} (\`${row.id}\`) | ${TIER_TEXT[row.tier]} | ${stateText(row)} | ${row.stories.join(', ')} | ${cell(evidenceText(row))} |`,
    ),
    '',
  ];
  return {
    rows,
    counts,
    problems,
    artifacts: [
      { path: REPORT_JSON, text: `${JSON.stringify(json, null, 2)}\n` },
      { path: REPORT_MARKDOWN, text: md.join('\n') },
    ],
  };
}
