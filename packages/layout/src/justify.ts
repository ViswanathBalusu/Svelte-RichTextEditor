/**
 * Justification by computed word spacing (02 §9.3; FE-091). A justified line gets its extra space
 * as one word spacing value, added after each stretchable space, so that the line reaches the
 * column's edge. This module computes that value from the line's text and its natural and target
 * widths. The painter applies it (FE-090, not yet built); the painted width criteria stay with it.
 *
 * Rules implemented here:
 * - the stretchable spaces are the ordinary space (U+0020) and the no-break space (U+00A0);
 * - tabs never stretch;
 * - the trailing run of spaces, no-break spaces and tabs at the end of the line never stretches,
 *   because a space at the end of a line does not show at the margin (a default: the story does not
 *   say how a trailing no-break space is treated, see docs/adr/0120-layout-backlog-batch.md);
 * - a line that is already at or over its target width is not shrunk: its word spacing is zero;
 * - a line with no stretchable space is not justified: its word spacing is zero.
 *
 * Offsets are UTF-16 code units inside the line text. Widths and spacing are in points. Universal:
 * no DOM and no Node.js API (FND-004).
 */

/** The result of justifying one line. */
export interface JustifiedLine {
  /** Extra space added after each stretchable space, in points. Zero when the line is not stretched. */
  readonly wordSpacing: number;
  /** UTF-16 offsets in the line text of the spaces that stretch, in ascending order. */
  readonly spaces: readonly number[];
}

const ORDINARY_SPACE = 0x20;
const NO_BREAK_SPACE = 0xa0;
const TAB = 0x09;

/** Whether a character is one of the three that a line's trailing run may hold. */
function isTrailingBlank(code: number): boolean {
  return code === ORDINARY_SPACE || code === NO_BREAK_SPACE || code === TAB;
}

/**
 * The UTF-16 offsets of the spaces of `text` that justification may stretch: ordinary and no-break
 * spaces, not part of the trailing run of blanks at the end of the line.
 */
export function stretchableSpaces(text: string): number[] {
  let end = text.length;
  while (end > 0 && isTrailingBlank(text.charCodeAt(end - 1))) end--;
  const out: number[] = [];
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code === ORDINARY_SPACE || code === NO_BREAK_SPACE) out.push(i);
  }
  return out;
}

/**
 * Computes the word spacing that brings a line of `text` from `naturalWidth` to `targetWidth`. The
 * extra space is shared equally by the stretchable spaces. Pure: the same input gives the same
 * result. Non-finite widths are not justified.
 */
export function justifyLine(
  text: string,
  naturalWidth: number,
  targetWidth: number,
): JustifiedLine {
  const spaces = stretchableSpaces(text);
  const extra = targetWidth - naturalWidth;
  if (spaces.length === 0 || !(extra > 0) || !Number.isFinite(extra)) {
    return Object.freeze({ wordSpacing: 0, spaces: Object.freeze(spaces) });
  }
  return Object.freeze({
    wordSpacing: extra / spaces.length,
    spaces: Object.freeze(spaces),
  });
}
