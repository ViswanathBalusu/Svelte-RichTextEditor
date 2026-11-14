/**
 * FE-092 criterion 4, the scale run in real browsers (lane V-FE-081-096): a 1,000-page document is
 * mounted in the page window and scrolled from its first page to its last, one page at a time. The
 * run checks that the mounted pages stay within the overscan bound at every step and that the last
 * page mounts, and it records how long each window update takes. The figures are printed for the
 * record only: FE-092 criteria 4 and 5 are targets that count as met only on the reference machine,
 * so no timing is asserted here. Runs in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser packages/painter/src/fe-092-scale.universal.test.ts`); skipped in Node.js.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutPage, LayoutTree } from '../../layout/src/tree.ts';
import { mountPageWindow, type PageWindow } from './window.ts';
import type { PaintSource } from './painter.ts';

const TEXT = 'Scale page text';
const PAGE_HEIGHT_PT = 400;
const GAP_PT = 12;
const PX_PER_PT = 96 / 72;
const PAGES = 1000;
const OVERSCAN = 1;

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

const tree: LayoutTree = {
  engine: 'test',
  measurer: 'none',
  pages: Array.from({ length: PAGES }, (_, i) => page(i)),
};

const source: PaintSource = {
  lineText: (_block, from, to) => TEXT.slice(from, to),
  fontFamily: 'serif',
  fontSizePt: 12,
};

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('page window at 1,000 pages (FE-092 criterion 4, scale run)', () => {
  const made: HTMLElement[] = [];
  const windows: PageWindow[] = [];

  afterEach(() => {
    for (const w of windows.splice(0)) w.dispose();
    for (const el of made.splice(0)) el.remove();
  });

  it('scrolls a 1,000-page document from the first page to the last with a bounded mount', () => {
    const el = document.createElement('div');
    el.style.width = '800px';
    el.style.height = '600px';
    el.style.overflow = 'auto';
    el.style.position = 'relative';
    document.body.appendChild(el);
    made.push(el);

    const win = mountPageWindow(el, tree, source, { overscan: OVERSCAN });
    windows.push(win);

    // A visible height of 600 px is about 450 pt, so at most one page and a part of two are seen,
    // and the overscan adds one page on each side: four pages at most.
    const bound = 4;
    const stepPt = PAGE_HEIGHT_PT + GAP_PT;
    const times: number[] = [];
    let maxMounted = 0;

    for (let i = 0; i < PAGES; i++) {
      el.scrollTop = i * stepPt * PX_PER_PT;
      const t0 = performance.now();
      win.update();
      times.push(performance.now() - t0);
      const mounted = win.mountedPages();
      maxMounted = Math.max(maxMounted, mounted.length);
      expect(mounted.length).toBeLessThanOrEqual(bound);
      expect(mounted).toContain(i);
    }

    expect(maxMounted).toBeLessThanOrEqual(bound);
    expect(el.querySelectorAll('.de-page').length).toBeLessThanOrEqual(bound);

    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((s, t) => s + t, 0) / times.length;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    // Printed for the record: this machine and browser only, not the reference machine of FE-092.
    console.log(
      `[FE-092 scale] pages=${PAGES} overscan=${OVERSCAN} maxMounted=${maxMounted} ` +
        `updateMeanMs=${mean.toFixed(3)} updateP95Ms=${p95.toFixed(3)} ` +
        `ua=${navigator.userAgent.slice(0, 60)}`,
    );
  });
});
