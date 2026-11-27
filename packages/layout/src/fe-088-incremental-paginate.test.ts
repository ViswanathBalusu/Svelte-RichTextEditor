/**
 * Incremental pagination (FE-088, criterion 2), in Node.js. After an edit, `paginateIncremental`
 * restarts at the last page start before the first changed item, with the state the earlier pass
 * had there, and stops when its state at a page turn is the earlier state. The tests check three
 * things: the pagination equals the one `paginate` gives from scratch (a property over random
 * documents and random edits); the pass restarts at the first affected page; and it stops as soon
 * as the positions of the following blocks stop changing. The random documents use a seeded
 * generator.
 */
import { describe, expect, it } from 'vitest';
import {
  paginate,
  paginateIncremental,
  type NoteItem,
  type PageItem,
  type PageSetup,
  type PaginationMemo,
  type ParagraphItem,
  type SectionBreakItem,
} from './paginate.ts';
import type { ParagraphFragment } from './tree.ts';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const setup = (height: number, over: Partial<PageSetup> = {}): PageSetup => ({
  width: 80,
  height,
  margins: ZERO,
  ...over,
});

function para(
  id: string,
  lines: number,
  over: Partial<Omit<ParagraphItem, 'kind' | 'fragment'>> = {},
): ParagraphItem {
  const ls = Array.from({ length: lines }, (_, i) => ({
    from: i * 10,
    to: i * 10 + 10,
    x: 0,
    y: i * 10,
    width: 50,
    height: 10,
  }));
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: id,
    from: 0,
    to: lines * 10,
    x: 0,
    y: 0,
    width: 100,
    height: lines * 10,
    lines: ls,
  };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
    ...over,
  };
}

/** mulberry32: a small seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let fresh = 0;
function randomItem(r: () => number): PageItem {
  const x = r();
  if (x < 0.05) return { kind: 'pageBreak' };
  if (x < 0.08) return { kind: 'columnBreak' };
  if (x < 0.1)
    return {
      kind: 'sectionBreak',
      start: r() < 0.5 ? 'nextPage' : 'continuous',
      page: setup(100 + Math.floor(r() * 3) * 20, {
        columns: 1 + Math.floor(r() * 2),
        columnGap: 5,
      }),
    } satisfies SectionBreakItem;
  return para(`n${fresh++}`, 1 + Math.floor(r() * 14), {
    keepNext: r() < 0.2,
    keepLines: r() < 0.1,
    widowControl: r() < 0.5,
    pageBreakBefore: r() < 0.03,
  });
}

/** The shape of a pagination that must agree: pages, their fragments and the flags. */
const shape = (p: { pages: unknown; overflowed: unknown; pageCountSettled: boolean }): string =>
  JSON.stringify([p.pages, p.overflowed, p.pageCountSettled]);

/** Fails with the index of the first page that differs, not with both trees. */
function expectSame(
  got: { pages: readonly unknown[]; overflowed: unknown; pageCountSettled: boolean },
  want: { pages: readonly unknown[]; overflowed: unknown; pageCountSettled: boolean },
  label: string,
): void {
  const n = Math.max(got.pages.length, want.pages.length);
  for (let i = 0; i < n; i++)
    if (JSON.stringify(got.pages[i]) !== JSON.stringify(want.pages[i]))
      expect.fail(
        `${label}: page ${i} differs (${got.pages.length} pages, want ${want.pages.length})`,
      );
  expect(shape(got), label).toBe(shape(want));
}
/** A random edit: a paragraph gets another height, an item is inserted, or an item is removed. */
function edit(items: readonly PageItem[], r: () => number): PageItem[] {
  const next = [...items];
  const at = Math.floor(r() * next.length);
  const x = r();
  const item = next[at];
  if (x < 0.5 && item?.kind === 'paragraph') {
    next[at] = para(item.fragment.blockId, 1 + Math.floor(r() * 14), {
      keepNext: item.keepNext,
      keepLines: item.keepLines,
      widowControl: item.widowControl,
      pageBreakBefore: item.pageBreakBefore,
    });
  } else if (x < 0.8) next.splice(at, 0, randomItem(r));
  else if (next.length > 1) next.splice(at, 1);
  return next;
}

describe('incremental pagination equals pagination from scratch (FE-088)', () => {
  it('equals paginate after random edits, document by document (property)', () => {
    let incremental = 0;
    let stopped = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const r = rng(seed);
      let items = Array.from({ length: 40 + (seed % 40) }, () => randomItem(r));
      const first = setup(100, { columns: seed % 3 === 0 ? 2 : 1, columnGap: 5 });
      let memo: PaginationMemo | undefined;
      for (let step = 0; step < 6; step++) {
        const got = paginateIncremental(items, first, {}, memo);
        expectSame(got.pagination, paginate(items, first), `seed ${seed}, step ${step}`);
        if (got.mode === 'incremental') incremental++;
        if (got.stoppedAtPage !== null) stopped++;
        memo = got.memo;
        items = edit(items, r);
      }
    }
    // The property must have exercised the incremental path, and the early stop.
    expect(incremental).toBeGreaterThan(200);
    expect(stopped).toBeGreaterThan(20);
  });

  it('equals paginate when the footer depends on the page count', () => {
    const footers = {
      default: (c: { pageCount: number }) => ({
        height: 10,
        fragments: [{ ...para('f', 1).fragment, blockId: `count${c.pageCount}` }],
      }),
    };
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed * 7);
      let items = Array.from({ length: 50 }, () => randomItem(r)).filter(
        (i) => i.kind !== 'sectionBreak',
      );
      const first = setup(100, { footers });
      let memo: PaginationMemo | undefined;
      for (let step = 0; step < 5; step++) {
        const got = paginateIncremental(items, first, {}, memo);
        expectSame(got.pagination, paginate(items, first), `seed ${seed}, step ${step}`);
        memo = got.memo;
        items = edit(items, r).filter((i) => i.kind !== 'sectionBreak');
      }
    }
  });

  it('equals paginate with footnotes, and starts again when a footnote changes', () => {
    const note = (id: string, lines: number): NoteItem => ({ id, paragraphs: [para(id, lines)] });
    const withRefs = (items: PageItem[]): PageItem[] =>
      items.map((it, i) =>
        it.kind === 'paragraph' && i % 7 === 3
          ? { ...it, notes: [{ offset: 0, id: `fn${i % 5}` }] }
          : it,
      );
    const notesA = new Map(['fn0', 'fn1', 'fn2', 'fn3', 'fn4'].map((id) => [id, note(id, 2)]));
    const notesB = new Map(notesA).set('fn2', note('fn2', 5));
    for (let seed = 1; seed <= 15; seed++) {
      const r = rng(seed * 13);
      let items = withRefs(
        Array.from({ length: 50 }, () => randomItem(r)).filter((i) => i.kind !== 'sectionBreak'),
      );
      const first = setup(100);
      let memo: PaginationMemo | undefined;
      for (let step = 0; step < 4; step++) {
        const notes = step === 2 ? notesB : notesA;
        const got = paginateIncremental(items, first, { notes }, memo);
        expectSame(got.pagination, paginate(items, first, { notes }), `seed ${seed}, step ${step}`);
        if (step === 2) expect(got.mode).toBe('full');
        memo = got.memo;
        items = withRefs(edit(items, r).filter((i) => i.kind !== 'sectionBreak'));
      }
    }
  });
});

/** 30 pages of ten 4-line paragraphs (400 points), a page break after each ten, on pages of 500. */
function longDocument(): PageItem[] {
  const out: PageItem[] = [];
  for (let page = 0; page < 30; page++) {
    for (let k = 0; k < 10; k++) out.push(para(`p${page}-${k}`, 4));
    out.push({ kind: 'pageBreak' });
  }
  return out;
}

describe('the pass restarts at the first affected page and stops when positions settle (FE-088)', () => {
  const first = setup(500);

  it('lays a whole document out the first time, and nothing when it is unchanged', () => {
    const items = longDocument();
    const a = paginateIncremental(items, first);
    expect(a.mode).toBe('full');
    expect(a.itemsPlaced).toBe(items.length);
    const b = paginateIncremental(items, first, {}, a.memo);
    expect(b.mode).toBe('unchanged');
    expect(b.itemsPlaced).toBe(0);
    expect(b.pagination).toBe(a.pagination);
  });

  it('re-places one page after a paragraph grows, and keeps the pages around it', () => {
    const items = longDocument();
    const a = paginateIncremental(items, first);
    const edited = [...items];
    // p12-5 is the 6th paragraph on page 12 (0-based). It grows from 4 to 6 lines.
    const at = items.findIndex((i) => i.kind === 'paragraph' && i.fragment.blockId === 'p12-5');
    edited[at] = para('p12-5', 6);
    const b = paginateIncremental(edited, first, {}, a.memo);
    expect(b.mode).toBe('incremental');
    expect(shape(b.pagination)).toBe(shape(paginate(edited, first)));
    // It starts on the edited page and ends on the next one: one page and a bit, not thirty.
    expect(b.restartedAtPage).toBe(12);
    expect(b.stoppedAtPage).toBe(13);
    expect(b.itemsPlaced).toBeLessThan(25);
    expect(b.itemsPlaced).toBeLessThan(items.length / 10);
    // The pages before and after the edited page are the earlier objects, not copies.
    for (const p of [0, 1, 11, 14, 20, 29])
      expect(b.pagination.pages[p]).toBe(a.pagination.pages[p]);
    expect(b.pagination.pages[12]).not.toBe(a.pagination.pages[12]);
  });

  it('keeps stopping early across a run of edits, and the memo stays usable', () => {
    let items = longDocument();
    let memo = paginateIncremental(items, first).memo;
    for (const target of ['p3-2', 'p25-9', 'p0-0', 'p17-4', 'p29-9']) {
      const at = items.findIndex((i) => i.kind === 'paragraph' && i.fragment.blockId === target);
      items = [...items];
      items[at] = para(target, 5);
      const got = paginateIncremental(items, first, {}, memo);
      expect(shape(got.pagination)).toBe(shape(paginate(items, first)));
      expect(got.itemsPlaced, target).toBeLessThan(30);
      memo = got.memo;
    }
  });

  it('shifts the pages after an inserted block and renumbers nothing it should not', () => {
    const items = longDocument();
    const a = paginateIncremental(items, first);
    const at = items.findIndex((i) => i.kind === 'paragraph' && i.fragment.blockId === 'p5-3');
    const edited = [...items.slice(0, at), para('new', 2), ...items.slice(at)];
    const b = paginateIncremental(edited, first, {}, a.memo);
    expect(b.mode).toBe('incremental');
    expect(shape(b.pagination)).toBe(shape(paginate(edited, first)));
    expect(b.restartedAtPage).toBe(5);
    expect(b.stoppedAtPage).toBe(6);
    // A later edit works from the checkpoints that were shifted by the insertion.
    const at2 = edited.findIndex((i) => i.kind === 'paragraph' && i.fragment.blockId === 'p20-1');
    const edited2 = [...edited];
    edited2[at2] = para('p20-1', 7);
    const c = paginateIncremental(edited2, first, {}, b.memo);
    expect(shape(c.pagination)).toBe(shape(paginate(edited2, first)));
    expect(c.restartedAtPage).toBe(20);
    expect(c.itemsPlaced).toBeLessThan(25);
  });

  it('goes on to the end when a change moves every later page', () => {
    // No page breaks: a taller paragraph pushes every later line down, so no state repeats.
    const items = Array.from({ length: 200 }, (_, i) => para(`q${i}`, 4));
    const a = paginateIncremental(items, first);
    const edited = [...items];
    edited[20] = para('q20', 5);
    const b = paginateIncremental(edited, first, {}, a.memo);
    expect(shape(b.pagination)).toBe(shape(paginate(edited, first)));
    expect(b.stoppedAtPage).toBeNull();
    expect(b.restartedAtPage).toBeGreaterThan(0);
  });

  it('places a keepNext chain again from its head when a later member changes', () => {
    const items = longDocument().map((it, i) =>
      it.kind === 'paragraph' && i % 11 >= 7 && i % 11 < 9 ? { ...it, keepNext: true } : it,
    );
    const a = paginateIncremental(items, first);
    const at = items.findIndex((i) => i.kind === 'paragraph' && i.fragment.blockId === 'p8-8');
    const edited = [...items];
    edited[at] = para('p8-8', 12, { keepNext: true });
    const b = paginateIncremental(edited, first, {}, a.memo);
    expect(shape(b.pagination)).toBe(shape(paginate(edited, first)));
  });

  it('runs whole when the page setup changes, and when typeset pins are given', () => {
    const items = longDocument();
    const a = paginateIncremental(items, first);
    expect(paginateIncremental(items, setup(300), {}, a.memo).mode).toBe('full');
    const pinned = paginateIncremental(items, first, { pins: { pages: [] } }, a.memo);
    expect(pinned.mode).toBe('full');
    expect(pinned.memo.state).toBeNull();
    expect(paginateIncremental(items, first, {}, pinned.memo).mode).toBe('full');
  });
});
