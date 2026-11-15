/**
 * Architecture boundary checks (FND-004). Every rule cites the spec section behind it.
 * Run with `pnpm deps:check`; CI fails on any violation.
 *
 * Browser-only and Node.js-only globals in the universal packages are caught by the TypeScript
 * configuration instead (lib ES2023 and types [] in tsconfig.base.json), because they are not imports.
 */
const universal =
  '^packages/(model|authority|rules|layout|protocol|backend-mock|backend-dep|export-latex|export-docx|corpus|history)/';

module.exports = {
  forbidden: [
    {
      name: 'universal-no-node-builtins',
      comment:
        '01 §6: `authority` has no dependency on Node.js or the browser, so the same code runs in the room, the authority service, the local backend and tests. 02 §9.1: the layout engine is DOM-free. The same holds for `model` (CDM-006), `rules`, and the other universal packages of CLAUDE.md: `protocol`, `backend-mock`, `backend-dep`, `export-latex`, `export-docx` and `corpus`.',
      severity: 'error',
      // Tests, their helpers in `test/` and scripts run in Node.js only.
      from: { path: universal, pathNot: '(\\.test\\.ts$|/test/|/scripts/)' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'universal-no-dom-packages',
      comment:
        '01 §6 and 02 §9.1: universal packages must not reach browser-only code such as the view, the painter, the UI or the element.',
      severity: 'error',
      from: { path: universal },
      to: { path: '^packages/(painter|ui|element|backend-local)/|node_modules/prosemirror-view/' },
    },
    {
      name: 'ui-no-prosemirror',
      comment:
        "02 §5.1 and ADR 0003: the editing core sits behind the project's own document API; `ui` never imports a `prosemirror-*` module.",
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: '(^|node_modules/)prosemirror-' },
    },
    {
      name: 'hosts-no-prosemirror',
      comment:
        "FE-026 and 02 §5.1: a document changes only through the document API, so the element's source and the host applications reach ProseMirror only through `@docedit/engine`, never by importing a `prosemirror-*` module themselves.",
      severity: 'error',
      from: { path: '^(packages/element/src|apps)/' },
      to: { path: '(^|node_modules/)prosemirror-' },
    },
    {
      name: 'services-no-ui',
      comment:
        "01 §6 and R6: the backend never requires the component's code; a service must not import `ui`, `element` or `painter`.",
      severity: 'error',
      from: { path: '^services/' },
      to: { path: '^packages/(ui|element|painter)/' },
    },
    {
      name: 'no-circular',
      comment: 'Packages form a directed graph; a cycle means two packages are really one.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Build and test output (Vite bundles, Playwright results, generated scratch output) is not source.
    exclude: { path: '(^|/)(dist|coverage|node_modules|test-results|playwright-report|out)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
      extensions: ['.ts', '.js', '.json'],
    },
  },
};
