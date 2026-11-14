/**
 * The caret and the selection under `forced-colors: active` (FE-096 criterion 5; FE-019). Each box
 * sets `forced-color-adjust: none`, so the browser keeps its system colour instead of replacing the
 * background with the canvas colour, and the caret stays visible.
 *
 * Vitest's browser mode has no media emulation, so this file runs under its own config, which sets
 * `forcedColors: 'active'` on the Playwright context:
 *   pnpm vitest run --config tests/V-FE-081-096/vitest.forced-colors.config.ts
 * In the root `browser` project the suite is skipped, because forced colours are not active there.
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

const tree: LayoutTree = {
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

const span = (_block: string, from: number, to: number): number => to - from;

const source: PaintSource = {
  lineText: (_block, from, to) => TEXT.slice(from, to),
  fontFamily: 'serif',
  fontSizePt: 12,
};

const hasDom = typeof document !== 'undefined';
const forced = hasDom && window.matchMedia('(forced-colors: active)').matches;

describe.skipIf(!forced)('caret and selection under forced colours (FE-096 criterion 5)', () => {
  let host: HTMLElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  const draw = (anchor: number, head: number): HTMLElement => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const painted = paintTree(host, tree, source);
    paintSelection(document, painted.pages, tree, span, {
      anchor: { blockId: 'p1', offset: anchor },
      head: { blockId: 'p1', offset: head },
    });
    return host;
  };

  // A reference box with the same keyword and the same override, so its computed colour is the
  // system colour the keyword names in this mode.
  const reference = (keyword: string): string => {
    const ref = document.createElement('div');
    ref.style.background = keyword;
    ref.style.forcedColorAdjust = 'none';
    host!.appendChild(ref);
    return getComputedStyle(ref).backgroundColor;
  };

  it('keeps the selection in the system highlight colour', () => {
    draw(4, 15);
    const selection = host!.querySelector<HTMLElement>('.de-selection')!;
    expect(getComputedStyle(selection).backgroundColor).toBe(reference('Highlight'));
  });

  it('keeps the caret in the system text colour, not the canvas colour', () => {
    draw(13, 13);
    const caret = host!.querySelector<HTMLElement>('.de-caret')!;
    expect(getComputedStyle(caret).backgroundColor).toBe(reference('CanvasText'));
    expect(getComputedStyle(caret).backgroundColor).not.toBe(reference('Canvas'));
  });
});
