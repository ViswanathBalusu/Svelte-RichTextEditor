/**
 * Download size of each S10 kernel (SPK-023) and of each S5 shaper: builds one minified bundle per
 * kernel with Vite (the kernel, its WebAssembly loader and its dependencies, as a layout worker
 * would load them) into a temporary directory, and reports the JavaScript and WebAssembly bytes,
 * raw, gzip level 9 and Brotli quality 11. Writes test-results/s10/sizes.json.
 *
 * Usage: node scripts/kernel-sizes.ts   (from packages/perf)
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { build } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

const entries: Record<string, string> = {
  'ts-kernel': `import { loadHarfbuzz } from '${pkg.replaceAll('\\', '/')}/src/shapers/harfbuzz.ts';
import { tsKernel } from '${pkg.replaceAll('\\', '/')}/src/kernel/ts-kernel.ts';
export async function start() { return tsKernel((await loadHarfbuzz()).shaper); }`,
  'rust-kernel': `import { loadTextKernel } from '${pkg.replaceAll('\\', '/')}/src/shapers/harfrust.ts';
import { rustKernel } from '${pkg.replaceAll('\\', '/')}/src/kernel/rust-kernel.ts';
export async function start(bytes) { return rustKernel((await loadTextKernel(bytes)).module); }`,
};

interface Size {
  bytes: number;
  gzip9: number;
  brotli11: number;
}

function size(b: Uint8Array): Size {
  return {
    bytes: b.length,
    gzip9: gzipSync(b, { level: 9 }).length,
    brotli11: brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function add(a: Size, b: Size): Size {
  return { bytes: a.bytes + b.bytes, gzip9: a.gzip9 + b.gzip9, brotli11: a.brotli11 + b.brotli11 };
}

const out: Record<string, unknown> = {};
const work = join(tmpdir(), 'docedit-perf-sizes');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
for (const [name, source] of Object.entries(entries)) {
  const entry = join(work, `${name}.js`);
  writeFileSync(entry, source);
  const outDir = join(work, `${name}-dist`);
  await build({
    configFile: false,
    logLevel: 'error',
    root: pkg,
    // An application build, not library mode: library mode inlines the WebAssembly file as
    // base64, which no production build would ship (ADR 0016; FND-008).
    build: {
      outDir,
      emptyOutDir: true,
      minify: true,
      target: 'es2022',
      assetsInlineLimit: 0,
      modulePreload: false,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        output: { entryFileNames: `${name}.js` },
      },
    },
  });
  let js: Size = { bytes: 0, gzip9: 0, brotli11: 0 };
  let wasm: Size = { bytes: 0, gzip9: 0, brotli11: 0 };
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      if (statSync(full).isDirectory()) walk(full);
      else {
        files.push(full.slice(outDir.length + 1));
        if (f.endsWith('.js') || f.endsWith('.mjs')) js = add(js, size(readFileSync(full)));
        if (f.endsWith('.wasm')) wasm = add(wasm, size(readFileSync(full)));
      }
    }
  };
  walk(outDir);
  if (name === 'rust-kernel') wasm = size(readFileSync(join(pkg, 'wasm/bin/text-kernel.wasm')));
  out[name] = { files, javascript: js, webassembly: wasm, total: add(js, wasm) };
}
out['harfrust-shaper.wasm (S5)'] = size(readFileSync(join(pkg, 'wasm/bin/harfrust-shaper.wasm')));
mkdirSync(join(pkg, 'test-results/s10'), { recursive: true });
writeFileSync(join(pkg, 'test-results/s10/sizes.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
