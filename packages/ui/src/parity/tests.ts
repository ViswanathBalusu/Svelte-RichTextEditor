/**
 * The automated tests that exercise a capability as a user would (UX-002 criterion 2; 13 §2). A row
 * of the parity profile may be reported as shipped only when it has an entry here: the report links
 * to these files, never to a screenshot. `buildParityReport` refuses a shipped row without an
 * entry, an entry whose file does not exist, and a path that is not a test file.
 *
 * Kept beside the profile, not in it, as `demonstrators.ts` is: the profile's published shape
 * (spec/parity/parity-profile.json) does not change. Whether the links belong in the profile row
 * itself is open (UX-002 Notes). Paths are relative to the repository root.
 *
 * A row gains its entry when it becomes shipped. The entries below are the rows shipped at
 * 2026-11-15. A lane that closes the last story of a row adds the row's entry in the same change.
 */
export interface TestLink {
  /** Path of the test file from the repository root. */
  readonly path: string;
  /** `playwright`: run in a browser against the element; `unit`: run in Node.js by Vitest. */
  readonly kind: 'playwright' | 'unit';
}

const ROW_TEST_ENTRIES: ReadonlyArray<readonly [string, readonly TestLink[]]> = [
  [
    'toolbar',
    [
      { path: 'packages/ui/e2e/toolbar.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/toolbar-groups.test.ts', kind: 'unit' },
    ],
  ],
  [
    'sharing',
    [
      { path: 'packages/element/e2e/ux-039-share.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/pro-089-share-request.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when FE-131 closed (2026-11-15). No Playwright spec presses the table commands yet:
  // the links are the tests that run them through the core, one of them in every browser.
  [
    'tables',
    [
      { path: 'packages/engine/test/table.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/table-span.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/table-style-sort.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-131-sort-suggest.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-131-table-style.universal.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-009 closed (2026-11-17): the engine's painter, and the element's browser run of it.
  [
    'format-painter',
    [
      { path: 'packages/element/e2e/ux-009-format-painter.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-009-format-painter.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-018 closed (2026-11-17): the element's browser runs of the counts and the language.
  [
    'status-bar',
    [
      { path: 'packages/element/e2e/ux-018-status-counts.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/shell.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-018-status-counts.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-133 closed (2026-11-17). No Playwright spec of the element adds a link or a
  // bookmark: the links are the tests that run the commands through the core, the click that follows
  // a link in all three browser engines, and the shell's notice for a bookmark still referenced.
  [
    'bookmarks',
    [
      { path: 'packages/engine/test/authoring-commands.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-133-heading-and-references.test.ts', kind: 'unit' },
      { path: 'packages/ui/e2e/notices.spec.ts', kind: 'playwright' },
    ],
  ],
  [
    'links',
    [
      { path: 'packages/engine/test/authoring-commands.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-133-heading-and-references.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-133-follow-link.universal.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/fe-133-link-open.universal.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-022 closed (2026-11-17): the element's browser run of the pane, and the core's tests.
  [
    'styles',
    [
      { path: 'packages/element/e2e/ux-022-styles.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-022-style-edit.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-022-style-edit.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/ux-022-styles.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-027 closed (2026-11-17): two mounted editors, and the core's concurrent edits.
  [
    'presence',
    [
      { path: 'packages/element/e2e/ux-027-carets.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-027-carets.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-027-concurrent-carets.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when EXP-085 closed (2026-11-17). No browser spec presses the download yet: the links
  // are the tests of the archive the download hands out, which run the converter and read it back.
  [
    'export-latex',
    [
      { path: 'packages/export-latex/src/archive.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-085-licences.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when HIS-028 closed (2026-11-17): the controller in Node, and the pane in a browser run.
  [
    'catch-up',
    [
      { path: 'packages/ui/e2e/his-028-catch-up.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/his-028-catch-up.test.ts', kind: 'unit' },
    ],
  ],
];

export const ROW_TESTS: ReadonlyMap<string, readonly TestLink[]> = new Map(ROW_TEST_ENTRIES);

/** A test file: `*.test.ts` or `*.spec.ts`. Images and other evidence are not accepted. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}
