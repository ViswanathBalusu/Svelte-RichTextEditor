/**
 * Vite configurations of the element package (02 §2, §3; FE-002, FE-016; ADR 0039).
 *
 * - `libraryConfig`: the distributable, Vite library mode, one ES module entry (`doc-editor.js`)
 *   with lazily loaded chunks in `chunks/`: the editor (core, shell, Svelte, styles), each pane and
 *   the PDF viewer's controller. Output `dist/lib`.
 * - `viewerConfig`: the PDF viewer's page for its sandboxed frame (FE-071), with PDF.js, its worker
 *   and the decoders, fonts and CMaps PDF.js fetches. Output `dist/lib/viewer`.
 * - `demoConfig`: the component built from source together with the demo pages and the test hooks
 *   (`src/testing.ts`), for the end-to-end suites; `fragments: "html"` builds the negative control
 *   of spike S2. Output `dist/demo`.
 * - `svelteHostConfig`: a host application with its own Svelte 5 and default options (spike S2).
 *
 * Every component build compiles Svelte with `fragments: "tree"` (no HTML-string templates, no
 * Trusted Types policy of Svelte's own; FE-016) and `css: "external"` with `emitCss: false`: the
 * components have no style block, the styles are the element's one stylesheet.
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { cpSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineConfig, Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
export const elementDir = resolve(here, '..');
// `DOCEDIT_ELEMENT_DIST` (relative to the element package) gives one run its own output directory,
// so that parallel Playwright runs do not rebuild the directory another run is serving (U-PRO-086-102).
export const distDir = process.env['DOCEDIT_ELEMENT_DIST']
  ? resolve(elementDir, process.env['DOCEDIT_ELEMENT_DIST'])
  : join(elementDir, 'dist');
export const libDir = join(distDir, 'lib');
export const viewerDir = join(libDir, 'viewer');
export const demoDir = join(distDir, 'demo');

/**
 * The minimum browser versions the build targets (02 §12; FE-116; review F15). Browsers below them
 * are unsupported: Chrome and Edge 137 (`Selection.getComposedRanges()`), Firefox 142 (the shadow
 * selection APIs), Safari 17.
 */
export const BROWSER_MINIMUMS = ['chrome137', 'edge137', 'firefox142', 'safari17'] as const;

/** The Svelte compile options of every component build (FE-016). */
export const COMPONENT_COMPILER_OPTIONS = { fragments: 'tree', css: 'external' } as const;

function componentSvelte(fragments: 'tree' | 'html'): Plugin[] {
  return svelte({
    configFile: false,
    compilerOptions: { ...COMPONENT_COMPILER_OPTIONS, fragments },
    emitCss: false,
  }) as Plugin[];
}

/**
 * The layout kernel's files (WASM-002) are a build output of the Rust crate (`pnpm --filter
 * @docedit/layout-kernel build:wasm`, which needs Podman), not part of the repository. When they
 * are there, the bundler takes them: the WebAssembly file becomes an asset next to the chunks.
 * When they are not, the build still works and the kernel's loader reports `compile_failed` at run
 * time, so a checkout that never built the crate can build and test the rest.
 */
const KERNEL_DIST = resolve(elementDir, '../layout-kernel/dist');
const KERNEL_PREFIX = '@docedit/layout-kernel/wasm/';
const MISSING = '\0docedit-kernel-missing:';
export function kernelFiles(): Plugin {
  return {
    name: 'docedit-kernel-files',
    enforce: 'pre',
    resolveId(id) {
      if (!id.startsWith(KERNEL_PREFIX)) return null;
      const rest = id.slice(KERNEL_PREFIX.length);
      const file = rest.replace(/\?.*$/, '');
      // The package's `exports` map would keep the query in the file name, so the path is given here.
      if (existsSync(join(KERNEL_DIST, file)))
        return join(KERNEL_DIST, file).replaceAll('\\', '/') + rest.slice(file.length);
      this.warn(`the layout kernel is not built (${file}); the page view's loader will report it`);
      return `${MISSING}${id}`;
    },
    // wasm-bindgen's module starts, when it is given nothing, from `new URL('<name>_bg.wasm',
    // import.meta.url)`, which library mode would inline as base64 (FND-008 forbids it). The loader
    // always gives the module its file, so the default is cut out.
    transform(code, id) {
      if (!id.replaceAll('\\', '/').endsWith('/layout-kernel/dist/docedit_layout_kernel.js'))
        return null;
      const fallback = "new URL('docedit_layout_kernel_bg.wasm', import.meta.url)";
      if (!code.includes(fallback))
        this.error('the layout kernel glue has no default URL to cut out');
      return {
        map: null,
        code: code.replace(
          fallback,
          "(() => { throw new Error('the layout kernel needs its file given'); })()",
        ),
      };
    },
    load(id) {
      if (!id.startsWith(MISSING)) return null;
      if (id.includes('?')) return 'export default "";';
      const message = JSON.stringify('the layout kernel was not built into this bundle');
      return `export default async function init() { throw new Error(${message}); }`;
    },
  };
}

/**
 * The layout worker's script (WASM-004) is built as a module worker of its own, an asset next to the
 * chunks, never inlined as a blob or base64. It takes the kernel's files through the same plugin.
 */
function layoutWorker(): NonNullable<InlineConfig['worker']> {
  return {
    format: 'es',
    plugins: () => [kernelFiles()],
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  };
}

function base(outDir: string): InlineConfig {
  return {
    configFile: false,
    root: elementDir,
    logLevel: 'warn',
    build: {
      outDir,
      emptyOutDir: true,
      target: [...BROWSER_MINIMUMS],
      // No preload helper: it inserts <link> elements, which a strict host does not expect.
      modulePreload: false,
      // Fonts and other assets stay files, so `font-src 'self'` covers them (no data: URLs).
      assetsInlineLimit: 0,
      sourcemap: true,
      minify: true,
    },
  };
}

/**
 * How the library's chunks are minified (FE-002; 13 §9). For an ES library Vite 8 minifies names
 * and syntax and keeps the whitespace (`codegen: false`), because it expects a consumer's bundler
 * to minify the result. This distributable is also what a host loads by URL, and its first
 * interactive set has a size budget, so the whitespace is removed too. The `@__PURE__` annotations
 * stay in the output either way, so a host's bundler can still drop what it does not use.
 */
export const LIBRARY_MINIFY = {
  compress: true,
  mangle: true,
  codegen: { removeWhitespace: true },
} as const;

export function libraryConfig(): InlineConfig {
  const config = base(libDir);
  return {
    ...config,
    // Relative asset URLs: a lazy file (the kernel's WebAssembly) is found next to the chunk that
    // names it, wherever the host serves the component from (WASM-002).
    base: './',
    worker: layoutWorker(),
    plugins: [kernelFiles(), ...componentSvelte('tree')],
    build: {
      ...config.build,
      lib: {
        entry: join(elementDir, 'src/index.ts'),
        formats: ['es'],
        fileName: () => 'doc-editor.js',
      },
      rollupOptions: {
        output: {
          chunkFileNames: libraryChunkName,
          assetFileNames: 'assets/[name]-[hash][extname]',
          minify: LIBRARY_MINIFY,
        },
      },
    },
  };
}

/**
 * Chunk names that say what a chunk holds, so that the size report and the tests can tell the
 * DEP client and the editing core apart from the rest (FE-002).
 */
function libraryChunkName(chunk: { name: string; moduleIds: readonly string[] }): string {
  const has = (dir: string) => chunk.moduleIds.some((id) => id.replaceAll('\\', '/').includes(dir));
  if (has('/packages/backend-dep/src/')) return 'chunks/dep-client-[hash].js';
  if (has('/packages/element/src/editor.ts')) return 'chunks/editor-[hash].js';
  if (has('/packages/engine/src/')) return 'chunks/engine-[hash].js';
  return 'chunks/[name]-[hash].js';
}

/** Copies the data PDF.js fetches by URL (decoders, standard fonts, CMaps) next to the viewer. */
function pdfjsData(outDir: string): Plugin {
  const from = join(elementDir, 'node_modules/pdfjs-dist');
  return {
    name: 'docedit-pdfjs-data',
    apply: 'build',
    writeBundle() {
      for (const dir of ['wasm', 'standard_fonts', 'cmaps'])
        cpSync(join(from, dir), join(outDir, 'pdfjs', dir), { recursive: true });
    },
  };
}

export function viewerConfig(outDir = viewerDir): InlineConfig {
  const config = base(outDir);
  return {
    ...config,
    root: join(elementDir, 'src/pdf/viewer'),
    // Relative URLs throughout: the viewer works wherever its directory is served.
    base: './',
    plugins: [pdfjsData(outDir)],
    build: {
      ...config.build,
      // PDF.js and its worker are large by nature; they load only inside the viewer's frame.
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: { 'pdf-viewer': join(elementDir, 'src/pdf/viewer/pdf-viewer.html') },
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
}

const DEMO_SCRIPTS = [
  'spike-flags',
  's1-page',
  's2-page',
  'wasm-page',
  'probe-page',
  'host-loader',
  'embed-page',
  'lib-page',
];

export function demoConfig(fragments: 'tree' | 'html', withDemo: boolean): InlineConfig {
  const config = base(fragments === 'tree' ? demoDir : join(demoDir, 'control'));
  const input: Record<string, string> = { 'doc-editor': join(elementDir, 'src/index.ts') };
  if (withDemo)
    for (const name of DEMO_SCRIPTS) input[name] = join(elementDir, 'demo', `${name}.ts`);
  return {
    ...config,
    worker: layoutWorker(),
    plugins: [kernelFiles(), ...componentSvelte(fragments)],
    build: {
      ...config.build,
      rollupOptions: {
        input,
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
        preserveEntrySignatures: 'strict',
      },
    },
  };
}

export function svelteHostConfig(): InlineConfig {
  const config = base(join(demoDir, 'svelte-host'));
  return {
    ...config,
    plugins: svelte({ configFile: false }) as Plugin[],
    build: {
      ...config.build,
      rollupOptions: {
        input: { host: join(elementDir, 'demo/svelte-host/host.ts') },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
}

/**
 * The host that is rendered on a server and then hydrated (FE-124 criterion 3): a Svelte 5 host
 * with its own copy of Svelte and default compile options. `ssrHostClientConfig` builds the
 * browser bundle that hydrates; `ssrHostServerConfig` builds the server entry, which
 * `demo/ssr-host/prerender.ts` runs to write the page.
 */
export const ssrHostDir = join(demoDir, 'ssr-host');
export const ssrHostServerDir = join(distDir, 'ssr-host-server');

export function ssrHostClientConfig(): InlineConfig {
  const config = base(ssrHostDir);
  return {
    ...config,
    plugins: svelte({ configFile: false }) as Plugin[],
    build: {
      ...config.build,
      rollupOptions: {
        input: { client: join(elementDir, 'demo/ssr-host/client.ts') },
        output: {
          entryFileNames: 'assets/[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
}

export function ssrHostServerConfig(): InlineConfig {
  const config = base(ssrHostServerDir);
  return {
    ...config,
    plugins: svelte({ configFile: false }) as Plugin[],
    // The workspace packages are bundled, so that the server entry is one file; Svelte stays a
    // dependency the server resolves itself.
    ssr: { noExternal: [/^@docedit\//] },
    build: {
      ...config.build,
      ssr: join(elementDir, 'demo/ssr-host/entry-server.ts'),
      sourcemap: false,
      rollupOptions: { output: { entryFileNames: 'entry-server.js' } },
    },
  };
}
