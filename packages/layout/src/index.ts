/**
 * `@docedit/layout`: the page layout engine of 02 §9. Phase 0 holds spike S7 (SPK-020): the
 * engine-neutral flow blocks (FE-077), the injected measurement interface (FE-079), the project's
 * layout tree (FE-078), and adapters that drive two candidate layout cores from the same flow
 * blocks: Docen's (`docen.ts`) and Eigenpal's (`eigenpal.ts`). The spike report is
 * docs/spikes/2026-11-06-s7-layout-core.md.
 *
 * Eigenpal's adapter and its WordprocessingML projection (`eigenpal.ts`, `ooxml.ts`) are not
 * exported: the spike rejected Eigenpal as a base, and any further use waits for counsel on its
 * repository's provenance (report §7). Only the spike's tests import them, and Eigenpal is a dev
 * dependency. Remove both files and the dependency when FE-076 starts the fork.
 *
 * Universal: no DOM and no Node.js API (FND-004). Measurement is injected.
 */
export * from './measure.ts';
export * from './math-measure.ts';
export * from './flow.ts';
export * from './tree.ts';
export * from './tree-share.ts';
export * from './paginate.ts';
export * from './paginate-driver.ts';
export { placeNotes } from './notes.ts';
export * from './items.ts';
export * from './engine.ts';
export * from './justify.ts';
export * from './incremental.ts';
export * from './caret.ts';
export * from './page-keys.ts';
export * from './page-heights.ts';
export * from './layout-json.ts';
export * from './reconcile.ts';
export * from './readonly-view.ts';
export * from './font-epoch.ts';
export * from './font-arrivals.ts';
export * from './font-pass.ts';
export * from './font-dirty.ts';
export * from './font-incremental.ts';
export {
  layoutWithDocen,
  parseDocenFont,
  DOCEN_ENGINE,
  type Canvas2D,
  type DocenLayoutOptions,
} from './docen.ts';
