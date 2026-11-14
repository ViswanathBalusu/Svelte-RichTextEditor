/**
 * `@docedit/perf`: the client performance harness on the reference machine (FND-007; ADR 0037)
 * and the code of spikes S5 (SPK-018, text measurement) and S10 (SPK-023, text kernel).
 *
 * The measurement code here runs in Node.js, in pages and in workers (lib ES2023, no ambient
 * types). The browser pages are src/browser/, the Playwright specs e2e/, the scripts scripts/.
 */
export * from './stats.ts';
export * from './results.ts';
export * from './baseline.ts';
export * from './reference.ts';
export * from './fonts.ts';
export * from './lines.ts';
export * from './s5.ts';
export { type ShapedGlyph, type Shaper, NO_KERN, NO_LIGA, glyphKey } from './shapers/types.ts';
export { loadHarfbuzz, harfbuzzShaper, type LoadedHarfbuzz } from './shapers/harfbuzz.ts';
export {
  loadTextKernel,
  harfrustShaper,
  TextKernelModule,
  type LoadedModule,
} from './shapers/harfrust.ts';
export * from './kernel/types.ts';
export { firstFit, isBreakSpace, type Opportunity, type WidthOf } from './kernel/first-fit.ts';
export { faceMetrics, type FaceMetrics } from './kernel/metrics.ts';
export { kernelParagraphs } from './kernel/paragraphs.ts';
export { tsKernel } from './kernel/ts-kernel.ts';
export { rustKernel } from './kernel/rust-kernel.ts';
export { now, timeCompile, webAssembly, stubImports } from './wasm.ts';
