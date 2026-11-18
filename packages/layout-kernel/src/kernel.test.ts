/**
 * The WebAssembly package of the layout kernel (WASM-001), in Node.js: the generated ES module and
 * the WebAssembly file in `dist/` start through `createKernel`, answer the calls of the crate with
 * the values of its native tests, and need nothing from the host beyond the glue's own file.
 *
 * `dist/` is build output (`pnpm --filter @docedit/layout-kernel build:wasm`, which needs Podman).
 * Where it has not been built these tests skip, unless `DOCEDIT_KERNEL_REQUIRED=1` is set, which
 * `pnpm --filter @docedit/layout-kernel test:wasm` does by building first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KERNEL_ABI_VERSION, KERNEL_FILES, createKernel, type KernelGlue } from './index.ts';

const distDir = new URL('../dist/', import.meta.url);
const file = (name: string): URL => new URL(name, distDir);
const built = existsSync(file(KERNEL_FILES.wasm));
const required = process.env['DOCEDIT_KERNEL_REQUIRED'] === '1';

if (required && !built) throw new Error('dist/ is not built: run build:wasm first');

describe.skipIf(!built)('the layout kernel package (WASM-001)', () => {
  const wasm = (): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(file(KERNEL_FILES.wasm)));
  const glue = async (): Promise<KernelGlue> =>
    (await import(file(KERNEL_FILES.module).href)) as KernelGlue;

  it('starts from the generated module and the bytes, and reports its versions', async () => {
    const kernel = createKernel(await glue(), wasm());
    expect(kernel.abi).toBe(KERNEL_ABI_VERSION);
    expect(kernel.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('computes in the module what the crate computes natively (FNV-1a test vectors)', async () => {
    const kernel = createKernel(await glue(), wasm());
    const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(kernel.checksum(bytes(''))).toBe(0x811c9dc5);
    expect(kernel.checksum(bytes('a'))).toBe(0xe40c292c);
    expect(kernel.checksum(bytes('foobar'))).toBe(0xbf9cf968);
    expect(kernel.checksum(new Uint8Array(100_000).fill(7))).toBe(
      kernel.checksum(new Uint8Array(100_000).fill(7)),
    );
  });

  it('refuses a module whose interface version differs from the package expectation', async () => {
    const real = await glue();
    const stale: KernelGlue = { ...real, abi_version: () => KERNEL_ABI_VERSION + 1 };
    expect(() => createKernel(stale, wasm())).toThrow(/interface version/);
  });

  it('imports nothing from the host but its own glue: no system library, no font stack', () => {
    const module = new WebAssembly.Module(wasm());
    const modules = new Set(WebAssembly.Module.imports(module).map((i) => i.module));
    // wasm-bindgen links the module to its generated file by that file's name, and to nothing else:
    // no `env`, no WASI, no `js_sys` or `web_sys` import of the browser.
    expect([...modules].every((m) => m === './docedit_layout_kernel_bg.js')).toBe(true);
    const exportsOf = WebAssembly.Module.exports(module).map((e) => e.name);
    expect(exportsOf).toEqual(
      expect.arrayContaining(['kernel_version', 'abi_version', 'checksum']),
    );
  });

  it('ships typings for the three calls and a record of what built the file', () => {
    const typings = readFileSync(file(KERNEL_FILES.typings), 'utf8');
    for (const name of ['kernel_version', 'abi_version', 'checksum'])
      expect(typings).toContain(`export function ${name}(`);
    const record = JSON.parse(readFileSync(file(KERNEL_FILES.record), 'utf8')) as {
      rustc: string;
      wasm: { bytes: number; sha256: string };
    };
    expect(record.rustc).toContain('1.89.0');
    expect(record.wasm.bytes).toBe(wasm().length);
    expect(record.wasm.sha256).toBe(createHash('sha256').update(wasm()).digest('hex'));
  });
});
