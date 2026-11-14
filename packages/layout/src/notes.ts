/**
 * Footnotes on their pages (02 §9.4; 03 §4.4; FE-084). The footnotes that a page's references name
 * are set in an area at the foot of the page, above the footer. The area takes its height from the
 * body: while `paginate` fills a page, it asks `noteAreaAccepts` before each body line whether the
 * area those lines would need still fits below them, and moves the line on when it does not. When
 * the pass ends, `placeNotes` sets the areas in the space below each page's body.
 *
 * Rules implemented here:
 * - a footnote goes on the page of its first reference, in reference order, after the footnote
 *   text carried over from earlier pages (a footnote is placed once);
 * - a footnote starts on the page of its reference and is kept whole there. Only a footnote taller
 *   than the area may ever be, its page's body height less the first body line, is split: it is
 *   then the last footnote of the page, and its first line is on the page of its reference;
 * - carried footnote text comes first, and takes as much of the next page as it would take on its
 *   own (up to the body height less the first body line); a new footnote starts only after it;
 * - text that does not fit continues on the next page, its lines in order; the first line of an
 *   empty area is always taken, so the carried text always ends (termination);
 * - a footnote left over after the last page gets a page of its own, numbered on from it. That page
 *   has no body and no header or footer (a limit: its stories would need their factories).
 *
 * Not decided here, and recorded in docs/adr/0120-layout-backlog-batch.md (proposed): the separator
 * above the area (none is drawn), the spacing between the footnotes, and how the numbering restarts
 * (`footnoteRestart` is read by the shared numbering algorithm, which `flow.ts` uses for the marks,
 * FE-084 criterion 4). The numbers are the labels that `flow.ts` gives each footnote.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import { formatNumber } from './flow.ts';
import type { NoteItem, NoteRef, PageFrame, PaginatedPage, ParagraphItem } from './page-items.ts';
import type { LayoutLine, ParagraphFragment } from './tree.ts';

const EPS = 1e-6;

/** A paragraph of a footnote, or the part of it still to place, from line `from`. */
export interface NotePiece {
  /** The footnote the paragraph belongs to. */
  readonly note: string;
  readonly para: ParagraphItem;
  readonly from: number;
}

/** The lines of one piece placed in an area. */
interface Taken {
  readonly para: ParagraphItem;
  readonly from: number;
  readonly to: number;
  /** The space before the paragraph, when this piece starts it. */
  readonly spaceBefore: number;
  /** The height of the lines taken. */
  readonly lineHeight: number;
  /** The space after the paragraph, when this piece ends it. */
  readonly spaceAfter: number;
}

interface Filled {
  readonly taken: Taken[];
  /** What does not fit on this page, in order. */
  readonly rest: NotePiece[];
  /** The height of the area. */
  readonly height: number;
}

/**
 * Takes the pieces, in order, into an area of at most `cap` points (the first line always fits).
 * The lines taken are always a prefix of the queue's lines, and a larger `cap` never takes fewer.
 */
function fill(queue: readonly NotePiece[], cap: number): Filled {
  const taken: Taken[] = [];
  const rest: NotePiece[] = [];
  let used = 0;
  let i = 0;
  while (i < queue.length) {
    const piece = queue[i]!;
    const lines = piece.para.fragment.lines;
    const spaceBefore = piece.from === 0 ? piece.para.spaceBefore : 0;
    let n = piece.from;
    let h = 0;
    while (n < lines.length && used + spaceBefore + h + lines[n]!.height <= cap + EPS) {
      h += lines[n]!.height;
      n++;
    }
    // An empty area takes one line, so that the footnotes always move on.
    if (n === piece.from && n < lines.length && used === 0 && taken.length === 0) {
      h = lines[n]!.height;
      n++;
    }
    if (n === piece.from && n < lines.length) break;
    const complete = n === lines.length;
    const spaceAfter = complete ? piece.para.spaceAfter : 0;
    taken.push({
      para: piece.para,
      from: piece.from,
      to: n,
      spaceBefore,
      lineHeight: h,
      spaceAfter,
    });
    used += spaceBefore + h + spaceAfter;
    i++;
    if (!complete) {
      rest.push({ note: piece.note, para: piece.para, from: n });
      break;
    }
  }
  for (; i < queue.length; i++) rest.push(queue[i]!);
  return { taken, rest, height: used };
}

const linesLeft = (pieces: readonly NotePiece[]): number =>
  pieces.reduce((sum, p) => sum + (p.para.fragment.lines.length - p.from), 0);

const linesTaken = (f: Filled): number => f.taken.reduce((sum, t) => sum + (t.to - t.from), 0);

/**
 * The pieces of the footnotes that the references in CDM offsets [from, to) of block `blockId` name
 * for the first time, in offset order. `placed` holds the footnotes already placed; it is not
 * changed. The caller adds the returned footnotes to it when the lines are placed.
 */
export function freshNotePieces(
  blockId: string,
  from: number,
  to: number,
  refs: ReadonlyMap<string, readonly NoteRef[]>,
  notes: ReadonlyMap<string, NoteItem>,
  placed: ReadonlySet<string>,
): NotePiece[] {
  const here = (refs.get(blockId) ?? [])
    .filter((r) => r.offset >= from && r.offset < to)
    .sort((a, b) => a.offset - b.offset);
  const out: NotePiece[] = [];
  const seen = new Set<string>();
  for (const r of here) {
    const note = notes.get(r.id);
    if (!note || placed.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    for (const para of note.paragraphs) out.push({ note: r.id, para, from: 0 });
  }
  return out;
}

/**
 * Whether a page whose body ends `full - cap` points below its top can hold its footnote area
 * (FE-084): `carry` is the text carried over from earlier pages, `fresh` the footnotes that the
 * page's references name, in order, and `areaMax` the most an area of the page may take (its body
 * height less the first body line). The area is what `fill` takes with `cap`; it is accepted when
 * - it fits in `cap` (no line is forced in);
 * - it takes as much of the carried text as an area of `areaMax` would;
 * - every fresh footnote is whole, except the last when it alone is taller than `areaMax`: that
 *   one needs only its first line.
 * A smaller body (a larger `cap`) is accepted whenever a larger one is, so the caller can stop at
 * the first body line that is refused.
 */
export function noteAreaAccepts(
  carry: readonly NotePiece[],
  fresh: readonly NotePiece[],
  cap: number,
  areaMax: number,
): boolean {
  if (carry.length === 0 && fresh.length === 0) return true;
  if (cap < -EPS) return false;
  const filled = fill([...carry, ...fresh], Math.max(0, cap));
  if (filled.height > cap + EPS) return false;
  const taken = linesTaken(filled);
  const carryTotal = linesLeft(carry);
  const carryWant = carry.length > 0 ? linesTaken(fill(carry, Math.max(0, areaMax))) : 0;
  if (Math.min(taken, carryTotal) < carryWant) return false;
  if (fresh.length === 0) return true;

  // Fresh footnotes, grouped by footnote, in order.
  const groups: NotePiece[][] = [];
  for (const p of fresh) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.note === p.note) last.push(p);
    else groups.push([p]);
  }
  let need = carryTotal;
  groups.forEach((g, i) => {
    const tall =
      i === groups.length - 1 && fill(g, Number.POSITIVE_INFINITY).height > areaMax + EPS;
    need += tall ? 1 : linesLeft(g);
  });
  return taken >= need;
}

/** The height of the area that `queue` takes with at most `cap` points, and what is left over. */
export function fillNoteArea(
  queue: readonly NotePiece[],
  cap: number,
): { readonly height: number; readonly rest: NotePiece[] } {
  const filled = fill(queue, cap);
  return { height: filled.height, rest: filled.rest };
}

/** The lines of a taken piece as a paragraph fragment at `y`, at the page's left margin. */
function fragmentOf(t: Taken, x: number, y: number): ParagraphFragment | null {
  const lines = t.para.fragment.lines.slice(t.from, t.to);
  if (lines.length === 0) return null;
  const base = lines[0]!.y;
  const local: LayoutLine[] = lines.map((l) => ({ ...l, y: l.y - base }));
  return {
    kind: 'paragraph',
    blockId: t.para.fragment.blockId,
    from: lines[0]!.from,
    to: lines[lines.length - 1]!.to,
    x,
    y,
    width: t.para.fragment.width,
    height: t.lineHeight,
    lines: local,
  };
}

/** The footnote area of a page, positioned above its footer. */
function areaFragments(
  taken: readonly Taken[],
  height: number,
  page: { readonly height: number; readonly margins: { readonly left: number } },
  frame: PageFrame,
): ParagraphFragment[] {
  const out: ParagraphFragment[] = [];
  let y = page.height - frame.bottomFree - height;
  for (const t of taken) {
    y += t.spaceBefore;
    const f = fragmentOf(t, page.margins.left, y);
    if (f) out.push(f);
    y += t.lineHeight + t.spaceAfter;
  }
  return out;
}

/**
 * Places the footnotes of the pages of a pass. `refs` gives each block's references by block
 * identifier; `notes` gives the footnotes. Each page's area takes at most `frame.area` points.
 * Returns the pages with their `footnotes` set, the extra pages that carried footnotes need, and
 * the height of the area of each body page.
 */
export function placeNotes(
  pages: readonly PaginatedPage[],
  frames: readonly PageFrame[],
  refs: ReadonlyMap<string, readonly NoteRef[]>,
  notes: ReadonlyMap<string, NoteItem>,
): { pages: PaginatedPage[]; areas: number[] } {
  const placedNotes = new Set<string>();
  const newPieces = (page: PaginatedPage): NotePiece[] => {
    const out: NotePiece[] = [];
    for (const f of page.fragments) {
      if (f.kind !== 'paragraph') continue;
      const fresh = freshNotePieces(f.blockId, f.from, f.to, refs, notes, placedNotes);
      for (const p of fresh) placedNotes.add(p.note);
      out.push(...fresh);
    }
    return out;
  };

  const out: PaginatedPage[] = [];
  const areas: number[] = [];
  let carry: NotePiece[] = [];
  pages.forEach((page, i) => {
    const frame = frames[i]!;
    const filled = fill([...carry, ...newPieces(page)], frame.area);
    carry = filled.rest;
    areas.push(filled.height);
    out.push({
      ...page,
      footnotes: areaFragments(filled.taken, filled.height, page, frame),
    });
  });

  // A footnote left over after the last page gets a page of its own (a limit: see the header).
  const last = pages[pages.length - 1];
  const lastFrame = frames[frames.length - 1];
  if (last && lastFrame) {
    let prev: PaginatedPage = last;
    while (carry.length > 0) {
      const number = prev.number + 1;
      const page: PaginatedPage = {
        index: out.length,
        section: prev.section,
        width: prev.width,
        height: prev.height,
        number,
        label: formatNumber(number, lastFrame.format),
        orientation: prev.orientation,
        margins: prev.margins,
        fragments: [],
        header: [],
        footer: [],
        footnotes: [],
      };
      const filled = fill(carry, lastFrame.full);
      carry = filled.rest;
      out.push({ ...page, footnotes: areaFragments(filled.taken, filled.height, page, lastFrame) });
      prev = page;
    }
  }
  return { pages: out, areas };
}
