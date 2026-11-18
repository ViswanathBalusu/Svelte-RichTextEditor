/// <reference types="vite/client" />

/** PDF.js's worker module, loaded into an opaque viewer frame's own thread (src/pdf/viewer/main.ts). */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown;
}

/**
 * The generated ES module of the layout kernel, which `pnpm --filter @docedit/layout-kernel
 * build:wasm` writes to that package's `dist/` (a build output, not in the repository). Declared
 * here so that the type-check does not need the build. The element never imports it statically
 * (src/layout-kernel-request.ts).
 */
declare module '@docedit/layout-kernel/wasm/docedit_layout_kernel.js' {
  import type { KernelGlueModule } from '@docedit/layout-kernel';
  const init: KernelGlueModule['default'];
  export default init;
  export const abi_version: KernelGlueModule['abi_version'];
  export const kernel_version: KernelGlueModule['kernel_version'];
  export const checksum: KernelGlueModule['checksum'];
}
