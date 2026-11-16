/**
 * The parity report (UX-002; 13 §2; ADR 0014). For a release it says, for every row of the parity
 * profile, one of four states, derived only from the state of the stories that deliver the row:
 *
 * - `shipped`: every delivering story has every acceptance criterion ticked, and the row has no gap;
 * - `partial`: some criterion of a delivering story is ticked, but the row is not shipped (a
 *   criterion is still open, or the row states a gap);
 * - `planned` with the earliest phase of its stories, when no criterion is ticked yet;
 * - `not-planned`: a non-goal, or a row with no delivering story, or none of its stories is known.
 *
 * The report judges capability by stories only. It never reads the look of the product (UX-002
 * criterion 4). Pure: the caller passes the story progress, which `parseCriteria` reads from the
 * epic files, and the profile rows. The ports and extensions evidence (criterion 3) is carried by
 * `demonstrators.ts`, one entry per row of that tier. The automated tests of a shipped row
 * (criterion 2) are in `tests.ts` and are checked by `report.ts`, which builds the published files.
 */
import { phaseRank } from './build.ts';
import { DEMONSTRATORS, type Demonstrator } from './demonstrators.ts';
import type { ProfileRow, Tier } from './profile.ts';

/** Criteria ticked for one story, and its phase, as the epic file states them. */
export interface StoryProgress {
  readonly id: string;
  readonly phase: string;
  readonly ticked: number;
  readonly total: number;
}

export type RowStatus =
  | { readonly state: 'shipped' }
  | { readonly state: 'partial' }
  | { readonly state: 'planned'; readonly phase: string }
  | { readonly state: 'not-planned' };

export interface ReportRow {
  readonly id: string;
  readonly tier: Tier;
  readonly status: RowStatus;
  /** For a row of the tier "through ports and extensions": what demonstrates it (UX-002 criterion 3). */
  readonly demonstrator?: Demonstrator;
}

export interface ParityReport {
  readonly rows: readonly ReportRow[];
  /** Rows that name a story the progress does not know. Such a story counts for nothing. */
  readonly problems: readonly string[];
}

/** A story is done when it has criteria and every one is ticked. */
export function storyDone(story: StoryProgress): boolean {
  return story.total > 0 && story.ticked === story.total;
}

/** The status of one row, from the progress of the stories that deliver it. */
export function rowStatus(
  row: Pick<ProfileRow, 'tier' | 'stories' | 'gap'>,
  progress: ReadonlyMap<string, StoryProgress>,
): RowStatus {
  if (row.tier === 'non-goal') return { state: 'not-planned' };
  const found = row.stories.flatMap((id) => {
    const story = progress.get(id);
    return story ? [story] : [];
  });
  if (found.length === 0) return { state: 'not-planned' };
  const complete = found.length === row.stories.length && found.every(storyDone);
  if (complete && !row.gap) return { state: 'shipped' };
  if (found.some((s) => s.ticked > 0) || complete) return { state: 'partial' };
  const earliest = found.reduce((a, b) => (phaseRank(b.phase) < phaseRank(a.phase) ? b : a));
  return { state: 'planned', phase: earliest.phase };
}

/** The report for every row of the profile, with the stories it could not find. */
export function parityReport(
  rows: readonly ProfileRow[],
  progress: ReadonlyMap<string, StoryProgress>,
): ParityReport {
  const problems: string[] = [];
  for (const row of rows) {
    if (row.tier === 'non-goal') continue;
    for (const id of row.stories)
      if (!progress.has(id))
        problems.push(`row "${row.id}" names ${id}, which the progress does not know`);
    if (row.tier === 'ports-and-extensions' && !DEMONSTRATORS.has(row.id))
      problems.push(
        `row "${row.id}" has no demonstrator entry (port, reference extension, or none)`,
      );
  }
  return {
    rows: rows.map((row) => {
      const demonstrator =
        row.tier === 'ports-and-extensions' ? DEMONSTRATORS.get(row.id) : undefined;
      return {
        id: row.id,
        tier: row.tier,
        status: rowStatus(row, progress),
        ...(demonstrator === undefined ? {} : { demonstrator }),
      };
    }),
    problems,
  };
}

/** Rank of a state: a row only moves up as its stories progress (the property tests rely on it). */
export function stateRank(status: RowStatus): number {
  switch (status.state) {
    case 'shipped':
      return 3;
    case 'partial':
      return 2;
    case 'planned':
      return 1;
    case 'not-planned':
      return 0;
  }
}

/**
 * Criteria ticked per story, read from epic files: a story starts at its `### ID` heading and ends
 * at the next heading of level one to three; its `- [ ]` and `- [x]` lines are its criteria. The
 * phase comes from the story's field table, as `parseStories` reads it. A story without a field
 * table gets the phase `cond` (the last rank), which the report then shows as planned.
 */
export function parseCriteria(files: ReadonlyArray<{ text: string }>): Map<string, StoryProgress> {
  const out = new Map<string, StoryProgress>();
  for (const { text } of files) {
    let current: { id: string; phase: string | null; ticked: number; total: number } | null = null;
    const close = () => {
      if (current && !out.has(current.id))
        out.set(current.id, {
          id: current.id,
          phase: current.phase ?? 'cond',
          ticked: current.ticked,
          total: current.total,
        });
      current = null;
    };
    for (const line of text.split('\n')) {
      const heading = /^###\s+([A-Z]+-\d{3})\s/.exec(line);
      if (heading) {
        close();
        current = { id: heading[1]!, phase: null, ticked: 0, total: 0 };
        continue;
      }
      if (/^#{1,3}\s/.test(line)) {
        close();
        continue;
      }
      if (!current) continue;
      const fields = /^\|\s*(story|enabler|spike|decision)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (fields && current.phase === null) current.phase = fields[2]!;
      if (/^- \[x\] /i.test(line)) {
        current.ticked++;
        current.total++;
      } else if (/^- \[ \] /.test(line)) current.total++;
    }
    close();
  }
  return out;
}
