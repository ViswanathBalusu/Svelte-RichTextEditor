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
  // Shipped when UX-011 closed (2026-11-17).
  [
    'command-search',
    [
      { path: 'packages/ui/e2e/ux-011-command-search.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/command-search.test.ts', kind: 'unit' },
    ],
  ],
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
  // Shipped when FE-130 closed (2026-11-18): the list commands through the core, the list view and its
  // semantics in a browser, and the list labels in the PDF.
  [
    'lists',
    [
      { path: 'packages/engine/test/list-commands.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/list-view.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/list-semantics.spec.ts', kind: 'playwright' },
      { path: 'packages/export-latex/src/fe-130-list-labels.compile.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-134 closed (2026-11-18): the captions and references through the core, the
  // computed texts in three browsers, the cross-reference dialog in the real element.
  [
    'captions-and-cross-references',
    [
      { path: 'packages/engine/test/captions-refs.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-134-table-equation-captions.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-134-core-target-delete.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-134-computed-field.universal.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/fe-134-cross-reference.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when FE-136 closed (2026-11-18): the insertion commands through the core, the table of
  // contents in three browsers, the equation command in the real element, the glyph flag in the
  // real element with a real font file, and the page numbers in the PDF.
  [
    'symbols',
    [
      { path: 'packages/engine/test/fields-toc.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-136-glyph-check.test.ts', kind: 'unit' },
      { path: 'packages/element/test/fe-136-glyph-coverage.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/fe-136-glyph-notice.spec.ts', kind: 'playwright' },
    ],
  ],
  [
    'equations',
    [
      { path: 'packages/engine/test/fe-136-insert-equation.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/fe-136-insert-equation.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-070-math-editor.spec.ts', kind: 'playwright' },
      { path: 'packages/export-latex/src/exp-052-equations.test.ts', kind: 'unit' },
    ],
  ],
  [
    'page-numbers',
    [
      { path: 'packages/engine/test/layout-commands.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-036-page-numbers.compile.test.ts', kind: 'unit' },
    ],
  ],
  [
    'table-of-contents',
    [
      { path: 'packages/engine/test/toc-entries.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-136-toc.universal.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-023-toc.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-138 closed (2026-11-18): the status bar and the keyboard in three browsers, the
  // reflow under browser zoom, and the PDF panel's pages drawn again at each zoom.
  [
    'zoom',
    [
      { path: 'packages/ui/e2e/fe-138-zoom.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/v-fe-129-141-browser-zoom.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-138-pdf-zoom.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when FE-137 closed (2026-11-18). The panel is run in the three browsers by the element's
  // spec; the variants turned on by the page setup and the page fields are run through the core and
  // the layout in Node.js.
  [
    'headers-and-footers',
    [
      { path: 'packages/element/e2e/fe-057-panel.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/fe-057-variants.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-137-variant-wiring.test.ts', kind: 'unit' },
      { path: 'packages/layout/src/fe-137-page-number-fields.test.ts', kind: 'unit' },
    ],
  ],
  // The stored text is the core's (FE-137); the print is the export's, compiled in the Podman sandbox.
  [
    'watermark',
    [
      { path: 'packages/engine/test/fe-137-watermark.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-036-watermark.compile.test.ts', kind: 'unit' },
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
  // Shipped when UX-010 closed (2026-11-18): the toolbar next to a selection in the element, and the shell's.
  [
    'mini-toolbar',
    [
      { path: 'packages/element/e2e/ux-010-mini-toolbar.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-010-mini-toolbar.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/mini-toolbar.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-062 closed (2026-11-18): the light, dark and high-contrast themes and forced colours.
  [
    'themes',
    [
      { path: 'packages/ui/e2e/ux-061-themes.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-062-forced-colors.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-062-non-colour-cues.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/theme.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/forced-colors.test.ts', kind: 'unit' },
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
  // Shipped when FE-135 closed (2026-11-17).
  [
    'columns',
    [
      { path: 'packages/engine/test/fe-135-section-starts.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-135-section-after-sources.test.ts', kind: 'unit' },
    ],
  ],
  [
    'breaks',
    [
      { path: 'packages/engine/src/fe-135-break-mark.universal.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-135-section-warning.universal.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-135-136-core-authoring.test.ts', kind: 'unit' },
    ],
  ],
  [
    'footnotes',
    [
      { path: 'packages/element/e2e/fe-135-footnote.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/fe-135-footnote-number.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-011 closed (2026-11-17): the search over the registry in Node, and the dialog in a browser run.
  [
    'command-search',
    [
      { path: 'packages/ui/e2e/ux-011-command-search.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/command-search.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-057 and FE-137 closed (2026-11-17); entry added by the batch 12 integrator.
  [
    'headers-and-footers',
    [
      { path: 'packages/element/e2e/fe-057-panel.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/fe-057-variants.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-137-variant-wiring.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-100 closed (2026-11-18); entry added by the batch 4 integrator. The gallery of
  // the reference host: its server logic in Node, and the page in a browser run with an axe scan.
  [
    'templates',
    [
      {
        path: 'apps/reference-host/e2e-gallery/ux-100-template-gallery.spec.ts',
        kind: 'playwright',
      },
      { path: 'apps/reference-host/test/ux-100-template-gallery.test.ts', kind: 'unit' },
      {
        path: 'services/document-service/test/control-plane/frw-062.templates.test.ts',
        kind: 'unit',
      },
    ],
  ],
  // Shipped when FE-137 and EXP-036 closed; the PDF run of the watermark is a compile test.
  [
    'watermark',
    [
      { path: 'packages/engine/test/fe-137-watermark.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-036-watermark.compile.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FRW-062 and UX-100 closed (2026-11-18): the service's templates resource, the host's
  // gallery through its routes, and the gallery in a browser with axe and the keyboard.
  [
    'templates',
    [
      {
        path: 'services/document-service/test/control-plane/frw-062.templates.test.ts',
        kind: 'unit',
      },
      { path: 'apps/reference-host/test/ux-100-template-gallery.test.ts', kind: 'unit' },
      {
        path: 'apps/reference-host/e2e-gallery/ux-100-template-gallery.spec.ts',
        kind: 'playwright',
      },
    ],
  ],
];

export const ROW_TESTS: ReadonlyMap<string, readonly TestLink[]> = new Map(ROW_TEST_ENTRIES);

/** A test file: `*.test.ts` or `*.spec.ts`. Images and other evidence are not accepted. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}
