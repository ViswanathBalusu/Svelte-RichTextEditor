/**
 * The administration console (UX-089) is its own bundle: a static page built into
 * `dist/admin/`, apart from the host's SvelteKit build and from the component's bundle. It talks
 * to the administration API from the browser, so the tenant must list the page's origin
 * (05 §4). Build: `pnpm --filter @docedit/reference-host build:admin`.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: './',
  plugins: [svelte({ compilerOptions: { fragments: 'tree' } })],
  build: {
    outDir: fileURLToPath(new URL('../dist/admin', import.meta.url)),
    emptyOutDir: true,
    target: 'es2023',
  },
});
