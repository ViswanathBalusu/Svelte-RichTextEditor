/**
 * Caret and selection boxes in the DOM (FE-096 criteria 3 and 4). The positions come from the layout
 * tree: a collapsed selection draws one caret, a range draws one box per line it crosses, and the
 * boxes sit where `caretGeometry` and `selectionRects` put them. Runs in Chromium, Firefox and
 * WebKit (`pnpm vitest run --project browser packages/painter/src/selection-paint.universal.test.ts`);
 * in Node.js, which has no DOM, the suite is skipped. The forced-colours check is in
 * `selection-forced.universal.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';
import { paintSelection } from './selection-paint.ts';

const TEXT = 'abcdefghijklmnopqrst';

const paragraph = (): ParagraphFragment => ({
  kind: 'paragraph',
  blockId: 'p1',
  from: 0,
  to: TEXT.length,
  x: 20,
  y: 30,
  width: 200,
  height: 28,
  lines: [
    { from: 0, to: 10, x: 0, y: 0, width: 0, height: 14 },
    { from: 10, to: 20, x: 0, y: 14, width: 0, height: 14 },
  ],
});

export const selectionTree: LayoutTree = {
  engine: 'test',
  measurer: 'fixed',
  pages: [
    {
      index: 0,
      section: 0,
      width: 300,
      height: 200,
      fragments: [paragraph()],
      header: [],
      footer: [],
      footnotes: [],
    },
  ],
};

/** One point per character: the widths are exact and the boxes are easy to check. */
export const selectionSpan = (_block: string, from: number, to: number): number => to - from;

const source: PaintSource = {
  lineText: (_block, from, to) => TEXT.slice(from, to),
  fontFamily: 'serif',
  fontSizePt: 12,
};

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('caret and selection boxes (FE-096 criteria 3, 4)', () => {
  let host: HTMLElement | null = null;

  const mount = () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    return paintTree(host, selectionTree, source);
  };

  afterEach(() => {
    host?.remove();
    host = null;
  });

  it('draws one caret at the position, from the tree (criterion 3)', () => {
    const painted = mount();
    const result = paintSelection(document, painted.pages, selectionTree, selectionSpan, {
      anchor: { blockId: 'p1', offset: 13 },
      head: { blockId: 'p1', offset: 13 },
    });
    expect(result).toEqual({ caretCount: 1, rectCount: 0 });
    const caret = host!.querySelectorAll<HTMLElement>('.de-caret');
    expect(caret.length).toBe(1);
    // Line 2 starts at x 20 and y 44; offset 13 is 3 points in.
    expect(caret[0]!.style.left).toBe('23pt');
    expect(caret[0]!.style.top).toBe('44pt');
    expect(caret[0]!.style.height).toBe('14pt');
    expect(host!.querySelectorAll('.de-selection').length).toBe(0);
  });

  it('draws one box per line a range crosses (criterion 4)', () => {
    const painted = mount();
    const result = paintSelection(document, painted.pages, selectionTree, selectionSpan, {
      anchor: { blockId: 'p1', offset: 4 },
      head: { blockId: 'p1', offset: 15 },
    });
    expect(result).toEqual({ caretCount: 0, rectCount: 2 });
    const boxes = [...host!.querySelectorAll<HTMLElement>('.de-selection')];
    expect(boxes.map((b) => [b.style.left, b.style.top, b.style.width])).toEqual([
      ['24pt', '30pt', '6pt'],
      ['20pt', '44pt', '5pt'],
    ]);
  });

  it('draws the selection in the system highlight colour (FE-019)', () => {
    const painted = mount();
    paintSelection(document, painted.pages, selectionTree, selectionSpan, {
      anchor: { blockId: 'p1', offset: 4 },
      head: { blockId: 'p1', offset: 15 },
    });
    const ref = document.createElement('div');
    ref.style.background = 'Highlight';
    host!.appendChild(ref);
    const box = host!.querySelector<HTMLElement>('.de-selection')!;
    expect(getComputedStyle(box).backgroundColor).toBe(getComputedStyle(ref).backgroundColor);
  });

  it('draws nothing for a position the tree does not hold', () => {
    const painted = mount();
    const result = paintSelection(document, painted.pages, selectionTree, selectionSpan, {
      anchor: { blockId: 'missing', offset: 0 },
      head: { blockId: 'missing', offset: 0 },
    });
    expect(result).toEqual({ caretCount: 0, rectCount: 0 });
  });
});
