/**
 * FE-002, criteria 1 and 5, on the library build the pages are served from (`pages/lib.html` loads
 * `/lib/doc-editor.js` by URL, as a host does; the web server of this suite has just built it).
 *
 * Criterion 1: the build's own report (`/lib/bundle-report.json`, scripts/bundle-report.ts) is read
 * over HTTP, so it is the report of the very files under test. It must show one ES module entry, a
 * lazy chunk of its own for each pane of the shell's registry, for the math editor and for the PDF
 * viewer's controller, the viewer frame's page with its worker as a file of its own, and no
 * stylesheet file of the component. Each of those files is then fetched. In the browser, opening a
 * document requests none of them and no stylesheet: the component's CSS arrives as a string in a
 * script chunk and is adopted into a constructable sheet (ADR 0039 §3; owner decision 18).
 *
 * Criterion 5: a third-party piece that registers global custom elements, the math editor. When
 * the editor has started and shows a document with equations, none of the tag names the
 * integration guide lists is registered and no chunk of the math editor was requested. When the
 * math editor is first opened, exactly those names appear.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57802 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-002-library-build.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { openLib } from './embed-helpers.ts';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

interface BuildReport {
  firstInteractive: { files: string[] };
  firstInteractiveWithDep: { files: string[] } | null;
  chunks: Array<{ file: string; kind: string }>;
  structure: {
    entries: string[];
    panes: Array<{ pane: string; file: string }>;
    pdfViewer: string[];
    pdfWorker: string[];
    mathEditor: string[];
    stylesheetFiles: string[];
    cssChunks: string[];
    violations: string[];
  };
}

/** The pane components the shell's registry loads (packages/ui/src/shell/panes.ts). */
function registryPanes(): string[] {
  const registry = read('../../ui/src/shell/panes.ts');
  const builtIn = registry.slice(
    registry.indexOf('export const BUILT_IN_PANES'),
    registry.indexOf('export const loadSandboxPane'),
  );
  return [...builtIn.matchAll(/load\(import\('\.\.\/panes\/(\w+)\.svelte'\)\)/g)]
    .map((m) => m[1]!)
    .sort();
}

/**
 * The global custom elements of the math editor, as the integration guide lists them
 * (docs/policies-and-side-effects.md, "Global side effects visible to the host page").
 */
function guideMathTags(): string[] {
  const guide = read('../docs/policies-and-side-effects.md');
  const start = guide.indexOf('## Global side effects visible to the host page');
  expect(start).toBeGreaterThan(0);
  const bullets = guide
    .slice(start)
    .split(/\n(?=- )/)
    .filter((b) => b.startsWith('- The custom elements') && /MathLive/.test(b));
  expect(bullets).toHaveLength(1);
  const sentence = bullets[0]!.slice(0, bullets[0]!.indexOf('.'));
  return [...sentence.matchAll(/`([a-z]+-[a-z-]+)`/g)].map((m) => m[1]!).sort();
}

/** Records the path of every request and the names given to `customElements.define`. */
async function instrument(page: Page): Promise<{ requested: string[]; errors: string[] }> {
  const requested: string[] = [];
  const errors: string[] = [];
  page.on('request', (r) => requested.push(new URL(r.url()).pathname));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __defined: string[] };
    w.__defined = [];
    const define = customElements.define.bind(customElements);
    customElements.define = (name: string, ...rest: [CustomElementConstructor, never?]) => {
      w.__defined.push(name);
      return define(name, ...rest);
    };
  });
  return { requested, errors };
}

/** Loads the library and mounts `<doc-editor data-test="lib">` on a document; `env` gives a document of its own. */
async function mount(page: Page, env: unknown = null): Promise<void> {
  const outcome = await page.evaluate(async (envelope) => {
    const lib = (
      window as unknown as {
        __lib: {
          load(): Promise<Record<string, unknown>>;
          service: {
            createDocument(env: unknown): string;
            backend(user: unknown, grants: Record<string, string>): unknown;
          };
          docId: string;
        };
      }
    ).__lib;
    const module = await lib.load();
    const id = envelope === null ? lib.docId : lib.service.createDocument(envelope);
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      config: unknown;
    };
    el.dataset['test'] = 'lib';
    el.config = { katexFontsUrl: `${location.origin}/vendor/katex/dist/fonts/` };
    const ready = new Promise<string>((resolve) => {
      el.addEventListener('de-ready', () => resolve('ready'), { once: true });
      el.addEventListener('de-error', () => resolve('error'), { once: true });
    });
    el.backend = lib.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
    el.setAttribute('doc-id', id);
    document.getElementById('mount')!.append(el);
    return { ready: await ready, exports: Object.keys(module).sort() };
  }, env);
  expect(outcome.ready).toBe('ready');
  // The entry is an ES module: its exports are what `import()` gave.
  expect(outcome.exports).toContain('DocEditorElement');
  expect(outcome.exports).toContain('defineDocEditor');
  await expect(page.locator('doc-editor[data-test="lib"] .de-editing-surface')).toBeVisible();
}

const EDITOR = 'doc-editor[data-test="lib"]';

test.describe('FE-002 the library build', () => {
  test('one ES module entry, lazy chunks of their own, and the CSS as a string (criterion 1)', async ({
    page,
    request,
  }) => {
    const response = await request.get('/lib/bundle-report.json');
    expect(response.status()).toBe(200);
    const report = (await response.json()) as BuildReport;
    const s = report.structure;
    expect(s.violations).toEqual([]);

    // One entry, and it is the file a host imports.
    expect(s.entries).toEqual(['doc-editor.js']);
    expect(report.chunks.filter((c) => c.kind === 'entry').map((c) => c.file)).toEqual([
      'doc-editor.js',
    ]);

    // Nothing lazy is part of the first interactive editor, with a host backend or the DEP client.
    const firstSets = new Set([
      ...report.firstInteractive.files,
      ...(report.firstInteractiveWithDep?.files ?? []),
    ]);
    const kindOf = (file: string) => report.chunks.find((c) => c.file === file)?.kind;

    // Each pane of the shell's registry is a lazy chunk of its own.
    const panes = registryPanes();
    expect(panes.length).toBeGreaterThanOrEqual(16);
    expect(s.panes.map((p) => p.pane).sort()).toEqual(panes);
    expect(new Set(s.panes.map((p) => p.file)).size).toBe(panes.length);
    for (const pane of s.panes) {
      expect(pane.file, pane.pane).toMatch(new RegExp(`^chunks/${pane.pane}-[\\w-]+\\.js$`));
      expect(kindOf(pane.file), pane.file).toBe('lazy');
      expect(firstSets.has(pane.file), pane.file).toBe(false);
    }

    // The math editor: the module that mounts the field, and MathLive.
    expect(s.mathEditor.some((f) => /^chunks\/math-field-[\w-]+\.js$/.test(f))).toBe(true);
    expect(s.mathEditor.some((f) => /^chunks\/mathlive[\w.-]*\.js$/.test(f))).toBe(true);
    for (const file of s.mathEditor) {
      expect(kindOf(file), file).toBe('lazy');
      expect(firstSets.has(file), file).toBe(false);
    }

    // The PDF viewer: its controller is a lazy chunk; its frame has a page, a script and a worker.
    const controller = s.pdfViewer.filter((f) => f.startsWith('chunks/'));
    expect(controller).toHaveLength(1);
    expect(kindOf(controller[0]!)).toBe('lazy');
    expect(firstSets.has(controller[0]!)).toBe(false);
    expect(s.pdfViewer).toContain('viewer/pdf-viewer.html');
    expect(s.pdfViewer.some((f) => /^viewer\/assets\/pdf-viewer-[\w-]+\.js$/.test(f))).toBe(true);
    expect(s.pdfWorker.length).toBeGreaterThanOrEqual(1);
    for (const file of s.pdfWorker)
      expect(file).toMatch(/^viewer\/assets\/pdf\.worker[\w.-]*\.m?js$/);

    // The component's CSS: no stylesheet file, a string in a chunk the editor loads at once.
    expect(s.stylesheetFiles).toEqual([]);
    expect(s.cssChunks.length).toBeGreaterThanOrEqual(1);
    for (const file of s.cssChunks) expect(report.firstInteractive.files, file).toContain(file);

    // Every one of those files is in the build, a file of its own.
    const files = [
      ...s.entries,
      ...s.panes.map((p) => p.file),
      ...s.mathEditor,
      ...s.pdfViewer,
      ...s.pdfWorker,
      ...s.cssChunks,
    ];
    for (const file of files) {
      const got = await request.get(`/lib/${file}`);
      expect(got.status(), file).toBe(200);
      expect((await got.body()).length, file).toBeGreaterThan(0);
    }
    const css = await (await request.get(`/lib/${s.cssChunks[0]!}`)).text();
    expect(css).toContain('.de-shell');

    // In the browser: a document opens without any of the lazy files and without a stylesheet.
    const { requested, errors } = await instrument(page);
    await openLib(page);
    const before = await page.evaluate(() => ({
      sheets: document.styleSheets.length,
      adopted: document.adoptedStyleSheets.length,
    }));
    await mount(page);
    const lib = requested.filter((p) => p.startsWith('/lib/')).map((p) => p.slice('/lib/'.length));
    expect(lib).toContain('doc-editor.js');
    for (const file of s.cssChunks) expect(lib, file).toContain(file);
    const lazyFiles = new Set([
      ...s.panes.map((p) => p.file),
      ...s.mathEditor,
      ...s.pdfViewer,
      ...s.pdfWorker,
    ]);
    expect(lib.filter((p) => lazyFiles.has(p))).toEqual([]);
    expect(requested.filter((p) => p.endsWith('.css'))).toEqual([]);
    const styles = await page.evaluate((selector) => {
      const root = document.querySelector(selector)!.shadowRoot!;
      const adopted = root.adoptedStyleSheets;
      return {
        adopted: adopted.length,
        shellRule: adopted.some((sheet) =>
          [...sheet.cssRules].some((rule) => rule.cssText.includes('.de-shell')),
        ),
        styleElements: root.querySelectorAll('style, link[rel="stylesheet"]').length,
        pageSheets: document.styleSheets.length,
        pageAdopted: document.adoptedStyleSheets.length,
        links: document.querySelectorAll('link[rel="stylesheet"]').length,
      };
    }, EDITOR);
    expect(styles.adopted).toBeGreaterThanOrEqual(1);
    expect(styles.shellRule).toBe(true);
    expect(styles.styleElements).toBe(0);
    expect(styles.pageSheets).toBe(before.sheets);
    expect(styles.pageAdopted).toBe(before.adopted);
    expect(styles.links).toBe(0);
    expect(errors).toEqual([]);
  });

  test('the math editor’s custom elements appear on first use only, exactly the guide’s (criterion 5)', async ({
    page,
    request,
  }) => {
    const tags = guideMathTags();
    expect(tags).toEqual(['math-div', 'math-field', 'math-span']);
    const report = (await (await request.get('/lib/bundle-report.json')).json()) as BuildReport;
    const mathFiles = new Set(report.structure.mathEditor);
    expect(mathFiles.size).toBeGreaterThanOrEqual(2);

    const { requested, errors } = await instrument(page);
    await openLib(page);
    await mount(page, JSON.parse(read('../../model/fixtures/kitchen-sink.json')));
    // The document has equations and they are drawn: the display of an equation is not the editor.
    await expect(page.locator(`${EDITOR} .de-equation .katex`).first()).toBeVisible({
      timeout: 15_000,
    });

    // When the editor has started: nothing of the math editor is registered or requested.
    const libRequests = () =>
      requested.filter((p) => p.startsWith('/lib/')).map((p) => p.slice('/lib/'.length));
    const registered = () =>
      page.evaluate(
        (names) => ({
          defined: (window as unknown as { __defined: string[] }).__defined,
          known: names.filter((name) => customElements.get(name) !== undefined),
        }),
        tags,
      );
    const atStart = await registered();
    expect(atStart.defined).toEqual(['doc-editor']);
    expect(atStart.known).toEqual([]);
    expect(libRequests().filter((p) => mathFiles.has(p))).toEqual([]);

    // First use: select the equation and open the math editor from the keyboard.
    await page.locator(`${EDITOR} .de-equation`).first().click();
    await expect(page.locator(`${EDITOR} .ProseMirror-selectednode`)).toHaveCount(1);
    await page.keyboard.press('Enter');
    const dialog = page.locator(`${EDITOR} dialog[data-dialog="math"]`);
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-state="ready"]')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.locator('math-field')).toBeVisible();

    // Exactly the names the guide lists appeared, and its chunks came from the module's directory.
    const afterUse = await registered();
    expect(afterUse.defined.filter((name) => name !== 'doc-editor').sort()).toEqual(tags);
    expect(afterUse.known.sort()).toEqual(tags);
    expect(
      libRequests()
        .filter((p) => mathFiles.has(p))
        .sort(),
    ).toEqual([...mathFiles].sort());
    expect(errors).toEqual([]);
  });
});
