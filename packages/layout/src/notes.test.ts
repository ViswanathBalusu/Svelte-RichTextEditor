/**
 * Footnotes on their pages (FE-084), in Node.js. Paragraphs are built from their line heights, as in
 * `paginate-regions.test.ts`: line `i` of a block covers CDM offsets [i, i + 1), so a reference at
 * offset `k` sits on line `k`. The CDM test runs a footnote from the CDM through the flow and the
 * item adapter. The random sweep uses a seeded generator (mulberry32), so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { documentItems, firstFitBreaker, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import {
  paginate,
  type NoteItem,
  type NoteRef,
  type PageItem,
  type PageMargins,
  type PageSetup,
  type StoryFactory,
  type ParagraphItem,
} from './paginate.ts';
import type { LayoutFragment, ParagraphFragment } from './tree.ts';

const EPS = 1e-6;

/**
 * mulberry32, a seeded 32-bit generator: `random(n)` is a whole number in [0, n). The state stays
 * in 32 bits through `Math.imul`, so no low bits are lost to floating point.
 */
function mulberry32(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

const NO_MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

const body = (height: number, over: Partial<PageSetup> = {}): PageSetup => ({
  width: 80,
  height,
  margins: NO_MARGINS,
  ...over,
});

/** A paragraph of lines with the given heights; line `i` covers CDM offsets [i, i + 1). */
function para(
  id: string,
  heights: readonly number[],
  refs: readonly NoteRef[] = [],
): ParagraphItem {
  let y = 0;
  const lines = heights.map((h, i) => {
    const line = { from: i, to: i + 1, x: 0, y, width: 10, height: h };
    y += h;
    return line;
  });
  return {
    kind: 'paragraph',
    fragment: {
      kind: 'paragraph',
      blockId: id,
      from: 0,
      to: heights.length,
      x: 0,
      y: 0,
      width: 80,
      height: y,
      lines,
    },
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
    ...(refs.length > 0 ? { notes: refs } : {}),
  };
}

/** A footnote of one paragraph with the given line heights. */
function note(id: string, heights: readonly number[]): NoteItem {
  return { id, paragraphs: [para(`${id}-p`, heights)] };
}

const notesOf = (...ns: NoteItem[]): ReadonlyMap<string, NoteItem> =>
  new Map(ns.map((n) => [n.id, n] as const));

const fragmentsOn = (fragments: readonly LayoutFragment[], id: string): ParagraphFragment[] =>
  fragments.filter((f): f is ParagraphFragment => f.kind === 'paragraph' && f.blockId === id);

const lineCount = (fragments: readonly ParagraphFragment[]): number =>
  fragments.reduce((n, f) => n + f.lines.length, 0);

describe('footnotes (FE-084)', () => {
  it('sets a footnote at the foot of the page of its reference and raises the body above it (criterion 1)', () => {
    const items = [
      para(
        'a',
        Array.from({ length: 12 }, () => 10),
        [{ offset: 2, id: 'n1' }],
      ),
    ];
    const plain = paginate(items, body(100));
    expect(
      plain.pages[0]!.fragments.flatMap((f) => (f.kind === 'paragraph' ? f.lines : [])).length,
    ).toBe(10);

    const { pages, pageCountSettled } = paginate(items, body(100), {
      notes: notesOf(note('n1', [10, 10])),
    });
    expect(pageCountSettled).toBe(true);
    expect(pages.length).toBe(2);
    // Two lines of footnote take 20 points, so the body keeps 80 points: eight lines on page 1.
    const footnote = fragmentsOn(pages[0]!.footnotes, 'n1-p');
    expect(lineCount(footnote)).toBe(2);
    expect(footnote[0]!.y).toBeCloseTo(80, 6);
    const bodyOnFirst = fragmentsOn(pages[0]!.fragments, 'a');
    expect(lineCount(bodyOnFirst)).toBe(8);
    const bodyBottom = Math.max(...bodyOnFirst.map((f) => f.y + f.height));
    expect(bodyBottom).toBeLessThanOrEqual(footnote[0]!.y + EPS);
    expect(pages[1]!.footnotes).toEqual([]);
  });

  it('places a footnote on the page of a reference that falls on a later page (criterion 1)', () => {
    const items = [
      para(
        'a',
        Array.from({ length: 12 }, () => 10),
        [{ offset: 11, id: 'n1' }],
      ),
    ];
    const { pages } = paginate(items, body(100), { notes: notesOf(note('n1', [10, 10])) });
    expect(pages.length).toBe(2);
    expect(pages[0]!.footnotes).toEqual([]);
    expect(lineCount(fragmentsOn(pages[1]!.footnotes, 'n1-p'))).toBe(2);
    expect(fragmentsOn(pages[1]!.footnotes, 'n1-p')[0]!.y).toBeCloseTo(80, 6);
  });

  it('carries a footnote too long for its page on to the next pages, in order (criterion 3)', () => {
    const items = [para('a', [10], [{ offset: 0, id: 'long' }])];
    const { pages, pageCountSettled } = paginate(items, body(100), {
      notes: notesOf(
        note(
          'long',
          Array.from({ length: 30 }, () => 10),
        ),
      ),
    });
    expect(pageCountSettled).toBe(true);
    // Page 1 keeps its body line, so it holds nine footnote lines; the pages after it hold ten,
    // ten and one (a page with no body text takes the whole height).
    expect(pages.map((p) => lineCount(fragmentsOn(p.footnotes, 'long-p')))).toEqual([9, 10, 10, 1]);
    const froms = pages
      .flatMap((p) => fragmentsOn(p.footnotes, 'long-p'))
      .flatMap((f) => f.lines.map((l) => l.from));
    expect(froms).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(pages.every((p, i) => p.number === i + 1)).toBe(true);
  });

  it('places a footnote once, however many references name it', () => {
    const items = [
      para(
        'a',
        [10, 10, 10],
        [
          { offset: 0, id: 'n1' },
          { offset: 2, id: 'n1' },
        ],
      ),
    ];
    const { pages } = paginate(items, body(100), { notes: notesOf(note('n1', [10, 10])) });
    const all = pages.flatMap((p) => fragmentsOn(p.footnotes, 'n1-p'));
    expect(lineCount(all)).toBe(2);
  });

  it('places nothing for a footnote that no reference names', () => {
    const items = [para('a', [10, 10])];
    const { pages } = paginate(items, body(100), { notes: notesOf(note('unused', [10])) });
    expect(pages.every((p) => p.footnotes.length === 0)).toBe(true);
  });

  it('settles the body and the footnote areas on every page, and keeps the body above the areas (criterion 2)', () => {
    // A seeded sweep: random paragraphs with references, random footnotes (some longer than a
    // page's area), random page heights. mulberry32 keeps every bit of its 32-bit state, so the
    // draws are spread evenly (the sweep asserts that below).
    const random = mulberry32(0x5eed);
    const DOCUMENTS = 3000;
    let footnotePieces = 0;
    let footnotesAfterFirst = 0;
    let splitNotes = 0;
    let shortenedPages = 0;
    let headLineRefs = 0;
    const refCounts: number[] = [];
    for (let doc = 0; doc < DOCUMENTS; doc++) {
      const noteIds: string[] = [];
      const notes: NoteItem[] = [];
      const items: PageItem[] = [];
      const firstRef = new Map<string, { block: string; offset: number }>();
      const blocks = 1 + random(4);
      let refsInDoc = 0;
      for (let b = 0; b < blocks; b++) {
        const lineCount = 1 + random(14);
        const heights = Array.from({ length: lineCount }, () => 5 + random(16));
        const refs: NoteRef[] = [];
        for (let r = 0; r < lineCount; r++) {
          if (random(4) !== 0) continue;
          const id = `n${doc}-${noteIds.length}`;
          noteIds.push(id);
          refs.push({ offset: r, id });
          firstRef.set(id, { block: `b${b}`, offset: r });
          refsInDoc++;
          // One footnote in eight is long: up to twenty lines, often more than a page's area.
          const length = random(8) === 0 ? 6 + random(15) : 1 + random(4);
          notes.push(
            note(
              id,
              Array.from({ length }, () => 5 + random(12)),
            ),
          );
        }
        items.push(para(`b${b}`, heights, refs));
      }
      refCounts.push(refsInDoc);
      const height = 120 + random(160);
      const margins = { top: random(10), right: 0, bottom: random(10), left: 0 };
      const setup = body(height, { margins });
      const full = height - margins.top - margins.bottom;
      const result = paginate(items, setup, { notes: notesOf(...notes) });
      expect(result.pageCountSettled, `document ${doc}`).toBe(true);
      expect(result.overflowed, `document ${doc}`).toEqual([]);

      // Every body line once, in order, per block.
      for (let b = 0; b < blocks; b++) {
        const id = `b${b}`;
        const pieces = result.pages.flatMap((p) => fragmentsOn(p.fragments, id));
        let at = 0;
        for (const f of pieces) {
          for (const l of f.lines) {
            expect(l.from, `document ${doc} ${id}`).toBe(at);
            at = l.to;
          }
        }
        const total = (items[b] as ParagraphItem).fragment.lines.length;
        expect(at, `document ${doc} ${id}`).toBe(total);
      }

      // Every referenced footnote once: its lines in order, all of them.
      for (const n of notes) {
        const pieces = result.pages.flatMap((p) => fragmentsOn(p.footnotes, `${n.id}-p`));
        const got = pieces.flatMap((f) => f.lines.map((l) => l.from));
        expect(got, `document ${doc} ${n.id}`).toEqual(
          Array.from({ length: n.paragraphs[0]!.fragment.lines.length }, (_, i) => i),
        );
      }

      // The body of each page ends above its footnote area, and the area ends above the bottom margin.
      for (const p of result.pages) {
        const bodyBottom = p.fragments.reduce((m, f) => Math.max(m, f.y + f.height), 0);
        const areaTop = p.footnotes.reduce((m, f) => Math.min(m, f.y), Number.POSITIVE_INFINITY);
        const areaBottom = p.footnotes.reduce((m, f) => Math.max(m, f.y + f.height), 0);
        if (p.footnotes.length > 0) {
          expect(bodyBottom, `document ${doc} page ${p.index}`).toBeLessThanOrEqual(areaTop + EPS);
          expect(areaBottom, `document ${doc} page ${p.index}`).toBeLessThanOrEqual(
            height - margins.bottom + EPS,
          );
        }
        footnotePieces += p.footnotes.length;
        if (p.index > 0) footnotesAfterFirst += p.footnotes.length;
        // A page with footnotes whose next body line would have fitted without them: the area
        // took space from the body.
        const next = result.pages[p.index + 1]?.fragments[0];
        if (p.footnotes.length > 0 && next?.kind === 'paragraph') {
          const used = bodyBottom - margins.top;
          if (used + next.lines[0]!.height <= full + EPS) shortenedPages++;
        }
      }

      // Each footnote starts on the page of its reference, and is split only when it is taller
      // than that page's body less its first body line. The exception is a reference in the first
      // line of a page, which the page always takes (termination): text carried from the page
      // before comes first, so the footnote may start, or go on, after it.
      const pageOf = (blockId: string, offset: number): number =>
        result.pages.findIndex((p) =>
          fragmentsOn(p.fragments, blockId).some((f) =>
            f.lines.some((l) => offset >= l.from && offset < l.to),
          ),
        );
      const refPageOf = new Map<string, number>(
        notes.map((n) => {
          const ref = firstRef.get(n.id)!;
          return [`${n.id}-p`, pageOf(ref.block, ref.offset)];
        }),
      );
      for (const n of notes) {
        const ref = firstRef.get(n.id)!;
        const refPage = refPageOf.get(`${n.id}-p`)!;
        const page = result.pages[refPage]!;
        const head = page.fragments[0];
        const inHeadLine =
          head?.kind === 'paragraph' &&
          head.blockId === ref.block &&
          head.lines[0]!.from === ref.offset;
        // Text carried on to this page: footnote lines whose reference is on an earlier page.
        const carriedIn = page.footnotes.some(
          (f) => (refPageOf.get(f.blockId) ?? refPage) < refPage,
        );
        const notePages = result.pages
          .filter((p) => fragmentsOn(p.footnotes, `${n.id}-p`).length > 0)
          .map((p) => p.index);
        if (inHeadLine && carriedIn) {
          headLineRefs++;
          expect(notePages[0], `document ${doc} ${n.id}`).toBeGreaterThanOrEqual(refPage);
          continue;
        }
        expect(notePages[0], `document ${doc} ${n.id}`).toBe(refPage);
        if (notePages.length > 1) {
          splitNotes++;
          const headLine = head?.kind === 'paragraph' ? head.lines[0]!.height : 0;
          const noteHeight = n.paragraphs[0]!.fragment.height;
          expect(noteHeight, `document ${doc} ${n.id}`).toBeGreaterThan(full - headLine);
        }
      }
    }
    // The sweep is not hollow: the draws vary, many footnotes are placed, some on later pages,
    // some are split, and some areas push body text on to the next page.
    expect(new Set(refCounts).size).toBeGreaterThan(10);
    expect(refCounts.filter((c) => c === 0).length).toBeGreaterThan(DOCUMENTS / 50);
    expect(footnotePieces).toBeGreaterThan(DOCUMENTS);
    expect(footnotesAfterFirst).toBeGreaterThan(DOCUMENTS / 10);
    expect(splitNotes).toBeGreaterThan(DOCUMENTS / 100);
    expect(shortenedPages).toBeGreaterThan(DOCUMENTS / 10);
    // The first-line exception is the minority it should be.
    const totalRefs = refCounts.reduce((a, b) => a + b, 0);
    expect(headLineRefs).toBeLessThan(totalRefs / 20);
  });

  it('settles the areas under two columns too: the body of both columns ends above the area', () => {
    const random = mulberry32(0xc015);
    for (let doc = 0; doc < 500; doc++) {
      const notes: NoteItem[] = [];
      const items: PageItem[] = [];
      for (let b = 0; b < 1 + random(4); b++) {
        const count = 1 + random(14);
        const refs: NoteRef[] = [];
        for (let r = 0; r < count; r++) {
          if (random(4) !== 0) continue;
          const id = `n${doc}-${notes.length}`;
          refs.push({ offset: r, id });
          notes.push(
            note(
              id,
              Array.from({ length: 1 + random(4) }, () => 5 + random(12)),
            ),
          );
        }
        items.push(
          para(
            `b${b}`,
            Array.from({ length: count }, () => 5 + random(16)),
            refs,
          ),
        );
      }
      const height = 120 + random(160);
      const setup = body(height, { columns: 2, columnGap: 4 });
      const result = paginate(items, setup, { notes: notesOf(...notes) });
      expect(result.pageCountSettled, `document ${doc}`).toBe(true);
      for (const p of result.pages) {
        if (p.footnotes.length === 0) continue;
        const bodyBottom = p.fragments.reduce((m, f) => Math.max(m, f.y + f.height), 0);
        const areaTop = Math.min(...p.footnotes.map((f) => f.y));
        expect(bodyBottom, `document ${doc} page ${p.index}`).toBeLessThanOrEqual(areaTop + EPS);
      }
      for (const n of notes) {
        const got = result.pages
          .flatMap((p) => fragmentsOn(p.footnotes, `${n.id}-p`))
          .flatMap((f) => f.lines.map((l) => l.from));
        expect(got, `document ${doc} ${n.id}`).toEqual(
          n.paragraphs[0]!.fragment.lines.map((_, i) => i),
        );
      }
    }
  });

  it('places a footnote line taller than the page alone, one per page, and the pagination ends', () => {
    const items = [para('a', [10], [{ offset: 0, id: 'tall' }])];
    const { pages } = paginate(items, body(100), { notes: notesOf(note('tall', [150, 150, 150])) });
    const lines = pages.flatMap((p) => fragmentsOn(p.footnotes, 'tall-p')).flatMap((f) => f.lines);
    expect(lines.map((l) => l.from)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------------------------
// From the CDM: a footnote node in a paragraph, through the flow and the item adapter.

const measurer = fixedWidthMeasurer();
const breaks = {
  opportunities(text: string): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};
const providers: ItemProviders = { measurer, breaks, lineBreaker: firstFitBreaker };

function envelope(body: CdmNode[]): CdmEnvelopeLike {
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

describe('footnotes from the CDM (FE-084)', () => {
  it('places the footnote of a CDM footnote node on the page of its mark', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      paragraph(`p${i}`, [text(`Line ${i} of the body text.`)]),
    );
    const withNote = paragraph('ref', [
      text('The mark is here'),
      {
        type: 'footnote',
        attrs: { id: 'n1' },
        content: [paragraph('fn-1', [text('The footnote text.')])],
      },
      text(' and the sentence goes on.'),
    ]);
    const env = envelope([withNote, ...many]);
    const { first, items, unplaced, notes } = documentItems(toFlow(env), providers);
    expect(unplaced).toEqual([]);
    expect(notes.get('n1')?.paragraphs.map((p) => p.fragment.blockId)).toEqual(['fn-1']);

    const { pages, pageCountSettled } = paginate(items, first, { notes });
    expect(pageCountSettled).toBe(true);
    const placed = pages.flatMap((p, i) => fragmentsOn(p.footnotes, 'fn-1').map(() => i));
    expect(placed).toEqual([0]);
    // The footnote's bottom sits above the footer: the page's body is above it.
    const page0 = pages[0]!;
    const areaTop = Math.min(...fragmentsOn(page0.footnotes, 'fn-1').map((f) => f.y));
    const bodyBottom = page0.fragments.reduce((m, f) => Math.max(m, f.y + f.height), 0);
    expect(bodyBottom).toBeLessThanOrEqual(areaTop + EPS);
  });
});

describe('footnotes and an unsettled page count (FE-084, criterion 5)', () => {
  it('still terminates when the page count does not settle, with footnotes on the pages', () => {
    // A footer 90 points tall when the document has other than three pages, and none when it has
    // three (the footer test of paginate-regions.test.ts). The footnote of the paragraph's first
    // line is 10 points tall. With a count of 3 the footer goes and the body makes one page; with
    // any other count the footer comes back. The count never agrees, so the bounded passes end
    // with `pageCountSettled` false. The footnote sits on the page of its reference, and the body
    // keeps above its footnote area.
    const footer: StoryFactory = (ctx) => ({
      height: ctx.pageCount === 3 ? 0 : 90,
      fragments: [],
    });
    const items = [para('a', [10, 10, 10], [{ offset: 0, id: 'n1' }])];
    const notes = notesOf(note('n1', [10]));
    const result = paginate(items, body(100, { footers: { default: footer } }), { notes });
    expect(result.pageCountSettled).toBe(false);
    expect(Object.isFrozen(result.pages)).toBe(true);
    expect(result.pages.length).toBeGreaterThan(0);
    for (const page of result.pages) {
      const areaTop = page.footnotes.length
        ? Math.min(...page.footnotes.flatMap((f) => (f.kind === 'paragraph' ? [f.y] : [])))
        : Infinity;
      const bodyBottom = page.fragments.reduce((m, f) => Math.max(m, f.y + f.height), 0);
      expect(bodyBottom).toBeLessThanOrEqual(areaTop + EPS);
    }
    // The footnote of n1 is on the page of its reference, the first page.
    expect(lineCount(fragmentsOn(result.pages[0]!.footnotes, 'n1-p'))).toBe(1);
  });
});
