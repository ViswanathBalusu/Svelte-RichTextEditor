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
  export const sha256_hex: KernelGlueModule['sha256_hex'];
  export const face_load: KernelGlueModule['face_load'];
  export const face_release: KernelGlueModule['face_release'];
  export const face_release_owner: KernelGlueModule['face_release_owner'];
  export const face_release_all: KernelGlueModule['face_release_all'];
  export const face_has: KernelGlueModule['face_has'];
  export const face_owner: KernelGlueModule['face_owner'];
  export const faces_count: KernelGlueModule['faces_count'];
  export const faces_bytes_held: KernelGlueModule['faces_bytes_held'];
  export const font_epoch: KernelGlueModule['font_epoch'];
  export const advance_units_per_point: KernelGlueModule['advance_units_per_point'];
  export const shape_advances: KernelGlueModule['shape_advances'];
  export const shape_width: KernelGlueModule['shape_width'];
  export const face_line_metrics: KernelGlueModule['face_line_metrics'];
  export const shape_cache_stats: KernelGlueModule['shape_cache_stats'];
  export const shape_cache_clear: KernelGlueModule['shape_cache_clear'];
  export const break_paragraph: KernelGlueModule['break_paragraph'];
}
