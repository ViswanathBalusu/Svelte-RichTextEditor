/**
 * The text-kernel boundary of spike S10 (SPK-023). A kernel is the S7 measurement interface
 * (`TextMeasurer` of `@docedit/layout`: `advance`, `advances`, `lineMetrics`), so it can serve the
 * layout core as it is, plus one call per paragraph: runs and a width in, lines out. That second
 * call is where a WebAssembly kernel pays its boundary cost once per paragraph instead of once per
 * segment (S7 report §6).
 */
import type { FontKey, TextMeasurer } from '@docedit/layout';

/** A run of the paragraph's text in one font: `[start, end)` in UTF-16 units. */
export interface KernelRun {
  readonly start: number;
  readonly end: number;
  /** `family` is a manifest alias (src/fonts.ts). */
  readonly font: FontKey;
}

export interface KernelParagraph {
  readonly text: string;
  readonly runs: readonly KernelRun[];
  /** Line width in points. */
  readonly widthPt: number;
  /** TeX-pattern hyphenation (02 §9.3: off by default). Only the Rust kernel has it. */
  readonly hyphenate?: boolean;
}

export interface KernelLine {
  readonly start: number;
  readonly end: number;
  /** Width without trailing spaces, in points. */
  readonly widthPt: number;
  readonly hyphenated: boolean;
  /** The line ends at a mandatory break (end of paragraph or a line break). */
  readonly mandatory: boolean;
}

export interface KernelStats {
  /** Pieces of text shaped (cache misses). */
  readonly shaped: number;
  readonly cacheHits: number;
  readonly cacheEntries: number;
}

export interface TextKernel extends TextMeasurer {
  readonly name: string;
  /** Registers a face from the manifest (`file`) with its bytes. */
  loadFace(file: string, bytes: Uint8Array): void;
  breakParagraph(p: KernelParagraph): KernelLine[];
  clearCache(): void;
  stats(): KernelStats;
  /** Bytes of the kernel's WebAssembly linear memory. */
  memoryBytes(): number;
}

/** A stable text form of a paragraph's lines, for digests across environments. */
export function linesKey(lines: readonly KernelLine[]): string {
  return lines
    .map(
      (l) =>
        `${l.start}-${l.end}:${l.widthPt.toFixed(3)}${l.hyphenated ? 'h' : ''}${l.mandatory ? 'm' : ''}`,
    )
    .join(' ');
}
