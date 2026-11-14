/**
 * The virtualised page window in real browsers (FE-092 criteria 1 and 3): only the visible pages
 * and the overscan are mounted, their number does not depend on the document's length, pages
 * mount and unmount as the scroller moves, and the stacked height does not change. Runs in
 * Chromium, Firefox and WebKit (`pnpm vitest run --project browser <file>`); skipped in Node.js.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutPage, LayoutTree } from '../../layout/src/tree.ts';
import { mountPageWindow, type PageWindow } from './window.ts';
import type { PaintSource } from './painter.ts';

const TEXT = 'Hello page';
const PAGE_HEIGHT_PT = 400;
const PX_PER_PT = 96 / 72;

const page = (index: number): LayoutPage => ({
  index,
  section: 0,
  width: 300,
  height: PAGE_HEIGHT_PT,
  fragments: [
    {
      kind: 'paragraph',
      blockId: `b${index}`,
      from: 0,
      to: TEXT.length,
      x: 20,
      y: 20,
      width: 200,
      height: 14,
      lines: [{ from: 0, to: TEXT.length, x: 0, y: 0, width: 0, height: 14 }],
    },
  ],
  header: [],
  footer: [],
  footnotes: [],
});

const treeOf = (pages: number): LayoutTree => ({
  engine: 'test',
  measurer: 'none',
  pages: Array.from({ length: pages }, (_, i) => page(i)),
});

const source: PaintSource = {
  lineText: (_block, from, to) => TEXT.slice(from, to),
  fontFamily: 'serif',
  fontSizePt: 12,
};

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('page window (FE-092)', () => {
  const made: HTMLElement[] = [];
  const windows: PageWindow[] = [];

  const scroller = (): HTMLElement => {
    const el = document.createElement('div');
    el.style.width = '800px';
    el.style.height = '600px';
    el.style.overflow = 'auto';
    el.style.position = 'relative';
    document.body.appendChild(el);
    made.push(el);
    return el;
  };

  afterEach(() => {
    for (const w of windows.splice(0)) w.dispose();
    for (const el of made.splice(0)) el.remove();
  });

  it('mounts the same small number of pages whatever the length of the document', () => {
    const counts = [100, 1000, 5000].map((n) => {
      const el = scroller();
      const win = mountPageWindow(el, treeOf(n), source, { overscan: 1 });
      windows.push(win);
      return {
        n,
        mounted: win.mountedPages().length,
        nodes: el.querySelectorAll('.de-page').length,
      };
    });
    for (const c of counts) {
      expect(c.mounted).toBeGreaterThan(0);
      expect(c.mounted).toBeLessThanOrEqual(4);
      expect(c.nodes).toBe(c.mounted);
    }
    expect(new Set(counts.map((c) => c.mounted)).size).toBe(1);
  });

  it('mounts and unmounts pages as the scroller moves, and keeps every page height', () => {
    const el = scroller();
    const win = mountPageWindow(el, treeOf(1000), source, { overscan: 1 });
    windows.push(win);
    expect(win.mountedPages()).toContain(0);
    const heightBefore = el
      .querySelector<HTMLElement>('.de-window')!
      .getBoundingClientRect().height;

    // Page 500 starts at 500 * (400 + gap) points; move the scroller there and fire its event.
    const gap = 12;
    el.scrollTop = 500 * (PAGE_HEIGHT_PT + gap) * PX_PER_PT;
    el.dispatchEvent(new Event('scroll'));
    const mounted = win.mountedPages();
    expect(mounted).toContain(500);
    expect(mounted).not.toContain(0);
    expect(mounted.length).toBeLessThanOrEqual(4);
    expect(el.querySelector('[data-page="0"]')).toBeNull();
    expect(el.querySelector('[data-page="500"]')).not.toBeNull();

    // The unmounted page keeps its height, and the stacked height has not moved.
    expect(win.heightOf(0)).toBe(PAGE_HEIGHT_PT);
    const heightAfter = el.querySelector<HTMLElement>('.de-window')!.getBoundingClientRect().height;
    expect(heightAfter).toBeCloseTo(heightBefore, 3);
  });

  it('places a mounted page at its stacked position', () => {
    const el = scroller();
    const win = mountPageWindow(el, treeOf(10), source, { overscan: 1 });
    windows.push(win);
    const spacer = el.querySelector<HTMLElement>('.de-window')!;
    const second = spacer.querySelector<HTMLElement>('[data-page="1"]')!;
    const expectedTop = (PAGE_HEIGHT_PT + 12) * PX_PER_PT;
    const delta = second.getBoundingClientRect().top - spacer.getBoundingClientRect().top;
    expect(Math.abs(delta - expectedTop)).toBeLessThanOrEqual(0.5);
  });
});
