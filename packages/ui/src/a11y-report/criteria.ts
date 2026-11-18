/**
 * The criteria of the accessibility conformance report (UX-069; 13 §8) and what is known about each:
 * every WCAG 2.2 success criterion of level A and AA, and every ATAG 2.0 success criterion of level
 * A and AA. The report is built from this table (`report.ts`) and published with each release.
 *
 * How a row is judged:
 * - `supported`: the criterion is met on what was tested, and `evidence` names the tests.
 * - `partly`: met in part; a known issue (`known-issues.ts`) says what is missing and where it is
 *   tracked.
 * - `not-supported`: not met; a known issue says where it is tracked.
 * - `not-applicable`: the product has nothing the criterion is about; `notes` says why.
 * - `not-evaluated`: nobody has assessed it yet. This is not a claim in either direction.
 *
 * `basis` says what the judgement rests on: `automated` (axe or another script, no person looked),
 * `manual` (a person with assistive technology; logged in `docs/accessibility/manual-logs`), `both`
 * or `none`. No row has a manual basis yet: no manual pass has been made (UX-068, criterion 8).
 *
 * Titles and levels of ATAG 2.0 were read from https://www.w3.org/TR/ATAG20/ on 2026-11-17 with a
 * fetch tool and are to be checked by a person against the Recommendation. WCAG 2.2 titles are the
 * Recommendation's.
 */
export type Standard = 'WCAG 2.2' | 'ATAG 2.0';
export type Level = 'A' | 'AA';
export type Status = 'supported' | 'partly' | 'not-supported' | 'not-applicable' | 'not-evaluated';
export type Basis = 'automated' | 'manual' | 'both' | 'none';

export interface Criterion {
  readonly standard: Standard;
  readonly id: string;
  readonly level: Level;
  readonly title: string;
  readonly status: Status;
  readonly basis: Basis;
  readonly notes: string;
  /** Test files, from the repository root. */
  readonly evidence: readonly string[];
}

const AXE = [
  'packages/ui/e2e/shell-wcag.spec.ts',
  'packages/ui/e2e/ux-068-axe-states.spec.ts',
  'packages/ui/e2e/ux-068-axe-panes-dialogs.spec.ts',
  'packages/ui/e2e/a11y.spec.ts',
] as const;
const SIZE = [
  'packages/ui/e2e/ux-068-target-size.spec.ts',
  'packages/ui/e2e/ux-068-target-size-rest.spec.ts',
  'packages/ui/e2e/ux-068-target-size-panes.spec.ts',
  'packages/ui/e2e/fe-104-target-size-panes.spec.ts',
] as const;
const CHECKER = [
  'packages/ui/test/accessibility-check.test.ts',
  'packages/ui/test/accessibility-fix.test.ts',
  'packages/ui/test/accessibility-run.test.ts',
  'packages/ui/e2e/ux-066-067-checker.spec.ts',
] as const;

const NOT_YET = 'Not assessed: no test or manual check is recorded for this criterion.';
const AUTO_ONLY =
  'axe reports no violation on the states listed in UX-068. axe finds only part of what the criterion asks, and no manual pass has been made, so this is the automated result only.';

function row(
  standard: Standard,
  id: string,
  level: Level,
  title: string,
  status: Status,
  basis: Basis,
  notes: string,
  evidence: readonly string[] = [],
): Criterion {
  return { standard, id, level, title, status, basis, notes, evidence };
}
const w = (
  id: string,
  level: Level,
  title: string,
  status: Status = 'not-evaluated',
  basis: Basis = 'none',
  notes: string = NOT_YET,
  evidence: readonly string[] = [],
) => row('WCAG 2.2', id, level, title, status, basis, notes, evidence);
const a = (
  id: string,
  level: Level,
  title: string,
  status: Status = 'not-evaluated',
  basis: Basis = 'none',
  notes: string = NOT_YET,
  evidence: readonly string[] = [],
) => row('ATAG 2.0', id, level, title, status, basis, notes, evidence);

const NO_MEDIA =
  'The shell has no audio or video, and the document model (CDM 1, 03) has no audio or video node.';
const SEE_WCAG = 'Follows the WCAG 2.2 rows of this report. Not every one of them is assessed yet.';
const WEB_BASED = 'The shell is web-based; this criterion is about non-web-based user interfaces.';

export const CRITERIA: readonly Criterion[] = [
  w('1.1.1', 'A', 'Non-text Content', 'supported', 'automated', AUTO_ONLY, AXE),
  w('1.2.1', 'A', 'Audio-only and Video-only (Prerecorded)', 'not-applicable', 'none', NO_MEDIA),
  w('1.2.2', 'A', 'Captions (Prerecorded)', 'not-applicable', 'none', NO_MEDIA),
  w(
    '1.2.3',
    'A',
    'Audio Description or Media Alternative (Prerecorded)',
    'not-applicable',
    'none',
    NO_MEDIA,
  ),
  w('1.2.4', 'AA', 'Captions (Live)', 'not-applicable', 'none', NO_MEDIA),
  w('1.2.5', 'AA', 'Audio Description (Prerecorded)', 'not-applicable', 'none', NO_MEDIA),
  w(
    '1.3.1',
    'A',
    'Info and Relationships',
    'supported',
    'automated',
    `${AUTO_ONLY} Every label and description reference of the shell resolves in the root of its control.`,
    [...AXE, 'packages/ui/e2e/fe-108-idrefs-all-surfaces.spec.ts'],
  ),
  w('1.3.2', 'A', 'Meaningful Sequence'),
  w('1.3.3', 'A', 'Sensory Characteristics'),
  w('1.3.4', 'AA', 'Orientation'),
  w('1.3.5', 'AA', 'Identify Input Purpose'),
  w(
    '1.4.1',
    'A',
    'Use of Color',
    'partly',
    'automated',
    'Presence, the roles of a grant and the state of a region carry a cue that is not colour, under forced colours and in the high-contrast theme. The suggestion kinds of the review pane are not checked: the pane has no component in the shell yet.',
    ['packages/ui/e2e/ux-062-non-colour-cues.spec.ts', 'packages/ui/e2e/frw-074-markers.spec.ts'],
  ),
  w('1.4.2', 'A', 'Audio Control', 'not-applicable', 'none', NO_MEDIA),
  w(
    '1.4.3',
    'AA',
    'Contrast (Minimum)',
    'supported',
    'automated',
    'Every text and control pair of the shell is computed in the light, dark and high-contrast themes (source check), and axe reports no colour-contrast violation. The colours of the author’s own text are the checker’s, not this row.',
    ['packages/ui/test/theme.test.ts', 'packages/ui/e2e/ux-062-forced-colors.spec.ts', ...AXE],
  ),
  w(
    '1.4.4',
    'AA',
    'Resize Text',
    'partly',
    'automated',
    'The product zoom scales the content and keeps the interface the same size, and the interface reflows at the largest zoom. A browser text-only zoom to 200 per cent is not tested.',
    ['packages/ui/e2e/fe-138-zoom.spec.ts', 'packages/ui/e2e/v-fe-129-141-browser-zoom.spec.ts'],
  ),
  w('1.4.5', 'AA', 'Images of Text'),
  w(
    '1.4.10',
    'AA',
    'Reflow',
    'supported',
    'automated',
    'The shell reflows at 320 CSS pixels, and with the product zoom at 150 per cent on top, in Chromium, Firefox and WebKit.',
    ['packages/ui/e2e/v-fe-129-141-browser-zoom.spec.ts', 'packages/ui/e2e/fe-138-zoom.spec.ts'],
  ),
  w(
    '1.4.11',
    'AA',
    'Non-text Contrast',
    'supported',
    'automated',
    'The control and focus colours of the three themes meet 3 to 1 (source check on shell.css).',
    ['packages/ui/test/theme.test.ts'],
  ),
  w('1.4.12', 'AA', 'Text Spacing'),
  w('1.4.13', 'AA', 'Content on Hover or Focus'),
  w(
    '2.1.1',
    'A',
    'Keyboard',
    'partly',
    'automated',
    'Zoom, the toolbar, the command search, the access keys and the panes are reached from the keyboard in the browser tests. No test walks every function of the shell, and the editing surface is FE’s.',
    [
      'packages/ui/e2e/fe-103-keyboard.spec.ts',
      'packages/ui/e2e/fe-103-scripted-tasks.spec.ts',
      'packages/ui/e2e/ux-012-access-keys.spec.ts',
      'packages/ui/e2e/ux-011-command-search.spec.ts',
    ],
  ),
  w(
    '2.1.2',
    'A',
    'No Keyboard Trap',
    'supported',
    'automated',
    'Escape leaves the editing surface and Tab moves on in page order; a dialog closes with Escape and returns focus.',
    ['packages/ui/e2e/fe-103-keyboard.spec.ts', 'packages/ui/e2e/shell-wcag.spec.ts'],
  ),
  w('2.1.4', 'A', 'Character Key Shortcuts'),
  w('2.2.1', 'A', 'Timing Adjustable'),
  w('2.2.2', 'A', 'Pause, Stop, Hide'),
  w('2.3.1', 'A', 'Three Flashes or Below Threshold'),
  w('2.4.1', 'A', 'Bypass Blocks'),
  w(
    '2.4.2',
    'A',
    'Page Titled',
    'not-applicable',
    'none',
    'The editor is an element in the host’s page. The host owns the page title.',
  ),
  w('2.4.3', 'A', 'Focus Order'),
  w(
    '2.4.4',
    'A',
    'Link Purpose (In Context)',
    'partly',
    'automated',
    'The checker lists links in the document whose text does not say where they lead (UX-066). The links of the shell are not assessed.',
    CHECKER,
  ),
  w('2.4.5', 'AA', 'Multiple Ways'),
  w('2.4.6', 'AA', 'Headings and Labels'),
  w(
    '2.4.7',
    'AA',
    'Focus Visible',
    'partly',
    'automated',
    'Focus is outlined under forced colours, and the focus colour is checked in the themes. Focus visibility in the light and dark themes on each control is not tested one by one.',
    ['packages/ui/e2e/fe-103-keyboard.spec.ts', 'packages/ui/test/forced-colors.test.ts'],
  ),
  w(
    '2.4.11',
    'AA',
    'Focus Not Obscured (Minimum)',
    'supported',
    'automated',
    'Each visible, enabled control of the shell is focused in turn and the element at its centre is read. None is covered. The shell has no sticky header, toolbar or pane, so the test is a guard.',
    ['packages/ui/e2e/ux-068-focus-not-obscured.spec.ts'],
  ),
  w(
    '2.5.1',
    'A',
    'Pointer Gestures',
    'partly',
    'automated',
    'The shell has no gesture that needs a path or several points (a source check finds no drag). The editing surface is FE’s and is not assessed here.',
    ['packages/ui/test/ux-068-no-drag.test.ts'],
  ),
  w('2.5.2', 'A', 'Pointer Cancellation'),
  w(
    '2.5.3',
    'A',
    'Label in Name',
    'not-evaluated',
    'none',
    'The toolbar’s source states the rule. No test checks it.',
  ),
  w(
    '2.5.4',
    'A',
    'Motion Actuation',
    'not-applicable',
    'none',
    'No function of the shell is operated by moving the device (a source search finds no device motion or orientation listener).',
  ),
  w(
    '2.5.7',
    'AA',
    'Dragging Movements',
    'supported',
    'automated',
    'A source check fails when a drag gesture appears in the shell without a reviewed alternative. There is none. Dragging on the editing surface (a picture, a table column) is FE’s and is not assessed here.',
    ['packages/ui/test/ux-068-no-drag.test.ts'],
  ),
  w(
    '2.5.8',
    'AA',
    'Target Size (Minimum)',
    'supported',
    'automated',
    'Every control of the toolbar, menus, panes, dialogs, header and status bar is at least 24 by 24 CSS pixels in Chromium, Firefox and WebKit. A radio or checkbox is measured by its label (ADR 0329, decision 1, proposed).',
    SIZE,
  ),
  w(
    '3.1.1',
    'A',
    'Language of Page',
    'not-applicable',
    'none',
    'The host’s page owns the `lang` of the page. The element’s `locale` setting selects the language of its interface strings (UX-064); whether it also marks that language in the DOM is not assessed.',
  ),
  w('3.1.2', 'AA', 'Language of Parts'),
  w('3.2.1', 'A', 'On Focus'),
  w('3.2.2', 'A', 'On Input'),
  w('3.2.3', 'AA', 'Consistent Navigation'),
  w('3.2.4', 'AA', 'Consistent Identification'),
  w('3.2.6', 'A', 'Consistent Help'),
  w('3.3.1', 'A', 'Error Identification'),
  w('3.3.2', 'A', 'Labels or Instructions'),
  w('3.3.3', 'AA', 'Error Suggestion'),
  w('3.3.4', 'AA', 'Error Prevention (Legal, Financial, Data)'),
  w('3.3.7', 'A', 'Redundant Entry'),
  w(
    '3.3.8',
    'AA',
    'Accessible Authentication (Minimum)',
    'not-applicable',
    'none',
    'The element does not authenticate anyone. The host signs the token that names the user (integration guide, section 1).',
  ),
  w(
    '4.1.2',
    'A',
    'Name, Role, Value',
    'supported',
    'automated',
    `${AUTO_ONLY} Dialogs expose the dialog part, and a dialog moves focus in and returns it.`,
    AXE,
  ),
  w(
    '4.1.3',
    'AA',
    'Status Messages',
    'supported',
    'automated',
    'Arrivals, recovered items, notices, region changes and checker results are announced through live regions in the browser tests.',
    [
      'packages/ui/e2e/ux-017-arrival-announce.spec.ts',
      'packages/ui/e2e/ux-017-recovered-announce.spec.ts',
      'packages/ui/e2e/notices.spec.ts',
      'packages/ui/e2e/prm-024.live-region.spec.ts',
    ],
  ),

  // ATAG 2.0, part A: the authoring tool user interface.
  a(
    'A.1.1.1',
    'A',
    'Web-Based Accessible (WCAG)',
    'partly',
    'automated',
    `${SEE_WCAG} The level is WCAG 2.2 AA, which is higher than the level ATAG asks for.`,
    AXE,
  ),
  a('A.1.2.1', 'A', 'Accessibility Guidelines', 'not-applicable', 'none', WEB_BASED),
  a('A.1.2.2', 'A', 'Platform Accessibility Services', 'not-applicable', 'none', WEB_BASED),
  a('A.2.1.1', 'A', 'Text Alternatives for Rendered Non-Text Content'),
  a(
    'A.2.1.2',
    'A',
    'Alternatives for Rendered Time-Based Media',
    'not-applicable',
    'none',
    NO_MEDIA,
  ),
  a('A.2.2.1', 'A', 'Editing-View Status Indicators'),
  a('A.2.2.2', 'AA', 'Access to Rendered Text Properties'),
  a('A.3.1.1', 'A', 'Keyboard Access (Minimum)', 'partly', 'automated', 'See WCAG 2.1.1.', [
    'packages/ui/e2e/fe-103-keyboard.spec.ts',
    'packages/ui/e2e/fe-103-scripted-tasks.spec.ts',
  ]),
  a('A.3.1.2', 'A', 'No Keyboard Traps', 'supported', 'automated', 'See WCAG 2.1.2.', [
    'packages/ui/e2e/fe-103-keyboard.spec.ts',
    'packages/ui/e2e/shell-wcag.spec.ts',
  ]),
  a(
    'A.3.1.3',
    'AA',
    'Efficient Keyboard Access',
    'partly',
    'automated',
    'The command search and the access keys reach every registered command from the keyboard. Whether that is efficient for each function is not assessed.',
    ['packages/ui/e2e/ux-011-command-search.spec.ts', 'packages/ui/e2e/ux-012-access-keys.spec.ts'],
  ),
  a(
    'A.3.2.1',
    'A',
    'Auto-Save (Minimum)',
    'not-evaluated',
    'none',
    'Every change is sent to the server as a commit (ADR 0001), so no change waits for a save. No test is recorded against this criterion.',
  ),
  a('A.3.2.2', 'A', 'Timing Adjustable'),
  a('A.3.2.3', 'A', 'Static Input Components'),
  a('A.3.3.1', 'A', 'Static View Option'),
  a(
    'A.3.4.1',
    'AA',
    'Navigate By Structure',
    'partly',
    'automated',
    'The outline pane moves the caret to a heading. Other structures (tables, lists) are not assessed.',
    ['packages/ui/e2e/ux-020-outline-place.spec.ts'],
  ),
  a(
    'A.3.5.1',
    'AA',
    'Text Search',
    'not-evaluated',
    'none',
    'Search is FE’s (find and replace). No test is recorded against this criterion in the shell.',
  ),
  a('A.3.6.1', 'A', 'Independence of Display'),
  a('A.3.6.2', 'AA', 'Save Settings'),
  a('A.3.6.3', 'AA', 'Apply Platform Settings'),
  a('A.3.7.1', 'A', 'Preview (Minimum)'),
  a('A.4.1.1', 'A', 'Content Changes Reversible (Minimum)'),
  a('A.4.1.2', 'A', 'Settings Change Confirmation'),
  a('A.4.2.1', 'A', 'Describe Accessibility Features'),
  a('A.4.2.2', 'AA', 'Document All Features'),

  // ATAG 2.0, part B: supporting the production of accessible content.
  a('B.1.1.1', 'A', 'Content Auto-Generation After Authoring Sessions (WCAG)'),
  a('B.1.1.2', 'A', 'Content Auto-Generation During Authoring Sessions (WCAG)'),
  a('B.1.2.1', 'A', 'Restructuring and Recoding Transformations (WCAG)'),
  a('B.1.2.2', 'A', 'Copy-Paste Inside Authoring Tool (WCAG)'),
  a('B.1.2.3', 'A', 'Optimizations Preserve Accessibility'),
  a('B.1.2.4', 'A', 'Text Alternatives for Non-Text Content are Preserved'),
  a(
    'B.2.1.1',
    'A',
    'Accessible Content Possible (WCAG)',
    'partly',
    'automated',
    'A document can carry alternative text, header rows, heading styles, link text and a language. Whether every kind of content WCAG covers can be made accessible is not assessed.',
    CHECKER,
  ),
  a('B.2.2.1', 'A', 'Accessible Option Prominence (WCAG)'),
  a(
    'B.2.2.2',
    'A',
    'Setting Accessibility Properties (WCAG)',
    'partly',
    'automated',
    'The checker’s issue offers the field or command that sets the property (UX-067). Not every kind of issue offers one yet.',
    CHECKER,
  ),
  a('B.2.3.1', 'A', 'Alternative Content is Editable (WCAG)'),
  a('B.2.3.2', 'A', 'Automating Repair of Text Alternatives'),
  a('B.2.4.1', 'A', 'Accessible Template Options (WCAG)'),
  a('B.2.4.2', 'AA', 'Identify Template Accessibility'),
  a('B.2.4.3', 'AA', 'Author-Created Templates'),
  a('B.2.5.1', 'AA', 'Accessible Pre-Authored Content Options'),
  a('B.2.5.2', 'AA', 'Identify Pre-Authored Content Accessibility'),
  a(
    'B.3.1.1',
    'A',
    'Checking Assistance (WCAG)',
    'partly',
    'automated',
    'The checker finds five kinds of issue: missing alternative text, heading order, tables without header rows, empty or non-descriptive link text and insufficient contrast. It does not check every WCAG criterion that an author’s content can fail, and it does not update incrementally yet.',
    CHECKER,
  ),
  a(
    'B.3.1.2',
    'A',
    'Help Authors Decide',
    'supported',
    'automated',
    'Each issue names its kind, its block and a short explanation, and issues are grouped by kind.',
    CHECKER,
  ),
  a(
    'B.3.1.3',
    'A',
    'Help Authors Locate',
    'supported',
    'automated',
    'Choosing an issue moves the caret or selection to the element and scrolls to it.',
    [
      'packages/ui/e2e/ux-066-067-checker.spec.ts',
      'packages/engine/test/ux-067-select-block.test.ts',
      'packages/engine/src/view/ux-067-select-block.universal.test.ts',
    ],
  ),
  a(
    'B.3.1.4',
    'AA',
    'Status Report',
    'supported',
    'automated',
    'The pane shows the count of issues per kind and updates it, and announces the change, when a fix is made.',
    ['packages/ui/e2e/ux-066-067-checker.spec.ts'],
  ),
  a('B.3.1.5', 'AA', 'Programmatic Association of Results'),
  a(
    'B.3.2.1',
    'A',
    'Repair Assistance (WCAG)',
    'partly',
    'automated',
    'See B.2.2.2. Export is not blocked while issues remain, and the export job still reports missing alternative text.',
    [...CHECKER, 'packages/ui/e2e/ux-067-export-not-blocked.spec.ts'],
  ),
  a('B.4.1.1', 'A', 'Features Active by Default'),
  a('B.4.1.2', 'A', 'Option to Reactivate Features'),
  a('B.4.1.3', 'AA', 'Feature Deactivation Warning'),
  a('B.4.1.4', 'AA', 'Feature Prominence'),
  a('B.4.2.1', 'A', 'Model Practice (WCAG)'),
  a('B.4.2.2', 'A', 'Feature Instructions'),
];
