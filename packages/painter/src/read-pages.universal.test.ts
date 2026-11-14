/**
 * Read-only painted pages in real browsers (FE-095 criterion 4, the selection half): the painted
 * pages hold no editing surface and no input element, a range selected across two pages gives the
 * real text in document order, and the lines are in document order in the DOM, which is the order a
 * screen reader walks. Not covered here: the screen reader itself (FE-099) and the element's
 * `view="read"` mounting (not built). Runs in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser packages/painter/src/read-pages.universal.test.ts`); skipped in
 * Node.js.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutPage, LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';

const TEXTS = ['First page, first line.', 'First page, second line.', 'Second page, one line.'];

const pageOf = (index: number, blockId: string, text: string): LayoutPage => ({
  index,
  section: 0,
  width: 300,
  height: 200,
  fragments: [
    {
      kind: 'paragraph',
      blockId,
      from: 0,
      to: text.length,
      x: 20,
      y: 20,
      width: 260,
      height: 14,
      lines: [{ from: 0, to: text.length, x: 0, y: 0, width: 0, height: 14 }],
    },
  ],
  header: [],
  footer: [],
  footnotes: [],
});

const firstPage = pageOf(0, 'a', TEXTS[0]!);
const tree: LayoutTree = {
  engine: 'test',
  measurer: 'none',
  pages: [
    {
      ...firstPage,
      fragments: [...firstPage.fragments, { ...pageOf(0, 'b', TEXTS[1]!).fragments[0]!, y: 50 }],
    },
    pageOf(1, 'c', TEXTS[2]!),
  ],
};

const source: PaintSource = {
  lineText: (block, from, to) => {
    const i = block === 'a' ? 0 : block === 'b' ? 1 : 2;
    return TEXTS[i]!.slice(from, to);
  },
  fontFamily: 'serif',
  fontSizePt: 12,
};

const hasDom = typeof document !== 'undefined';

describe.skipIf(!hasDom)('read-only painted pages (FE-095)', () => {
  const made: HTMLElement[] = [];

  afterEach(() => {
    for (const el of made.splice(0)) el.remove();
    document.getSelection()?.removeAllRanges();
  });

  const paint = (): HTMLElement => {
    const host = document.createElement('div');
    host.style.width = '600px';
    document.body.appendChild(host);
    made.push(host);
    paintTree(host, tree, source, {});
    return host;
  };

  it('paints the pages with no editing surface and no input element', () => {
    const host = paint();
    expect(host.querySelectorAll('.de-page')).toHaveLength(2);
    expect(host.querySelector('[contenteditable], input, textarea, select')).toBeNull();
    expect(host.querySelector('[contenteditable]')).toBeNull();
  });

  it('keeps the painted lines in document order in the DOM', () => {
    const host = paint();
    const order = [...host.querySelectorAll<HTMLElement>('.de-line')].map((el) => el.textContent);
    expect(order).toEqual(TEXTS);
  });

  it('selects and copies text across two pages as the real text, in order', () => {
    const host = paint();
    const lines = host.querySelectorAll<HTMLElement>('.de-text');
    const first = lines[0]!.firstChild!;
    const last = lines[2]!.firstChild!;
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(last, last.textContent!.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    expect(selected).toContain('First page, first line.');
    expect(selected).toContain('First page, second line.');
    expect(selected).toContain('Second page, one line.');
    expect(selected.indexOf('first line')).toBeLessThan(selected.indexOf('Second page'));
  });
});
