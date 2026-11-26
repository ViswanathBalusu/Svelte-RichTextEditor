/**
 * WASM-015 criterion 3: the layout tree's caret, hit test and selection rectangles on lines whose
 * runs come from the kernel's UAX #9 reordering, in Node.js on the real build. For random mixed-
 * direction strings (Latin and Hebrew letters, digits, spaces, brackets) in both base directions,
 * every width is five points a code unit, so the geometry can be checked exactly:
 * - the cells of the characters tile the line, each once (the order is a permutation);
 * - the caret of a logical offset sits on the edge of the cell of the character at that offset that
 *   its direction puts first (left edge for an even level, right edge for an odd one);
 * - a click at that caret gives an offset with the same caret place;
 * - the selection of one character is one rectangle on exactly its cell, and the selection of a
 *   range covers exactly the cells of its characters, however many rectangles that takes.
 * That the runs themselves equal the browsers' order is checked in
 * `packages/layout-kernel/e2e/wasm-015-bidi-browsers.spec.ts`.
 */
import {
  caretGeometry,
  hitTest,
  selectionRects,
  type LayoutLine,
  type LayoutPage,
  type LayoutTree,
  type LineRuns,
  type SpanWidth,
} from '@docedit/layout';
import { beforeAll, describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../../layout-kernel/node/index.ts';
import type { BidiDirection, LayoutKernel } from '../../layout-kernel/src/index.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

const UNIT = 5;
const LEFT = 10;
const span: SpanWidth = (_block, from, to) => (to - from) * UNIT;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lineTree(length: number): LayoutTree {
  const line: LayoutLine = { from: 0, to: length, x: 0, y: 0, width: length * UNIT, height: 12 };
  const page: LayoutPage = {
    index: 0,
    section: 0,
    width: 400,
    height: 300,
    fragments: [
      {
        kind: 'paragraph',
        blockId: 'p',
        from: 0,
        to: length,
        x: LEFT,
        y: 100,
        width: 300,
        height: 12,
        lines: [line],
      },
    ],
    header: [],
    footer: [],
    footnotes: [],
  };
  return { engine: 'test', measurer: 'test', pages: [page] };
}

const ALPHABET = ['a', 'b', ' ', 'א', 'ב', 'ג', '1', '2', '(', ')', '.'];

describe.skipIf(!built)('caret and selection on kernel runs (WASM-015)', () => {
  let kernel: LayoutKernel;
  beforeAll(async () => {
    kernel = await loadNodeKernel();
  });

  function check(text: string, dir: BidiDirection): void {
    const n = text.length;
    const tree = lineTree(n);
    const runs: LineRuns = (_block, from, to) =>
      kernel.bidi.visualRuns(text, dir, from, to).map((r) => ({
        from: r.start,
        to: r.end,
        level: r.level,
      }));
    // The level of each character, as the line's runs give it (L1 applies to the line).
    const levels: number[] = new Array<number>(n).fill(0);
    for (const r of runs('p', 0, n) ?? []) levels.fill(r.level, r.from, r.to);
    const where = `${JSON.stringify(text)} ${dir}`;
    const cellOf: number[] = [];
    for (let i = 0; i < n; i++) {
      const rects = selectionRects(
        tree,
        { blockId: 'p', offset: i },
        { blockId: 'p', offset: i + 1 },
        span,
        runs,
      );
      expect(rects.length, `one rectangle for ${i} of ${where}`).toBe(1);
      expect(rects[0]!.width, where).toBe(UNIT);
      const cell = (rects[0]!.x - LEFT) / UNIT;
      expect(Number.isInteger(cell), where).toBe(true);
      cellOf.push(cell);
      // The caret is on the edge the character's direction puts first.
      const caret = caretGeometry(tree, { blockId: 'p', offset: i }, span, runs)!;
      const edge = levels[i]! % 2 === 0 ? rects[0]!.x : rects[0]!.x + UNIT;
      expect(caret.x, `caret ${i} of ${where}`).toBe(edge);
      // A click on that place lands on an offset with the same place.
      const hit = hitTest(tree, 0, caret.x, 104, span, runs)!;
      const again = caretGeometry(tree, hit, span, runs)!;
      expect(again.x, `hit of caret ${i} of ${where}`).toBe(caret.x);
    }
    expect(
      [...cellOf].sort((a, b) => a - b),
      where,
    ).toEqual(Array.from({ length: n }, (_, i) => i));
    // A range covers exactly the cells of its characters.
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b <= n; b++) {
        const rects = selectionRects(
          tree,
          { blockId: 'p', offset: a },
          { blockId: 'p', offset: b },
          span,
          runs,
        );
        const covered = new Set<number>();
        for (const r of rects)
          for (let c = (r.x - LEFT) / UNIT; c < (r.x - LEFT + r.width) / UNIT; c++) covered.add(c);
        const wanted = new Set(cellOf.slice(a, b));
        expect(
          [...covered].sort((x, y) => x - y),
          `${a}-${b} of ${where}`,
        ).toEqual([...wanted].sort((x, y) => x - y));
        // Rectangles that touch were joined.
        const sorted = [...rects].sort((p, q) => p.x - q.x);
        for (let k = 1; k < sorted.length; k++)
          expect(sorted[k]!.x, where).toBeGreaterThan(sorted[k - 1]!.x + sorted[k - 1]!.width);
      }
    }
    // A click anywhere, left or right of the line too, gives an offset of the line.
    for (let x = 0; x <= n * UNIT + 20; x += 3) {
      const hit = hitTest(tree, 0, LEFT - 10 + x, 104, span, runs)!;
      expect(hit.offset, where).toBeGreaterThanOrEqual(0);
      expect(hit.offset, where).toBeLessThanOrEqual(n);
    }
  }

  it('is consistent on mixed-direction lines of random text, in three base directions', () => {
    const rand = mulberry32(15);
    for (let k = 0; k < 250; k++) {
      const length = 1 + Math.floor(rand() * 12);
      let text = '';
      for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      for (const dir of ['ltr', 'rtl', 'auto'] as const) check(text, dir);
    }
  });

  it('puts the caret of a Hebrew word inside Latin text at the right edge of its first letter', () => {
    const tree = lineTree(6);
    const text = 'ab אבג';
    const runs: LineRuns = (_b, from, to) =>
      kernel.bidi.visualRuns(text, 'ltr', from, to).map((r) => ({
        from: r.start,
        to: r.end,
        level: r.level,
      }));
    // 'ab ' is at cells 0 to 2; the word occupies cells 3 to 5 with its first letter on the right.
    expect(caretGeometry(tree, { blockId: 'p', offset: 3 }, span, runs)!.x).toBe(LEFT + 6 * UNIT);
    expect(caretGeometry(tree, { blockId: 'p', offset: 6 }, span, runs)!.x).toBe(LEFT + 3 * UNIT);
  });
});
