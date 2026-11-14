/**
 * The DOM painter in real browsers (FE-090, FE-091): lines are absolutely positioned at the tree's
 * points, never re-wrapped, and justified by computed word spacing that reaches the paragraph's
 * right edge. Runs in Chromium, Firefox and WebKit (`pnpm vitest run --project browser <file>`);
 * in Node.js, which has no DOM, the suite is skipped.
 *
 * The measurer is canvas `measureText` in the same family as the painted text, so the widths the
 * layout would compute and the widths the browser paints come from one font.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';

const TEXT = 'The quick brown fox jumps over the lazy dog';
const FIRST = 'The quick brown fox ';
const SECOND = 'jumps over the lazy dog';
const FAMILY = 'serif';
const SIZE_PT = 12;
const PX_PER_PT = 96 / 72;

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
    { from: 0, to: FIRST.length, x: 0, y: 0, width: 0, height: 14 },
    { from: FIRST.length, to: TEXT.length, x: 0, y: 14, width: 0, height: 14 },
  ],
});

const tree: LayoutTree = {
  engine: 'test',
  measurer: 'canvas',
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

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('DOM painter (FE-090, FE-091)', () => {
  let host: HTMLElement | null = null;

  const source = (): PaintSource => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) throw new Error('no 2D context');
    ctx.font = `${SIZE_PT * PX_PER_PT}px ${FAMILY}`;
    return {
      lineText: (_block, from, to) => TEXT.slice(from, to),
      fontFamily: FAMILY,
      fontSizePt: SIZE_PT,
      measure: (text) => ctx.measureText(text).width / PX_PER_PT,
    };
  };

  const mount = (width: string): HTMLElement => {
    const el = document.createElement('div');
    el.style.width = width;
    document.body.appendChild(el);
    host = el;
    return el;
  };

  afterEach(() => {
    host?.remove();
    host = null;
  });

  it('paints each line as an absolutely positioned box with white-space pre, from DOM', () => {
    const root = mount('600px');
    const { pages, lineCount } = paintTree(root, tree, source());
    expect(lineCount).toBe(2);
    const lines = [...pages[0]!.querySelectorAll<HTMLElement>('.de-line')];
    expect(lines.map((l) => l.querySelector('.de-text')?.textContent)).toEqual([FIRST, SECOND]);
    for (const line of lines) {
      expect(getComputedStyle(line).position).toBe('absolute');
      expect(getComputedStyle(line).whiteSpace).toBe('pre');
    }
  });

  it('paints inside the shadow root of the element, and not outside it', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    host = el;
    const root = el.attachShadow({ mode: 'open' });
    const { lineCount } = paintTree(root, tree, source());
    expect(lineCount).toBe(2);
    expect(root.querySelectorAll('.de-line').length).toBe(2);
    expect(document.querySelectorAll('.de-line').length).toBe(0);
  });

  it('places every painted line where the tree puts it', () => {
    const root = mount('600px');
    const { pages } = paintTree(root, tree, source());
    const pageBox = pages[0]!.getBoundingClientRect();
    const expected = [
      { x: 20, y: 30 },
      { x: 20, y: 44 },
    ];
    const lines = [...pages[0]!.querySelectorAll<HTMLElement>('.de-line')];
    lines.forEach((line, i) => {
      const box = line.getBoundingClientRect();
      expect(Math.abs(box.left - pageBox.left - expected[i]!.x * PX_PER_PT)).toBeLessThanOrEqual(
        0.5,
      );
      expect(Math.abs(box.top - pageBox.top - expected[i]!.y * PX_PER_PT)).toBeLessThanOrEqual(0.5);
    });
  });

  it('does not re-wrap a line when the container narrows', () => {
    const root = mount('600px');
    const { pages } = paintTree(root, tree, source());
    const lines = [...pages[0]!.querySelectorAll<HTMLElement>('.de-line')];
    const before = lines.map((l) => l.getBoundingClientRect().height);
    root.style.width = '120px';
    lines.forEach((line, i) => {
      expect(line.getClientRects().length).toBe(1);
      const span = line.querySelector<HTMLElement>('.de-text')!;
      expect(span.getClientRects().length).toBe(1);
      expect(line.getBoundingClientRect().height).toBeCloseTo(before[i]!, 3);
    });
  });

  it('paints text that is selectable and searchable as DOM text', () => {
    const root = mount('600px');
    const { pages } = paintTree(root, tree, source());
    const span = pages[0]!.querySelector<HTMLElement>('.de-text')!;
    const range = document.createRange();
    range.selectNodeContents(span);
    expect(range.toString()).toBe(FIRST);
    expect(pages[0]!.textContent).toContain(SECOND);
  });

  it('justifies every line but the last to the right edge of the paragraph (FE-091)', () => {
    const root = mount('600px');
    const { pages } = paintTree(root, tree, source(), { justify: () => true });
    const lines = [...pages[0]!.querySelectorAll<HTMLElement>('.de-line')];
    const first = lines[0]!.querySelector<HTMLElement>('.de-text')!;
    const last = lines[1]!.querySelector<HTMLElement>('.de-text')!;

    // Computed word spacing is applied to the justified line and not to the last one.
    expect(parseFloat(getComputedStyle(first).wordSpacing)).toBeGreaterThan(0);
    expect(parseFloat(getComputedStyle(last).wordSpacing) || 0).toBe(0);

    // The painted width reaches the right edge: the line starts at x = 20 pt and the paragraph
    // ends at 20 + 200 = 220 pt, so the target is 200 pt. Half a pixel is the tolerance.
    const paintedPx = first.getBoundingClientRect().width;
    expect(Math.abs(paintedPx - 200 * PX_PER_PT)).toBeLessThanOrEqual(0.5);
  });
});
