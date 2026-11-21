/**
 * FE-002, criterion 1: the shape of the library build. `structureOf` (scripts/bundle-report.ts)
 * reads it from the bundler's output, and `node scripts/build.ts` fails on any violation. The chunks
 * here are synthetic; the real build is checked by e2e/fe-002-library-build.spec.ts, which reads the
 * report of the build its pages are served from.
 *
 * Also here: the configuration that keeps the first interactive editor small (13 §9). The library
 * is minified with its whitespace removed, and every pane of the shell's registry has a loader that
 * is a dynamic `import()`, so each is a chunk of its own.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleReport,
  structureOf,
  type AssetInfo,
  type ChunkInfo,
} from '../scripts/bundle-report.ts';
import { LIBRARY_MINIFY, libraryConfig } from '../scripts/vite-configs.ts';

const root = 'E:/repo';
const ui = `${root}/packages/ui/src`;
const element = `${root}/packages/element/src`;

function chunk(fileName: string, ids: string[], extra: Partial<ChunkInfo> = {}): ChunkInfo {
  return {
    fileName,
    isEntry: false,
    isDynamicEntry: false,
    imports: [],
    dynamicImports: [],
    moduleIds: ids,
    code: `export const name = ${JSON.stringify(fileName)};`,
    ...extra,
  };
}
const lazy = (fileName: string, ids: string[]) => chunk(fileName, ids, { isDynamicEntry: true });

const entry = chunk('doc-editor.js', [`${element}/index.ts`, `${element}/doc-editor.ts`], {
  isEntry: true,
});
const editor = chunk('chunks/editor-a.js', [`${element}/editor.ts`, `${ui}/App.svelte`], {
  isDynamicEntry: true,
  imports: ['chunks/styles-a.js'],
});
const styles = chunk('chunks/styles-a.js', [
  `${element}/styles.ts`,
  `${element}/styles/element.css?inline`,
  `${ui}/styles/shell.css?inline`,
]);
const outline = lazy('chunks/OutlinePane-a.js', [`${ui}/panes/OutlinePane.svelte`]);
const history = lazy('chunks/HistoryPane-a.js', [
  `${ui}/panes/HistoryPane.svelte`,
  `${ui}/shell/history-pane.ts`,
]);
const mathField = lazy('chunks/math-field-a.js', [`${element}/math-field.ts`]);
const mathlive = lazy('chunks/mathlive.min-a.js', [
  `${root}/node_modules/.pnpm/mathlive@0.111.4/node_modules/mathlive/mathlive.min.mjs`,
]);
const controller = lazy('chunks/viewer-frame-a.js', [`${element}/pdf/viewer-frame.ts`]);
const dep = lazy('chunks/dep-client-a.js', [
  `${root}/packages/backend-dep/src/backend.ts`,
  `${root}/packages/protocol/src/definition/wire.ts`,
]);
const good = [entry, editor, styles, outline, history, mathField, mathlive, controller, dep];
const first = new Set(['doc-editor.js', 'chunks/editor-a.js', 'chunks/styles-a.js']);
const viewer = [
  'viewer/pdf-viewer.html',
  'viewer/assets/pdf-viewer-a.js',
  'viewer/assets/pdf-viewer-a.css',
  'viewer/assets/pdf.worker.min-a.mjs',
];

const without = (...gone: ChunkInfo[]) => good.filter((c) => !gone.includes(c));

describe('the shape of the library build (FE-002 criterion 1)', () => {
  it('reads one entry, a lazy chunk for each pane, the math editor, the viewer and its worker', () => {
    const s = structureOf(good, first, viewer);
    expect(s.violations).toEqual([]);
    expect(s.entries).toEqual(['doc-editor.js']);
    expect(s.panes).toEqual([
      { pane: 'HistoryPane', file: 'chunks/HistoryPane-a.js' },
      { pane: 'OutlinePane', file: 'chunks/OutlinePane-a.js' },
    ]);
    expect(s.mathEditor).toEqual(['chunks/math-field-a.js', 'chunks/mathlive.min-a.js']);
    expect(s.pdfViewer).toEqual([
      'chunks/viewer-frame-a.js',
      'viewer/assets/pdf-viewer-a.css',
      'viewer/assets/pdf-viewer-a.js',
      'viewer/pdf-viewer.html',
    ]);
    expect(s.pdfWorker).toEqual(['viewer/assets/pdf.worker.min-a.mjs']);
  });

  it('finds the component CSS as a string in the editor’s chunks and no stylesheet file', () => {
    const s = structureOf(good, first, viewer);
    expect(s.cssChunks).toEqual(['chunks/styles-a.js']);
    expect(s.stylesheetFiles).toEqual([]);
    // The viewer frame's page has a stylesheet of its own; it is the frame document's.
    expect(s.pdfViewer).toContain('viewer/assets/pdf-viewer-a.css');
  });

  it('reads Windows paths the same way', () => {
    const windows = good.map((c) => ({
      ...c,
      moduleIds: c.moduleIds.map((id) => id.replaceAll('/', '\\')),
    }));
    const s = structureOf(windows, first, viewer);
    expect(s.violations).toEqual([]);
    expect(s.panes).toHaveLength(2);
    expect(s.cssChunks).toEqual(['chunks/styles-a.js']);
  });

  it('refuses a second entry, and an entry under another name', () => {
    const second = chunk('other.js', [`${element}/other.ts`], { isEntry: true });
    expect(structureOf([...good, second], first, viewer).violations).toEqual([
      'the build must have one entry, doc-editor.js; it has doc-editor.js, other.js',
    ]);
    const renamed = [{ ...entry, fileName: 'index.js' }, ...without(entry)];
    expect(structureOf(renamed, first, viewer).violations).toEqual([
      'the build must have one entry, doc-editor.js; it has index.js',
    ]);
    expect(structureOf(without(entry), first, viewer).violations).toEqual([
      'the build must have one entry, doc-editor.js; it has none',
    ]);
  });

  it('refuses a pane that loads with the editor, shares a chunk or is not loaded on demand', () => {
    const inEditor = {
      ...editor,
      moduleIds: [...editor.moduleIds, `${ui}/panes/OutlinePane.svelte`],
    };
    expect(structureOf([inEditor, ...without(editor, outline)], first, viewer).violations).toEqual([
      'panes: chunks/editor-a.js holds OutlinePane and is needed for the first interactive editor',
    ]);
    const both = lazy('chunks/panes-a.js', [
      `${ui}/panes/OutlinePane.svelte`,
      `${ui}/panes/HistoryPane.svelte`,
    ]);
    expect(structureOf([both, ...without(outline, history)], first, viewer).violations).toEqual([
      'panes: chunks/panes-a.js holds more than one pane (OutlinePane, HistoryPane)',
    ]);
    const shared = chunk('chunks/OutlinePane-a.js', [`${ui}/panes/OutlinePane.svelte`]);
    expect(structureOf([shared, ...without(outline)], first, viewer).violations).toEqual([
      'panes: chunks/OutlinePane-a.js holds OutlinePane and is not loaded on demand',
    ]);
    expect(structureOf(without(outline, history), first, viewer).violations).toEqual([
      'panes: the build has no pane chunk',
    ]);
  });

  it('refuses a math editor that loads with the editor, and a build without one', () => {
    const inEditor = { ...editor, moduleIds: [...editor.moduleIds, ...mathlive.moduleIds] };
    expect(structureOf([inEditor, ...without(editor, mathlive)], first, viewer).violations).toEqual(
      ['math editor: chunks/editor-a.js is needed for the first interactive editor'],
    );
    expect(structureOf(without(mathlive, mathField), first, viewer).violations).toEqual([
      'math editor: the build has no chunk with MathLive',
    ]);
  });

  it('refuses a viewer that loads with the editor or has no page or worker of its own', () => {
    const pdfjs = `${root}/node_modules/.pnpm/pdfjs-dist@6.5.438/node_modules/pdfjs-dist/build/pdf.mjs`;
    const inEditor = { ...editor, moduleIds: [...editor.moduleIds, pdfjs] };
    expect(structureOf([inEditor, ...without(editor)], first, viewer).violations).toEqual([
      'pdf viewer: chunks/editor-a.js is needed for the first interactive editor',
    ]);
    expect(structureOf(without(controller), first, viewer).violations).toEqual([
      'pdf viewer: the build has no chunk with the viewer frame’s controller',
    ]);
    expect(structureOf(good, first, []).violations).toEqual([
      'pdf viewer: the page of the viewer frame and its script are missing',
      'pdf worker: the viewer has no worker file of its own',
    ]);
    expect(
      structureOf(
        good,
        first,
        viewer.filter((f) => !f.includes('worker')),
      ).violations,
    ).toEqual(['pdf worker: the viewer has no worker file of its own']);
  });

  it('refuses a stylesheet file of the component, and CSS that does not load with the editor', () => {
    const assets: AssetInfo[] = [
      { fileName: 'assets/doc-editor-a.css', source: '.de-shell{}' },
      { fileName: 'assets/kernel-a.wasm', source: new Uint8Array(4) },
    ];
    expect(structureOf(good, first, viewer, assets).violations).toEqual([
      'stylesheet: the library build emitted assets/doc-editor-a.css; the component CSS ships as a string',
    ]);
    expect(structureOf(good, first, viewer, assets).stylesheetFiles).toEqual([
      'assets/doc-editor-a.css',
    ]);
    const lazyStyles = lazy('chunks/styles-a.js', styles.moduleIds as string[]);
    const firstWithout = new Set(['doc-editor.js', 'chunks/editor-a.js']);
    expect(structureOf([lazyStyles, ...without(styles)], firstWithout, viewer).violations).toEqual([
      'stylesheet: chunks/styles-a.js carries the component CSS and does not load with the editor',
    ]);
    expect(structureOf(without(styles), first, viewer).violations).toEqual([
      'stylesheet: no chunk carries the component CSS as a string',
    ]);
  });

  it('does not take the CSS of a dependency for the component’s', () => {
    const katex = lazy('chunks/katex-a.js', [
      `${root}/node_modules/.pnpm/katex@0.19.1/node_modules/katex/dist/katex.min.css?inline`,
    ]);
    const s = structureOf([...good, katex], first, viewer);
    expect(s.violations).toEqual([]);
    expect(s.cssChunks).toEqual(['chunks/styles-a.js']);
  });

  it('refuses the protocol definition in the first interactive set of a host backend', () => {
    const wire = chunk('chunks/wire-a.js', [`${root}/packages/protocol/src/definition/wire.ts`]);
    const withWire = [{ ...entry, imports: ['chunks/wire-a.js'] }, wire, ...without(entry)];
    expect(
      structureOf(withWire, new Set([...first, 'chunks/wire-a.js']), viewer).violations,
    ).toEqual([
      'first interactive editor: chunks/wire-a.js holds the protocol definition, which only the DEP client reads',
    ]);
    // In the DEP client's own chunk it is where it belongs.
    expect(structureOf(good, first, viewer).violations).toEqual([]);
  });

  it('is part of the bundle report, with the viewer files the report found', () => {
    const report = bundleReport(good, null);
    expect(report.structure.entries).toEqual(['doc-editor.js']);
    expect(report.structure.panes.map((p) => p.pane)).toEqual(['HistoryPane', 'OutlinePane']);
    // Without a viewer directory the report says what is missing; the build always gives one.
    expect(report.structure.violations).toEqual([
      'pdf viewer: the page of the viewer frame and its script are missing',
      'pdf worker: the viewer has no worker file of its own',
    ]);
  });
});

describe('the configuration that makes the shape (FE-002)', () => {
  const packages = resolve(import.meta.dirname, '../..');

  it('builds one ES module entry in library mode, named doc-editor.js', () => {
    const lib = libraryConfig().build?.lib;
    expect(lib).toBeTruthy();
    if (!lib) return;
    expect(lib.formats).toEqual(['es']);
    expect(typeof lib.entry).toBe('string');
    expect(String(lib.entry).replaceAll('\\', '/')).toMatch(/\/packages\/element\/src\/index\.ts$/);
    expect((lib.fileName as () => string)()).toBe('doc-editor.js');
  });

  it('removes the whitespace of the library’s chunks, which Vite keeps for an ES library', () => {
    expect(LIBRARY_MINIFY).toEqual({
      compress: true,
      mangle: true,
      codegen: { removeWhitespace: true },
    });
    const output = libraryConfig().build?.rollupOptions?.output;
    expect(Array.isArray(output)).toBe(false);
    expect((output as { minify?: unknown }).minify).toBe(LIBRARY_MINIFY);
    expect(libraryConfig().build?.minify).toBe(true);
  });

  it('gives every pane of the shell’s registry a loader that is a dynamic import of its own', () => {
    const registry = readFileSync(resolve(packages, 'ui/src/shell/panes.ts'), 'utf8');
    const builtIn = registry.slice(
      registry.indexOf('export const BUILT_IN_PANES'),
      registry.indexOf('export const loadSandboxPane'),
    );
    const loaded = [...builtIn.matchAll(/load\(import\('\.\.\/panes\/(\w+)\.svelte'\)\)/g)].map(
      (m) => m[1]!,
    );
    expect(loaded.length).toBeGreaterThanOrEqual(16);
    expect(new Set(loaded).size).toBe(loaded.length);
    // Every pane component in the folder is reached that way, except the sandbox pane, which a
    // host passes to an extension itself and the element's build does not hold.
    const files = readdirSync(resolve(packages, 'ui/src/panes'))
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => f.replace(/\.svelte$/, ''))
      .sort();
    expect([...loaded, 'SandboxPane'].sort()).toEqual(files);
    // No pane component is imported statically by the shell or the element.
    const statics = /import\s+\w+\s+from\s+'[^']*\/panes\/\w+\.svelte'/;
    for (const file of ['ui/src/App.svelte', 'ui/src/shell/panes.ts', 'element/src/editor.ts'])
      expect(statics.test(readFileSync(resolve(packages, file), 'utf8')), file).toBe(false);
  });
});
