/**
 * Compares the text of a multi-page PDF with the text runs of its input (EXP-025 criterion 3).
 *
 * A single-page comparison can look for each run whole. On several pages a run that crosses a page
 * break has the footer of one page and the header of the next in the middle of it, and a float can
 * come between its two parts (a figure's caption is set at the top of the next page, but is
 * defined after the paragraph that precedes it). So:
 *
 * - Both sides have their white space and their hyphens removed first: `pdftotext` returns neither
 *   the spaces of the input nor a hyphen TeX added or kept at a line end (the single-page test
 *   checks hyphens).
 * - The lines of the contents, figure and table lists (dot leaders) are taken out first. They
 *   repeat the text of the headings and captions; `contentsMissing` names those the lists do not
 *   have.
 * - A run is placed in pieces: the longest prefix of what is left that occurs in the PDF text
 *   after the cursor, then the longest prefix of the rest, and so on. Each next piece starts
 *   within `GAP` characters of the one before: what comes between the parts is page furniture, a
 *   note or a float. A run that is not whole after the cursor is looked for whole before it, the
 *   nearest occurrence first (`unordered`: a float set above where it was defined).
 * - After the runs of the body and of the footnotes, the headers and footers and the running head
 *   (which repeats a heading) are taken out wherever they occur. What is left must hold no letter,
 *   apart from the words the class generates (`generated`). Numbers, bullets and page numbers are
 *   not letters.
 */

export interface PagedRuns {
  /** Text runs of the body, in document order, without footnote text. */
  body: string[];
  /** Text runs of footnotes. */
  notes: string[];
  /** Text runs of headers and footers; they occur on every page. */
  furniture: string[];
  /** The text of each heading and caption paragraph; the lists and the running head repeat it. */
  headings: string[];
  /**
   * The indexes of the runs of ody that belong to a float (a figure, a caption). A float is set
   * where there is room, near where it is defined and not necessarily after the run before it.
   */
  floatAt?: ReadonlySet<number>;
  /** The header rows of tables, which are set again at the top of each page the table runs on. */
  repeated?: string[];
  /** Words the class generates, such as the label of a caption (`Figure`). */
  generated?: string[];
}

export interface PagedResult {
  /** Runs, or the parts of runs, that are not in the PDF text. */
  missing: string[];
  /** Runs that are in the PDF text only before the run that precedes them in the input. */
  unordered: string[];
  /** Headings and captions that the lists of contents, figures and tables do not repeat. */
  contentsMissing: string[];
  /** The letters of the PDF text that no run and no generated text accounts for. */
  letters: string[];
  /** The PDF text that no run accounts for. */
  rest: string;
}

/** The most PDF text that can come between two parts of a run (page furniture, notes, a float). */
export const GAP = 4000;

/** How far from the end of the run before it a run starts: a footer, a header and some notes. */
const NEAR = 1500;

/** The shortest piece of a run that is placed on its own, unless it is the end of the run. */
const MIN_PIECE = 12;

const squash = (s: string): string => s.replace(/[\s\u00ad-]+/gu, '');

/** A letter of the Mathematical Alphanumeric Symbols block, as the equation's font prints it. */
const MATH_LETTER = /[\u{1D400}-\u{1D7FF}]/u;

/** A line of the contents, figure or table list: text, dot leaders, a page number. */
const LIST_LINE = /(\. ){4,}/u;

function free(used: Uint8Array, at: number, length: number): boolean {
  for (let i = at; i < at + length; i++) if (used[i]) return false;
  return true;
}

/** The first free position from `from` to `to` where `needle` occurs. */
function findFree(
  pdf: string,
  used: Uint8Array,
  needle: string,
  from: number,
  to = pdf.length,
): number {
  for (let at = pdf.indexOf(needle, from); at >= 0 && at <= to; at = pdf.indexOf(needle, at + 1)) {
    if (free(used, at, needle.length)) return at;
  }
  return -1;
}

/** The last free position at or before `from` where `needle` occurs. */
function findFreeBefore(pdf: string, used: Uint8Array, needle: string, from: number): number {
  for (let at = pdf.lastIndexOf(needle, from); at >= 0; at = pdf.lastIndexOf(needle, at - 1)) {
    if (free(used, at, needle.length)) return at;
    if (at === 0) break;
  }
  return -1;
}

interface Placed {
  /** Where its first piece starts. */
  start: number;
  /** Where its last piece ends. */
  end: number;
  /** The part that could not be placed; empty when the run is whole. */
  lost: string;
  /** The pieces, as start and end. */
  pieces: Array<[number, number]>;
}

/**
 * Places a run in pieces after `from`; marks the pieces used. The first piece starts within `reach`
 * characters of `from`, each next one within `GAP` of the end of the one before. Null when not even
 * the first character fits.
 */
export function place(
  pdf: string,
  used: Uint8Array,
  run: string,
  from: number,
  reach = pdf.length,
  minPiece = MIN_PIECE,
): Placed | null {
  let pos = from;
  let rest = run;
  let limit = from + reach;
  const pieces: Array<[number, number]> = [];
  while (rest !== '') {
    // The longest prefix of `rest` that occurs: an occurrence of a prefix implies one of every
    // shorter prefix, so the length can be found by bisection.
    let lo = 0;
    let hi = rest.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (findFree(pdf, used, rest.slice(0, mid), pos, limit) >= 0) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) break;
    const hit = findFree(pdf, used, rest.slice(0, lo), pos, limit);
    // A short piece is a coincidence (a letter that occurs anywhere), not a part of the run, unless it
    // starts where the run before ended: the end of a page can come after a word or two.
    if (lo < minPiece && lo < rest.length && !(pieces.length === 0 && hit === from)) break;
    used.fill(1, hit, hit + lo);
    pieces.push([hit, hit + lo]);
    pos = hit + lo;
    limit = pos + GAP;
    rest = rest.slice(lo);
  }
  const first = pieces[0];
  if (!first) return null;
  return { start: first[0], end: pos, lost: rest, pieces };
}

function unplace(used: Uint8Array, p: Placed): void {
  for (const [a, b] of p.pieces) used.fill(0, a, b);
}

export function comparePaged(
  pdfText: string,
  input: PagedRuns,
  trace?: (what: string, run: string, at: number, cursor: number) => void,
): PagedResult {
  const lines = pdfText.split(/\r?\n|\f/u);
  // A long entry of a list wraps: its first line has no leader, and the line with the leader follows.
  const listText = squash(
    lines.filter((l, i) => LIST_LINE.test(l) || LIST_LINE.test(lines[i + 1] ?? '')).join(''),
  );
  const pdf = squash(lines.filter((l) => !LIST_LINE.test(l)).join(''));
  const used = new Uint8Array(pdf.length);
  const missing: string[] = [];
  const unordered: string[] = [];
  let cursor = 0;
  for (const [index, raw] of input.body.entries()) {
    const run = squash(raw);
    if (run === '') continue;
    if (input.floatAt?.has(index)) {
      // Nearest first: before the cursor (set above its place) or just after it.
      const near = findFreeBefore(pdf, used, run, cursor);
      const after = findFree(pdf, used, run, cursor, cursor + NEAR);
      const at = near >= 0 && (after < 0 || cursor - near <= after - cursor) ? near : after;
      if (at >= 0) {
        used.fill(1, at, at + run.length);
        unordered.push(run);
        continue;
      }
    }
    // A run starts where the one before it ended, after at most the furniture of a page break. If a
    // phrase of its start occurs again further on, the longest match must not jump to it.
    // First near where the run before ended, then within a few pages.
    let p: ReturnType<typeof place> = null;
    for (const reach of [NEAR, 3 * GAP]) {
      if (p && p.lost === '') break;
      if (p) unplace(used, p);
      p = place(pdf, used, run, cursor, reach);
    }
    // Far from the cursor, only a long run is certain to be the right one: a short run, one word, is
    // found anywhere.
    if (p && p.lost === '' && (p.start - cursor <= NEAR || run.length >= 40)) {
      trace?.('whole', run, p.start, cursor);
      cursor = p.end;
      continue;
    }
    if (p) unplace(used, p);
    trace?.('not whole', run, p ? p.start : -1, cursor);
    const before = findFreeBefore(pdf, used, run, cursor);
    if (before >= 0) {
      used.fill(1, before, before + run.length);
      trace?.('before', run, before, cursor);
      unordered.push(run);
      continue;
    }
    const anywhere = place(pdf, used, run, 0);
    if (anywhere && anywhere.lost === '') {
      unordered.push(run);
      continue;
    }
    if (anywhere) unplace(used, anywhere);
    // Report what is not there: as much of the run as can be placed after the cursor is placed.
    const part = place(pdf, used, run, cursor, 3 * GAP);
    if (part) {
      missing.push(part.lost);
      cursor = part.end;
    } else missing.push(run);
  }
  for (const raw of [...input.notes].sort((a, b) => b.length - a.length)) {
    const run = squash(raw);
    if (run === '') continue;
    // A footnote can continue on the next page after a word or two: its pieces may be short.
    const p = place(pdf, used, run, 0);
    if (!p) missing.push(run);
    else if (p.lost !== '') missing.push(p.lost);
  }
  const repeats = [
    ...input.furniture,
    ...input.headings,
    ...(input.repeated ?? []),
    ...(input.generated ?? []),
  ]
    .map(squash)
    .filter((s) => s !== '')
    .sort((a, b) => b.length - a.length);
  for (const run of repeats)
    for (let at = findFree(pdf, used, run, 0); at >= 0; at = findFree(pdf, used, run, at + 1))
      used.fill(1, at, at + run.length);
  let rest = '';
  for (let i = 0; i < pdf.length; i++) if (!used[i]) rest += pdf[i];
  // A repeated text can have a character in it (a full stop, a digit) that a run of the body took,
  // so what is left of it is taken out again as letters alone.
  let letterText = Array.from(rest)
    .filter((ch) => /\p{L}/u.test(ch) && !MATH_LETTER.test(ch))
    .join('');
  for (const run of repeats) {
    const only = Array.from(run)
      .filter((ch) => /\p{L}/u.test(ch))
      .join('');
    if (only !== '') letterText = letterText.split(only).join('');
  }
  const letters = Array.from(letterText);
  const contentsMissing = input.headings
    .map(squash)
    .filter((h) => h !== '' && !listText.includes(h));
  return { missing, unordered, contentsMissing, letters, rest };
}
