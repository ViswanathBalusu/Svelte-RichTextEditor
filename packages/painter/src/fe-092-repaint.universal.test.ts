/**
 * FE-092, criterion 2: after an edit in one paragraph, the view changes only the affected lines and
 * pages. `repaintTree` keeps the elements of unchanged pages and lines, and a MutationObserver on
 * the view shows no mutation outside the edited line's page. Runs in Chromium, Firefox and WebKit
 * (`pnpm vitest run --project browser packages/painter/src/fe-092-repaint.universal.test.ts`); in
 * Node.js, which has no DOM, the suite is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import type { PaintSource } from './painter.ts';
import { repaintTree } from './repaint.ts';

const SIZE_PT = 12;
const FAMILY = 'serif';
const hasDom = typeof document !== 'undefined';

/** Three pages, one two-line paragraph each. Each paragraph's text is split at 9 for its lines. */
function build(texts: Record<string, string>): { tree: LayoutTree; source: PaintSource } {
  const blocks = ['a', 'b', 'c'];
  const pages = blocks.map((blockId, i) => {
    const paragraph: ParagraphFragment = {
      kind: 'paragraph',
      blockId,
      from: 0,
      to: 18,
      x: 20,
      y: 20,
      width: 300,
      height: 28,
      lines: [
        { from: 0, to: 9, x: 0, y: 0, width: 0, height: 14 },
        { from: 9, to: 18, x: 0, y: 14, width: 0, height: 14 },
      ],
    };
    return {
      index: i,
      section: 0,
      width: 400,
      height: 100,
      fragments: [paragraph],
      header: [],
      footer: [],
      footnotes: [],
    };
  });
  const tree: LayoutTree = { engine: 'test', measurer: 'canvas', pages };
  const source: PaintSource = {
    lineText: (block, from, to) => texts[block]!.slice(from, to),
    fontFamily: FAMILY,
    fontSizePt: SIZE_PT,
  };
  return { tree, source };
}

const TEXTS = { a: 'alpha one alpha two', b: 'beta one beta two', c: 'gamma one gamma two' };

describe.skipIf(!hasDom)('repaint keeps unchanged pages and lines (FE-092, criterion 2)', () => {
  let host: HTMLElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  const view = (): HTMLElement => {
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    return el;
  };

  it('makes no DOM mutation when repainting the same content', () => {
    const root = view();
    const { tree, source } = build({ ...TEXTS });
    repaintTree(root, tree, source);
    const observer = new MutationObserver(() => {});
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const result = repaintTree(root, tree, source);
    expect(observer.takeRecords().length).toBe(0);
    expect(result.lineCount).toBe(6);
    observer.disconnect();
  });

  it('after an edit in one paragraph, mutates only the edited line and its page', () => {
    const root = view();
    const before = build({ ...TEXTS });
    repaintTree(root, before.tree, before.source);
    const pagesBefore = [...root.querySelectorAll<HTMLElement>('.de-page')];
    const linesBefore = [...root.querySelectorAll<HTMLElement>('.de-line')];
    const bLine0Before = linesBefore[2]!;
    const bLine1Before = linesBefore[3]!;
    expect(bLine0Before.dataset['block']).toBe('b');
    expect(bLine1Before.dataset['block']).toBe('b');

    // The edit changes the text of the first line of block b; the layout tree is unchanged.
    const after = build({ ...TEXTS, b: 'beta ONE beta two' });
    const observer = new MutationObserver(() => {});
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    repaintTree(root, after.tree, after.source);
    const records = observer.takeRecords();
    observer.disconnect();

    // Every mutation is on page 1 (the page of block b): no other page and no other line changed.
    const pagesAfter = [...root.querySelectorAll<HTMLElement>('.de-page')];
    expect(pagesAfter.length).toBe(3);
    expect(pagesAfter[0]).toBe(pagesBefore[0]);
    expect(pagesAfter[2]).toBe(pagesBefore[2]);
    expect(records.length).toBeGreaterThan(0);
    const targets = new Set(records.map((r) => r.target));
    expect(targets.has(pagesBefore[0]!)).toBe(false);
    expect(targets.has(pagesBefore[2]!)).toBe(false);
    expect(targets.has(pagesBefore[1]!)).toBe(true);
    for (const r of records) {
      expect(r.type).toBe('childList');
      expect(r.target).toBe(pagesBefore[1]);
    }

    // The unchanged line of block b, and the lines of blocks a and c, are the same elements.
    const linesAfter = [...root.querySelectorAll<HTMLElement>('.de-line')];
    expect(linesAfter.length).toBe(6);
    expect(linesAfter[3]).toBe(bLine1Before);
    expect(linesAfter[0]).toBe(linesBefore[0]);
    expect(linesAfter[1]).toBe(linesBefore[1]);
    expect(linesAfter[4]).toBe(linesBefore[4]);
    expect(linesAfter[5]).toBe(linesBefore[5]);
    // The edited line is new and shows the new text.
    expect(linesAfter[2]).not.toBe(bLine0Before);
    // The line is characters 0 to 9 of the new text: 'beta ONE ', with its trailing space.
    expect(linesAfter[2]!.querySelector('.de-text')!.textContent).toBe('beta ONE ');
  });
});
