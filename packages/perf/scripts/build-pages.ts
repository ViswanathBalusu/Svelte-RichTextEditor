/**
 * Builds the harness pages with Vite into dist/ (served by scripts/serve.ts):
 *
 * - `pages/editor.html`: one `<doc-editor>` from `@docedit/element` on a corpus document, compiled
 *   as the element's own spike build compiles it (Svelte `fragments: "tree"`, no injected styles);
 * - `pages/calibrate.html`: the calibration workload of ADR 0037;
 * - `pages/s5.html`: spike S5's measurement page; `pages/s10.html`: spike S10's kernel page.
 *
 * A production build (minified, no inlined assets), because the harness measures what users load.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

const started = performance.now();
await build({
  configFile: false,
  root: pkg,
  base: '/',
  logLevel: 'warn',
  plugins: [
    svelte({
      configFile: false,
      compilerOptions: { fragments: 'tree', css: 'external' },
      emitCss: false,
    }),
  ],
  worker: { format: 'es' },
  build: {
    outDir: join(pkg, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    assetsInlineLimit: 0,
    sourcemap: true,
    // DOCEDIT_PERF_MINIFY=0 keeps names readable in CPU profiles.
    minify: process.env['DOCEDIT_PERF_MINIFY'] !== '0',
    rollupOptions: {
      input: {
        editor: join(pkg, 'pages/editor.html'),
        calibrate: join(pkg, 'pages/calibrate.html'),
        s5: join(pkg, 'pages/s5.html'),
        s10: join(pkg, 'pages/s10.html'),
        s9: join(pkg, 'pages/s9.html'),
      },
    },
  },
});
console.log(`perf pages: built in ${((performance.now() - started) / 1000).toFixed(1)} s`);
