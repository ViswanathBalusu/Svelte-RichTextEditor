/**
 * Background pagination in time slices (FE-089), in Node.js. The driver runs the same pass as
 * `paginate`, a slice at a time: the tests check that the slices give the same pages, that control
 * goes back to the host between slices, that heights are estimated for the pages not yet computed and
 * replaced when they are, and that the page count says whether it is final. The clock and the host's
 * turn are injected, so the runs are repeatable. The random documents use a seeded generator.
 */
import { describe, expect, it } from 'vitest';
import { paginateInSlices, paginationDriver } from './paginate-driver.ts';
import {
  paginate,
  type PageItem,
  type PageSetup,
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

function randomItems(seed: number, count: number): PageItem[] {
  const r = rng(seed);
  const out: PageItem[] = [];
  for (let i = 0; i < count; i++) {
    const x = r();
    if (x < 0.05) out.push({ kind: 'pageBreak' });
    else if (x < 0.08) out.push({ kind: 'columnBreak' });
    else if (x < 0.1)
      out.push({
        kind: 'sectionBreak',
        start: r() < 0.5 ? 'nextPage' : 'continuous',
        page: setup(100 + Math.floor(r() * 3) * 20, {
          columns: 1 + Math.floor(r() * 2),
          columnGap: 5,
        }),
      } satisfies SectionBreakItem);
    else
      out.push(
        para(`p${i}`, 1 + Math.floor(r() * 14), {
          keepNext: r() < 0.2,
          keepLines: r() < 0.1,
          widowControl: r() < 0.5,
          pageBreakBefore: r() < 0.03,
        }),
      );
  }
  return out;
}

/** The shape of a pagination that must agree: pages, their fragments and the flags. */
const shape = (p: { pages: unknown; overflowed: unknown; pageCountSettled: boolean }): string =>
  JSON.stringify([p.pages, p.overflowed, p.pageCountSettled]);

describe('time slices give the pages of paginate (FE-089)', () => {
  it('equals paginate for 60 random documents, whatever the slice length', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const items = randomItems(seed, 40 + (seed % 30));
      const first = setup(100, { columns: seed % 3 === 0 ? 2 : 1, columnGap: 5 });
      const whole = paginate(items, first);
      for (const every of [1, 3, 17, Number.POSITIVE_INFINITY]) {
        const driver = paginationDriver(items, first);
        let n = 0;
        while (!driver.step(() => ++n % every === 0));
        expect(shape(driver.result!), `seed ${seed}, slice of ${every} items`).toBe(shape(whole));
      }
    }
  });

  it('equals paginate when the page count changes the footer, which repeats the pass', () => {
    const footers = {
      default: (c: { pageCount: number }) => ({
        height: c.pageCount >= 6 ? 30 : 10,
        fragments: [],
      }),
    };
    const items = Array.from({ length: 30 }, (_, i) => para(`p${i}`, 6));
    const first = setup(100, { footers });
    const whole = paginate(items, first);
    const driver = paginationDriver(items, first);
    let passes = 0;
    let last = 0;
    // A slice of one item shows the pass number through the item count falling back to zero.
    while (
      !driver.step(() => {
        if (driver.itemsDone < last) passes++;
        last = driver.itemsDone;
        return true;
      })
    );
    expect(passes).toBeGreaterThan(0);
    expect(shape(driver.result!)).toBe(shape(whole));
  });
});

describe('the driver gives control back between slices (FE-089 criterion 1)', () => {
  const items = Array.from({ length: 200 }, (_, i) => para(`p${i}`, 5));

  it('places an item in every slice but the last, and ends only when every item is placed', () => {
    const driver = paginationDriver(items, setup(100));
    let calls = 0;
    let previous = 0;
    while (!driver.step(() => true)) {
      calls++;
      expect(driver.itemsDone).toBeGreaterThan(previous);
      previous = driver.itemsDone;
      expect(driver.done).toBe(false);
      expect(driver.result).toBeNull();
    }
    expect(calls).toBe(200);
    // The last call closes the final page and returns the result.
    expect(driver.slices).toBe(201);
    expect(driver.done).toBe(true);
  });

  it('runs input between slices: events queued during the run are handled before it ends', async () => {
    // A fake clock that advances 1 ms for each reading, a slice of 20 ms, and a host that handles
    // one queued input event each time it is given a turn.
    let clock = 0;
    const handled: Array<{ at: number; final: boolean; itemsDone: number }> = [];
    let driverRef: ReturnType<typeof paginationDriver> | null = null;
    const queue: Array<() => void> = Array.from({ length: 5 }, (_, k) => () => {
      const d = driverRef!;
      handled.push({ at: k, final: d.pageCount().final, itemsDone: d.itemsDone });
    });
    const result = await paginateInSlices(
      items,
      setup(100),
      {},
      {
        now: () => clock++,
        sliceMs: 20,
        yieldToHost: async () => {
          queue.shift()?.();
        },
      },
      (d) => {
        driverRef = d;
      },
    );
    expect(shape(result)).toBe(shape(paginate(items, setup(100))));
    // Every event ran, each one while the pagination was still going.
    expect(handled).toHaveLength(5);
    for (const h of handled) {
      expect(h.final).toBe(false);
      expect(h.itemsDone).toBeLessThan(items.length);
    }
    expect(driverRef!.slices).toBeGreaterThan(5);
  });

  it('does not run the next slice before the host has had its turn', async () => {
    const log: string[] = [];
    let clock = 0;
    await paginateInSlices(
      items.slice(0, 60),
      setup(100),
      {},
      {
        now: () => clock++,
        sliceMs: 10,
        yieldToHost: async () => {
          log.push('host');
        },
      },
      () => log.push('slice'),
    );
    // Slices and host turns alternate, and the last entry is the final slice.
    for (let i = 0; i < log.length; i++) expect(log[i]).toBe(i % 2 === 0 ? 'slice' : 'host');
    expect(log[log.length - 1]).toBe('slice');
    expect(log.length).toBeGreaterThan(3);
  });
});

describe('estimated heights and the page count (FE-089 criteria 2 and 4)', () => {
  // The first section has pages 100 tall, then a section of pages 300 tall starts.
  const items: PageItem[] = [
    ...Array.from({ length: 20 }, (_, i) => para(`a${i}`, 5)),
    { kind: 'sectionBreak', start: 'nextPage', page: setup(300) } satisfies SectionBreakItem,
    ...Array.from({ length: 20 }, (_, i) => para(`b${i}`, 5)),
  ];

  it('estimates a page that is not computed with the mean of those that are, then replaces it', () => {
    const driver = paginationDriver(items, setup(100));
    // Run until the first section has closed four pages.
    while (driver.heights.computedCount < 4) driver.step(() => true);
    const ahead = driver.heights.heightOf(30);
    expect(ahead.estimated).toBe(true);
    expect(ahead.height).toBe(100);
    expect(driver.heights.heightOf(0)).toEqual({ height: 100, estimated: false });
    while (!driver.step(() => true));
    const pages = driver.result!.pages;
    pages.forEach((p, i) => {
      expect(driver.heights.heightOf(i)).toEqual({ height: p.height, estimated: false });
    });
    expect(pages.some((p) => p.height === 300)).toBe(true);
    // A page past the end is an estimate again, with the mean of the computed heights.
    const past = driver.heights.heightOf(pages.length + 5);
    expect(past.estimated).toBe(true);
    expect(past.height).toBeCloseTo(pages.reduce((s, p) => s + p.height, 0) / pages.length, 9);
  });

  it('reports the count as not final until the pagination has ended, and final at the end', () => {
    const driver = paginationDriver(items, setup(100));
    expect(driver.pageCount()).toEqual({ placed: 0, projected: 0, final: false });
    let previous = 0;
    while (!driver.step(() => true)) {
      const c = driver.pageCount();
      expect(c.final).toBe(false);
      expect(c.placed).toBeGreaterThanOrEqual(previous);
      expect(c.projected).toBeGreaterThanOrEqual(c.placed);
      previous = c.placed;
    }
    const end = driver.pageCount();
    expect(end.final).toBe(true);
    expect(end.placed).toBe(driver.result!.pages.length);
    expect(end.projected).toBe(end.placed);
  });
});
