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
  // Shipped when HIS-010 closed (2026-11-18).
  [
    'version-history',
    [
      { path: 'packages/ui/e2e/his-009-history-pane.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/his-010-version-view.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/his-013-compare.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/his-006-name-version.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/his-010-version-view.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-129 closed, after FE-128 (2026-11-26).
  [
    'character-and-paragraph-formatting',
    [
      { path: 'packages/engine/src/view/fe-129-paragraph-format.universal.test.ts', kind: 'unit' },
      { path: 'packages/engine/src/view/fe-129-tab-stops.universal.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-129-paragraph-options-info.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/fe-129-paragraph-dialog-options.test.ts', kind: 'unit' },
      { path: 'packages/ui/e2e/fe-129-paragraph-dialog.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-129-paragraph-dialog.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when CDM-019 and FE-130 closed (2026-11-18).
  [
    'lists',
    [
      { path: 'packages/engine/test/list-commands.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/list-view.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/fe-130-list-labels.compile.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-134 closed (2026-11-18).
  [
    'captions-and-cross-references',
    [
      { path: 'packages/element/e2e/fe-134-cross-reference.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/fe-134-table-equation-captions.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-134-referenced-target.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/fe-134-numbers.compile.test.ts', kind: 'unit' },
    ],
  ],
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
  // Shipped when UX-013 closed (2026-11-20): every key of the shortcut table pressed in a browser run,
  // the alternatives bound, the reference built from the registry, and the published table.
  [
    'keyboard-shortcuts',
    [
      { path: 'packages/ui/e2e/ux-013-w3-table-keys.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/commands.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/shortcut-alternatives.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/shortcut-reference.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/ux-013-published-table.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-042 closed (2026-11-25): the findings and the actions on them, with a mock port
  // and the real authority room in Node.js, in the shell in three browsers, and the custom
  // dictionaries in the language dialog and in the element with a stand-in port.
  [
    'spelling-and-grammar',
    [
      { path: 'packages/element/e2e/ux-042-dictionary.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-008-proofing-menu.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-041-042-proofing.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-042-dictionary.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-041-proofing.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/ux-042-finding-actions.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/finding-actions.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-008 closed (2026-11-20): the menu in the element with the real core (at the
  // caret, and on a word a proofing port flagged), the shell's menu in a browser run, and the rule
  // that picks its commands.
  [
    'context-menu',
    [
      { path: 'packages/element/e2e/ux-008-caret-menu.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-008-proofing-menu.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-008-context-menu.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-008-context-targets.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-008-finding-click.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/context-menu.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-021 closed (2026-11-21): the headings and the search in the element and the
  // shell, and the page thumbnails in the element's page view and, with a stand-in for the view,
  // in the shell.
  [
    'navigation-pane',
    [
      { path: 'packages/element/e2e/ux-020-navigation.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-021-page-thumbnails.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-020-outline-place.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-020-search-context.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-021-page-thumbnails.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/ux-020-navigation.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/ux-020-place.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/ux-021-page-thumbnails.test.ts', kind: 'unit' },
      { path: 'packages/element/test/ux-021-pages.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when FE-065 and UX-007 closed (2026-11-26): the web view, the page view and the switch
  // between them in the element in a browser, and the layout switch of the shell.
  [
    'views',
    [
      { path: 'packages/element/e2e/fe-065-view-switch.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-065-web-label.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-065-view-print-fallback.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-101-page-view.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-007-layout-switch.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when UX-102 closed (2026-11-25): the ruler and the paragraph dialog in the shell and in
  // the element, and the arithmetic of the markers and of the dialog's patch in Node.js.
  [
    'rulers',
    [
      { path: 'packages/ui/e2e/ux-102-ruler.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-102-ruler.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/ruler.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/ux-102-paragraph-dialog.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/ux-102-paragraph-format-info.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when UX-016 closed (2026-11-20): the indicator's words in the shell, the return of a
  // visit that ended unsaved in the element and against the demo stack, and the outage and flush
  // on the element's own path.
  [
    'save-state',
    [
      { path: 'packages/element/e2e/ux-016-return-unsaved.spec.ts', kind: 'playwright' },
      { path: 'apps/reference-host/e2e/w3-ux-016-return.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/header.spec.ts', kind: 'playwright' },
      { path: 'packages/element/test/ux-016-outage-flush.test.ts', kind: 'unit' },
      { path: 'packages/element/test/save-state.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/ux-016-return-unsaved.test.ts', kind: 'unit' },
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
  // Shipped when UX-037 closed (lane w3, 2026-11-18); entry added by the batch 1 integrator of
  // 2026-11-20. Suggesting while typing, the review tools and the review pane in the real element,
  // the shell's review tools, and the resolve commit and the bulk accept and reject in Node.js.
  [
    'suggestions',
    [
      { path: 'packages/element/e2e/fe-042-composition-suggest.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-036-review-tools.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-037-review-pane.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-037-review-time.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-036-review.spec.ts', kind: 'playwright' },
      { path: 'packages/engine/test/fe-047-resolve-commit.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/ux-036-review.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/ux-036-037-review-bulk-live.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when EXP-001 closed (lane w2, 2026-11-20); entry added by the batch 1 integrator. The
  // export from the shell's dialog to the PDF pane on the demo stack, the pane with the real viewer
  // in the element, and in Node.js the export through the control plane and the worker's sandbox
  // (Podman), the job that follows a document's `seq`, and the pane's choice of the newest PDF.
  [
    'export-pdf',
    [
      { path: 'apps/reference-host/e2e/w2-exp-001-pdf-export.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/exp-001-pdf-pane.spec.ts', kind: 'playwright' },
      { path: 'services/export-worker/test/export.e2e.test.ts', kind: 'unit' },
      { path: 'services/export-worker/src/exp-004-v-exp-001-016.seq.job.test.ts', kind: 'unit' },
      { path: 'packages/element/test/exp-001-latest-pdf.test.ts', kind: 'unit' },
    ],
  ],
  // Shipped when the stories of the row closed (lanes w1 and w9, 2026-11-21); entries added by the
  // batch 12 integrator.
  [
    'recovery-journal',
    [
      { path: 'packages/engine/test/fe-008-journal.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-009-resubmit.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/fe-010-recovered-journal.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/fe-008-journal-reopen.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-009-resubmit-reopen.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/fe-010-recovered-reopen.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-017-recovered-pane.spec.ts', kind: 'playwright' },
    ],
  ],
  [
    'regions-and-permissions',
    [
      { path: 'packages/engine/test/prm-026.region-lock.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/prm-027.next-editable-region.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/prm-033.mark-region.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/prm-035.grant-change-live.test.ts', kind: 'unit' },
      { path: 'packages/engine/test/prm-036.region-policy.test.ts', kind: 'unit' },
      { path: 'packages/element/e2e/prm-026-lock-indicator.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/prm-027-next-editable-region.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/prm-035-grants.spec.ts', kind: 'playwright' },
    ],
  ],
  // Shipped when EXP-087 closed (2026-11-26): the HTML writer (structure, cascade, fonts, visible
  // text) and the export job and route that carry its pictures.
  [
    'export-html',
    [
      { path: 'packages/export-latex/src/exp-087-structure.html.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-087-cascade.html.test.ts', kind: 'unit' },
      { path: 'packages/export-latex/src/exp-087-fonts.html.test.ts', kind: 'unit' },
      { path: 'services/export-worker/src/exp-087-html.job.test.ts', kind: 'unit' },
      { path: 'services/export-worker/src/exp-087-html-pictures.job.test.ts', kind: 'unit' },
      {
        path: 'services/document-service/test/control-plane/exp-087-html-assets.test.ts',
        kind: 'unit',
      },
    ],
  ],
  // Shipped when UX-050 to UX-055 closed (2026-11-26): commands, panels, status items and client
  // filters of host extensions, in the shell and in the real element with the reference host's sample.
  [
    'host-panels-and-commands',
    [
      { path: 'packages/element/e2e/ux-050-extensions.spec.ts', kind: 'playwright' },
      { path: 'packages/element/e2e/ux-050-sample-extension.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-050-extensions.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-051-extension-controls.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/test/extension-commands.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/extension-contributions.test.ts', kind: 'unit' },
      { path: 'packages/ui/test/extension-status-bar.test.ts', kind: 'unit' },
      { path: 'apps/reference-host/test/sample-extension.test.ts', kind: 'unit' },
      { path: 'packages/ui/e2e/extension-contributions.spec.ts', kind: 'playwright' },
      { path: 'packages/ui/e2e/ux-055-import-filters.spec.ts', kind: 'playwright' },
    ],
  ],
];

export const ROW_TESTS: ReadonlyMap<string, readonly TestLink[]> = new Map(ROW_TEST_ENTRIES);

/** A test file: `*.test.ts` or `*.spec.ts`. Images and other evidence are not accepted. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}
