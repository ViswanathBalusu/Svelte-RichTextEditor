/**
 * Measured page counts (FND-006). Until the S4 LaTeX compile (SPK-017) reports real page counts,
 * every page count in the manifest is an estimate (analyse.ts, PAGE_ESTIMATE). When S4 measures a
 * document, add it here with how and where it was measured; the manifest then marks that count as
 * measured. Like any change to the output, this needs a new corpus version (version.ts). The
 * documents themselves do not change, so their canonical hashes stay the same.
 */

export interface MeasuredPages {
  pages: number;
  /** How and where the count was taken: compiler, class version, job or commit. */
  how: string;
}

export const MEASURED_PAGES: Readonly<Record<string, MeasuredPages>> = {};
