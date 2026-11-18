/**
 * The known accessibility issues of the product (UX-069 criterion 3). Each one names the criteria it
 * affects and a tracking item: a story, with the criterion number where one stands for the work.
 * A row of the report that is `partly` or `not-supported` must be named by at least one issue, and
 * the report refuses to build otherwise. When an issue is fixed, delete it and change the row.
 */
export interface KnownIssue {
  readonly id: string;
  /** Ids of criteria in `criteria.ts` (the same id may stand in WCAG and in ATAG; both are listed). */
  readonly criteria: readonly string[];
  readonly summary: string;
  /** Axe rules the issue accounts for: a violation of any other rule fails the report. */
  readonly axeRules?: readonly string[];
  /** A story id, optionally with " criterion N", for example `UX-068 criterion 5`. */
  readonly tracking: string;
}

export const KNOWN_ISSUES: readonly KnownIssue[] = [
  {
    id: 'KI-001',
    criteria: ['1.4.1'],
    summary:
      'The suggestion kinds of the review pane are not checked for a cue that is not colour: the shell has no review pane component yet.',
    tracking: 'UX-068 criterion 5',
  },
  {
    id: 'KI-002',
    criteria: ['1.4.4'],
    summary:
      'A browser text-only zoom to 200 per cent is not tested. The product zoom of the editing surface is.',
    tracking: 'FE-138',
  },
  {
    id: 'KI-003',
    criteria: ['2.1.1', 'A.3.1.1', 'A.3.1.3', '2.4.7', 'A.1.1.1', 'A.3.4.1', '2.4.4'],
    summary:
      'No manual pass with a keyboard and a screen reader has been made, and no test walks every function of the shell, so these rows rest on partial automated tests.',
    tracking: 'UX-068 criterion 8',
  },
  {
    id: 'KI-004',
    criteria: ['2.5.1'],
    summary:
      'Gestures on the editing surface (a picture, a table column) are not assessed; the shell has none that needs a path or several points.',
    tracking: 'FE-103',
  },
  {
    id: 'KI-005',
    criteria: ['B.2.1.1', 'B.2.2.2', 'B.3.2.1'],
    summary:
      'An issue of the checker does not yet offer the command or field that fixes it, for each of the five kinds.',
    tracking: 'UX-067 criterion 2',
  },
  {
    id: 'KI-006',
    criteria: ['B.3.1.1'],
    summary:
      'The checker finds five kinds of issue only, and its results do not update as the author types.',
    tracking: 'UX-066 criterion 5',
  },
];
