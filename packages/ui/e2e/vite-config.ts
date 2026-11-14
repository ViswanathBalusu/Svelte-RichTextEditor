/**
 * The Vite build of the shell's test harness (e2e/harness). The components are compiled as the
 * element compiles them (02 §3; spike S2): `fragments: "tree"`, so no HTML strings and no Trusted
 * Types policy; `css: "external"` and no emitted CSS, because the shell's stylesheet is adopted as
 * a constructable sheet. No module preload helper and no inlined assets, so a strict policy holds.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
export const uiDir = resolve(here, '..');
export const harnessDir = join(here, 'harness');
export const outDir = join(uiDir, 'dist', 'harness');

export function harnessConfig(): InlineConfig {
  return {
    configFile: false,
    root: harnessDir,
    base: '/',
    logLevel: 'warn',
    plugins: [
      svelte({
        configFile: false,
        compilerOptions: { fragments: 'tree', css: 'external' },
        emitCss: false,
      }),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      modulePreload: false,
      assetsInlineLimit: 0,
      sourcemap: true,
      minify: false,
      rollupOptions: {
        // Two pages: the shell's harness and the field properties panel alone (FRW-073).
        input: {
          index: join(harnessDir, 'index.html'),
          'field-properties': join(harnessDir, 'field-properties.html'),
        },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
}
