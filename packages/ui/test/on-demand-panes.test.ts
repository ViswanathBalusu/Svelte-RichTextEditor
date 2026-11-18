/**
 * Each pane is a separate chunk that is requested only when it is first opened (UX-070, criterion
 * 1). These are source checks: every pane component is reached through a dynamic `import()` in the
 * pane table, and no module imports a pane statically, so the bundler cuts a chunk for each. The
 * registry does not call a loader to answer whether a pane is offered (`test/panes.test.ts`). A
 * network trace of the running editor is still needed before this counts as shown (ADR 0137,
 * decision 3).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const panesDir = fileURLToPath(new URL('../src/panes', import.meta.url));
const paneTable = readFileSync(
  fileURLToPath(new URL('../src/shell/panes.ts', import.meta.url)),
  'utf8',
);

/** Panes that an extension contributes, loaded by the host that installs it (UX-060). */
const EXTENSION_PANES = ['SandboxPane.svelte'];

/** Every component and module of the shell's source, by path relative to `src`. */
function shellSources(): Array<{ file: string; text: string }> {
  return readdirSync(srcDir, { recursive: true })
    .map(String)
    .filter((file) => /\.(ts|svelte)$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(srcDir, file), 'utf8') }));
}

/** A static import of a pane component, as opposed to a dynamic `import()` (type imports aside). */
const STATIC_PANE_IMPORT = /^\s*import\s+(?!type\b)[^;'"]*?from\s+['"][^'"]*panes\/[^'"]+['"]/m;

describe('each pane loads on demand, as its own chunk (UX-070, criterion 1)', () => {
  const paneFiles = readdirSync(panesDir).filter((file) => file.endsWith('.svelte'));

  it('there are panes to load (the test would be empty otherwise)', () => {
    expect(paneFiles.length).toBeGreaterThan(0);
  });

  it('every pane component is reached through a dynamic import in the pane table', () => {
    for (const file of paneFiles) {
      if (EXTENSION_PANES.includes(file)) continue;
      expect(paneTable).toContain(`import('../panes/${file}')`);
    }
  });

  it('a pane an extension contributes is not in the table, and the shell imports it nowhere', () => {
    // The sandbox panel (UX-060) is a pane descriptor the host builds for each installed extension
    // (`props`, `load` from the installing host), so it has no entry of its own in the table. The
    // check below still refuses any static import of it.
    // The table is `BUILT_IN_PANES`. The sandbox pane has a loader of its own below it, for the
    // host to pass to `sandboxedExtension`; the loader is a lazy `import()`, never a static import.
    const table = paneTable.slice(0, paneTable.indexOf('export const loadSandboxPane'));
    expect(table).toContain('BUILT_IN_PANES');
    expect(paneTable).toContain(
      "export const loadSandboxPane: PaneLoader = () => load(import('../panes/SandboxPane.svelte'));",
    );
    for (const file of EXTENSION_PANES) {
      expect(paneFiles).toContain(file);
      expect(table).not.toContain(`panes/${file}`);
    }
  });

  it('each loader is a function that starts the import, so nothing loads before it is called', () => {
    expect(paneTable).toMatch(/load: \(\) => load\(import\('\.\.\/panes\/OutlinePane\.svelte'\)\)/);
    expect(paneTable).not.toMatch(/^import .*panes\/.*\.svelte'/m);
  });

  it('the static-import pattern catches a static pane import, so the check below can fail', () => {
    expect(STATIC_PANE_IMPORT.test("import Outline from './panes/OutlinePane.svelte';")).toBe(true);
    expect(STATIC_PANE_IMPORT.test("const x = import('../panes/OutlinePane.svelte');")).toBe(false);
  });

  it('no module of the shell imports a pane component statically', () => {
    for (const { file, text } of shellSources()) {
      expect(STATIC_PANE_IMPORT.test(text), `${file} imports a pane statically`).toBe(false);
    }
  });
});
