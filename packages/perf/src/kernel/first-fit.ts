/**
 * First-fit line breaking (02 §9.3) in TypeScript, over break opportunities from any source. The
 * Rust module (wasm/text-kernel) implements the same rule, so the two prototypes differ only in
 * where the work runs: trailing spaces hang and do not count towards the fit; a piece wider than
 * the line on an empty line overflows; a mandatory break ends the line.
 */
import type { KernelLine } from './types.ts';

export interface Opportunity {
  /** A line may end before this UTF-16 offset. */
  readonly at: number;
  readonly mandatory: boolean;
}

/** `width(from, to)`: the width of `text[from..to)` in points. */
export type WidthOf = (from: number, to: number) => number;

const EPSILON = 1e-3;

export const isBreakSpace = (u: number): boolean => u === 0x20 || u === 0x09 || u === 0x3000;

export function firstFit(
  text: string,
  ops: Iterable<Opportunity>,
  widthPt: number,
  width: WidthOf,
): KernelLine[] {
  const lines: KernelLine[] = [];
  let lineStart = 0;
  let full = 0;
  let content = 0;
  let segStart = 0;
  for (const op of ops) {
    const pieceStart = segStart;
    const pieceEnd = op.at;
    segStart = op.at;
    let coreEnd = pieceEnd;
    while (coreEnd > pieceStart && isBreakSpace(text.charCodeAt(coreEnd - 1))) coreEnd--;
    const core = width(pieceStart, coreEnd);
    const whole = core + width(coreEnd, pieceEnd);
    if (pieceStart > lineStart && full + core > widthPt + EPSILON) {
      lines.push({
        start: lineStart,
        end: pieceStart,
        widthPt: content,
        hyphenated: false,
        mandatory: false,
      });
      lineStart = pieceStart;
      full = 0;
    }
    content = full + core;
    full += whole;
    if (op.mandatory) {
      lines.push({
        start: lineStart,
        end: op.at,
        widthPt: content,
        hyphenated: false,
        mandatory: true,
      });
      lineStart = op.at;
      full = 0;
      content = 0;
    }
  }
  return lines;
}
