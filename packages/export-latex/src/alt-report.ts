/**
 * The report of pictures without alternative text (09 §13; EXP-113). The export job reports each
 * `image` and `figure` node without `alt`, with its block identifier, and the count. The report is
 * read from the job's own diagnostics, which come from the preflight (EXP-003), so the job and the
 * preflight cannot disagree about which pictures lack alternative text.
 *
 * Universal and pure: a bundle's diagnostics in, a list out. The accessibility checker of the
 * editor reads the same list through this module (UX's checker; not built here).
 */
import type { Bundle, Diagnostic } from './bundle.ts';

/** The code the preflight gives a picture without alternative text (preflight.ts). */
export const IMAGE_WITHOUT_ALT = 'image_without_alt';

export interface AltTextReport {
  /** The number of pictures without alternative text (one per occurrence). */
  readonly count: number;
  /**
   * The block of each occurrence, in document order: the figure, or the paragraph of an inline
   * picture. A block with two such pictures appears twice. Null when the preflight had no block.
   */
  readonly blockIds: ReadonlyArray<string | null>;
  /** The diagnostics the report was read from, so a caller can show their messages. */
  readonly diagnostics: readonly Diagnostic[];
}

/** Reads the pictures without alternative text from a list of diagnostics, in their order. */
export function altTextReport(diagnostics: readonly Diagnostic[]): AltTextReport {
  const found = diagnostics.filter((d) => d.code === IMAGE_WITHOUT_ALT);
  return { count: found.length, blockIds: found.map((d) => d.blockId), diagnostics: found };
}

/** The report of an export job's result (the bundle the converter returns). */
export function bundleAltTextReport(bundle: Pick<Bundle, 'diagnostics'>): AltTextReport {
  return altTextReport(bundle.diagnostics);
}
