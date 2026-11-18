/**
 * The layout kernel as a package (ADR 0016; WASM-001). The kernel is the Rust crate of
 * `crates/layout-kernel`, compiled to WebAssembly, passed through wasm-bindgen and wasm-opt and
 * written to `dist/` by `pnpm --filter @docedit/layout-kernel build:wasm`. This module is the
 * TypeScript side: the types of what the module exports and `createKernel`, which starts it.
 *
 * It loads nothing by itself. Fetching the WebAssembly file on demand, inside a worker, with a
 * fallback when the host blocks WebAssembly, is WASM-002 to WASM-004; the caller passes the
 * generated ES module (`@docedit/layout-kernel/wasm/docedit_layout_kernel.js`) and the bytes.
 *
 * Universal: no DOM and no Node.js API (FND-004). The kernel reads no font stack of the system;
 * fonts arrive as bytes from the manifest (WASM-005).
 */

/** The version of the kernel's call interface that this package expects of the crate. */
export const KERNEL_ABI_VERSION = 1;

/** The files that `build:wasm` writes to `dist/`, by role. */
export const KERNEL_FILES = {
  module: 'docedit_layout_kernel.js',
  wasm: 'docedit_layout_kernel_bg.wasm',
  typings: 'docedit_layout_kernel.d.ts',
  record: 'build.json',
} as const;

/** The WebAssembly file as bytes, or an already compiled module that the caller holds. */
export type KernelWasm = Uint8Array | ArrayBuffer;

/** What the generated ES module of wasm-bindgen exports, in the names of the crate. */
export interface KernelGlue {
  /** Compiles and starts the module from bytes, in this thread. */
  initSync(input: { readonly module: KernelWasm }): unknown;
  kernel_version(): string;
  abi_version(): number;
  checksum(data: Uint8Array): number;
}

/** A started kernel. */
export interface LayoutKernel {
  /** The version of the crate that was built. */
  readonly version: string;
  /** The version of the call interface; equals `KERNEL_ABI_VERSION`. */
  readonly abi: number;
  /** The 32-bit FNV-1a hash of the bytes, computed inside the module. */
  checksum(data: Uint8Array): number;
}

/**
 * What the generated ES module exports as its default: the asynchronous start. `module_or_path` is
 * a `Response` (compiled with `WebAssembly.instantiateStreaming`), bytes (`WebAssembly.instantiate`)
 * or a compiled module. It is typed `unknown` because this package has no DOM types (FND-004).
 */
export interface KernelGlueModule extends Omit<KernelGlue, 'initSync'> {
  default(input: { module_or_path: unknown }): Promise<unknown>;
}

/** The same as `createKernel`, through the module's asynchronous start (WASM-002). */
export async function startKernel(
  glue: KernelGlueModule,
  moduleOrPath: unknown,
): Promise<LayoutKernel> {
  await glue.default({ module_or_path: moduleOrPath });
  return finishKernel(glue);
}

/**
 * Starts the kernel from the generated module and the WebAssembly bytes. Refuses a module whose
 * interface version differs from the one this package expects, so that a stale `dist/` never runs.
 */
export function createKernel(glue: KernelGlue, wasm: KernelWasm): LayoutKernel {
  glue.initSync({ module: wasm });
  return finishKernel(glue);
}

/** Checks the interface version of a started module and wraps its calls. */
export function finishKernel(glue: Omit<KernelGlue, 'initSync'>): LayoutKernel {
  const abi = glue.abi_version();
  if (abi !== KERNEL_ABI_VERSION)
    throw new Error(
      `the layout kernel has interface version ${abi}, this package expects ${KERNEL_ABI_VERSION}`,
    );
  return {
    version: glue.kernel_version(),
    abi,
    checksum: (data) => glue.checksum(data),
  };
}
