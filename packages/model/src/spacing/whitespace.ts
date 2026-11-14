/**
 * Spaces are kept (09 §3.2; S7 question; ADR 0032). No writer collapses a run of spaces: each
 * U+0020 SPACE is one space wide and stretches under justification (02 §9.3), and leading and
 * trailing spaces of a paragraph are kept. Other space characters (no-break, ideographic, the
 * fixed-width spaces) are ordinary characters and never collapse either.
 *
 * TeX collapses runs of spaces and drops spaces at the start and the end of a paragraph, so the
 * LaTeX converter writes every space after the first of a run, and every leading and trailing
 * space, as an explicit space (09 §3.2). `spaceRuns` says which: it works on the whole text of a
 * paragraph, because a run of spaces can cross text nodes with different marks.
 */

export interface SpaceRun {
  /** UTF-16 offset of the first space in the paragraph's text. */
  readonly start: number;
  /** Number of spaces. */
  readonly length: number;
  /** `between` words, or `leading` or `trailing` the paragraph (one run that is all of it is `leading`). */
  readonly position: 'leading' | 'between' | 'trailing';
  /** How many of the spaces a TeX writer must write explicitly: all but one between words, else all. */
  readonly explicit: number;
}

/** The runs of U+0020 in a paragraph's text, in order. */
export function spaceRuns(text: string): SpaceRun[] {
  const runs: SpaceRun[] = [];
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) !== 0x20) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && text.charCodeAt(j) === 0x20) j++;
    const length = j - i;
    const position = i === 0 ? 'leading' : j === text.length ? 'trailing' : 'between';
    runs.push({
      start: i,
      length,
      position,
      explicit: position === 'between' ? length - 1 : length,
    });
    i = j;
  }
  return runs;
}
