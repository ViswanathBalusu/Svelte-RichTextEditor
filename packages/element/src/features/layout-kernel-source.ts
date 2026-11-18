/**
 * The build's own files of the layout kernel (WASM-002): the generated ES module and the URL of the
 * WebAssembly file, which the bundler writes as an asset next to the chunks and never inlines.
 * Kept apart from the loader so that a test can load the loader without a built kernel.
 */
import type { KernelGlueModule } from '@docedit/layout-kernel';
import wasmUrl from '@docedit/layout-kernel/wasm/docedit_layout_kernel_bg.wasm?url&no-inline';
import type { KernelSource } from './layout-kernel.ts';

export const BUILD_SOURCE: KernelSource = {
  glue: () =>
    import('@docedit/layout-kernel/wasm/docedit_layout_kernel.js') as Promise<KernelGlueModule>,
  url: () => wasmUrl,
};
