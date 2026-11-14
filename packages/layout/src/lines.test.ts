/**
 * First-fit line breaking (FE-081) and the paragraph fragment it returns (FE-078), in Node.js.
 *
 * The break opportunities used here are a test stand-in: a line may end after a space or after a
 * hyphen. They are not the Unicode line breaking algorithm, which FE-080 owns and which is not yet
 * built. Property cases use a seeded generator (mulberry32), so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import {
  breakParagraph,
  type BreakOpportunities,
  type BreakRun,
  type ParagraphInput,
} from './lines.ts';
import {
  advanceTableMeasurer,
  fixedWidthMeasurer,
  SYNTHETIC_SERIF,
  type FontKey,
} from './measure.ts';
import { serialiseTree, type LayoutTree, type ParagraphFragment } from './tree.ts';

/** Test stand-in: a line may end after a space that is followed by a non-space, or after a hyphen. */
const spaceAndHyphen: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++) {
      const c = text[i];
      if ((c === ' ' || c === '-') && text[i + 1] !== ' ') out.push(i + 1);
    }
    return out;
  },
};

/** Seeded generator (mulberry32): the same seed gives the same sequence on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const font = (sizePt = 10, extra: Partial<FontKey> = {}): FontKey => ({
  family: 'synthetic-serif',
  sizePt,
  bold: false,
  italic: false,
  ...extra,
});

const single = (text: string, f: FontKey = font()): BreakRun[] => [{ text, font: f }];

const input = (over: Partial<ParagraphInput> & { runs: readonly BreakRun[] }): ParagraphInput => ({
  blockId: 'p1',
  markFont: font(),
  columnWidth: 100,
  line: { rule: 'multiple', factor: 1 },
  ...over,
});

/** The fragment's lines, checked for contiguity: they start at 0 and meet without gap or overlap. */
function expectContiguous(frag: ParagraphFragment, n: number): void {
  expect(frag.lines.length).toBeGreaterThan(0);
  expect(frag.lines[0]!.from).toBe(0);
  for (let i = 1; i < frag.lines.length; i++)
    expect(frag.lines[i]!.from).toBe(frag.lines[i - 1]!.to);
  expect(frag.lines[frag.lines.length - 1]!.to).toBe(n);
}

describe('first-fit breaking (FE-081)', () => {
  it('fills each line with as many words as fit, on random paragraphs', () => {
    const next = rng(20261113);
    const measurer = advanceTableMeasurer(SYNTHETIC_SERIF);
    const letters = 'abcdefghijklmnopqrstuvwxyzimwlt';
    for (let trial = 0; trial < 300; trial++) {
      const words: string[] = [];
      const count = 1 + Math.floor(next() * 14);
      for (let w = 0; w < count; w++) {
        let word = '';
        const len = 1 + Math.floor(next() * 9);
        for (let c = 0; c < len; c++) word += letters[Math.floor(next() * letters.length)];
        if (next() < 0.1) word += '-' + letters[Math.floor(next() * letters.length)];
        words.push(word);
      }
      const seps = words.slice(1).map(() => (next() < 0.15 ? '  ' : ' '));
      let text = words[0]!;
      words.slice(1).forEach((w, i) => (text += seps[i] + w));
      const f = font(8 + Math.floor(next() * 5));
      const runs = single(text, f);
      const columnWidth = 15 + next() * 185;
      const frag = breakParagraph(
        input({ blockId: `b${trial}`, runs, columnWidth }),
        measurer,
        spaceAndHyphen,
      );
      const n = text.length;
      expectContiguous(frag, n);

      const opps = new Set([...spaceAndHyphen.opportunities(text), n]);
      const trimmedWidth = (a: number, b: number): number => {
        let e = b;
        while (e > a && text[e - 1] === ' ') e--;
        return e > a ? measurer.advance(f, text.slice(a, e)) : 0;
      };
      const lines = frag.lines;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // A line ends only at a break opportunity or at the end of the text (no forced break here).
        expect(opps.has(line.to)).toBe(true);
        const interior = [...opps].filter((o) => o > line.from && o < line.to);
        // Only a line holding a single word may overflow.
        if (interior.length > 0)
          expect(trimmedWidth(line.from, line.to)).toBeLessThanOrEqual(columnWidth + 1e-9);
        // First fit: the next opportunity does not fit on this line.
        const next = [...opps].filter((o) => o > line.to).sort((a, b) => a - b)[0];
        if (next !== undefined)
          expect(trimmedWidth(line.from, next)).toBeGreaterThan(columnWidth + 1e-9);
      }
    }
  });

  it('never hyphenates: a word wider than the line stays whole and overflows alone', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5 });
    // Each character is 5 pt at 10 pt, so the first word (20 characters) is 100 pt against a 40 pt column.
    const text = 'supercalifragilistic word';
    const frag = breakParagraph(
      input({ runs: single(text), columnWidth: 40, hyphenation: false }),
      measurer,
      spaceAndHyphen,
    );
    expectContiguous(frag, text.length);
    expect(frag.lines.map((l) => [l.from, l.to])).toEqual([
      [0, 21],
      [21, 25],
    ]);
    expect(frag.lines[0]!.width).toBe(100);
  });

  it('accounts for the first-line indent, a hanging indent and the right indent', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5 });
    const text = 'aaaa bbbb cccc';
    // Four characters are 20 pt. Column 50 pt, left indent 10 pt, hanging first line of -10 pt.
    const hanging = breakParagraph(
      input({
        runs: single(text),
        columnWidth: 50,
        indentLeft: 10,
        indentFirstLine: -10,
      }),
      measurer,
      spaceAndHyphen,
    );
    expect(hanging.lines.map((l) => [l.x, l.from, l.to])).toEqual([
      [0, 0, 10],
      [10, 10, 14],
    ]);
    // A right indent of 10 pt narrows every line to 40 pt, which holds one four-letter word.
    const narrowed = breakParagraph(
      input({ runs: single(text), columnWidth: 50, indentRight: 10 }),
      measurer,
      spaceAndHyphen,
    );
    expect(narrowed.lines.map((l) => [l.from, l.to])).toEqual([
      [0, 5],
      [5, 10],
      [10, 14],
    ]);
  });

  it('gives a line the height of its tallest run under the multiple rule', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5, ascent: 0.8, descent: 0.2 });
    const runs: BreakRun[] = [
      { text: 'ab ', font: font(10) },
      { text: 'cd', font: font(20) },
    ];
    const at = (line: ParagraphInput['line']): number[] =>
      breakParagraph(input({ runs, line }), measurer, spaceAndHyphen).lines.map(
        (l) => Math.round(l.height * 1000) / 1000,
      );
    // Natural heights are 10 pt at 10 pt and 20 pt at 20 pt; the line holds both runs.
    expect(at({ rule: 'multiple', factor: 1 })).toEqual([20]);
    expect(at({ rule: 'multiple', factor: 1.5 })).toEqual([30]);
    expect(at({ rule: 'exact', pt: 12 })).toEqual([12]);
    expect(at({ rule: 'atLeast', pt: 5 })).toEqual([20]);
    expect(at({ rule: 'atLeast', pt: 25 })).toEqual([25]);
  });

  it('honours a forced line break and keeps the newline out of the width', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5 });
    const frag = breakParagraph(
      input({ runs: single('ab\ncd'), columnWidth: 500 }),
      measurer,
      spaceAndHyphen,
    );
    expect(frag.lines.map((l) => [l.from, l.to, l.width])).toEqual([
      [0, 3, 10],
      [3, 5, 10],
    ]);
    const trailing = breakParagraph(
      input({ runs: single('ab\n'), columnWidth: 500 }),
      measurer,
      spaceAndHyphen,
    );
    expect(trailing.lines.map((l) => [l.from, l.to])).toEqual([
      [0, 3],
      [3, 3],
    ]);
  });

  it('gives an empty paragraph one line of the mark font height', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5, ascent: 0.8, descent: 0.2 });
    const frag = breakParagraph(
      input({ runs: [], markFont: font(12), columnWidth: 100 }),
      measurer,
      spaceAndHyphen,
    );
    expect(frag.lines).toHaveLength(1);
    expect(frag.lines[0]).toMatchObject({ from: 0, to: 0, x: 0, y: 0, width: 0 });
    expect(frag.lines[0]!.height).toBeCloseTo(12, 9);
    expect(frag.height).toBeCloseTo(12, 9);
  });

  it('gives the same lines for the same input, every time', () => {
    const measurer = advanceTableMeasurer(SYNTHETIC_SERIF);
    const runs: BreakRun[] = [
      { text: 'Lorem ipsum dolor sit amet, ', font: font(10) },
      { text: 'consectetur adipiscing', font: font(10, { bold: true }) },
      { text: ' elit.\nSed do eiusmod.', font: font(11) },
    ];
    const args = input({ runs, columnWidth: 90 });
    const first = breakParagraph(args, measurer, spaceAndHyphen);
    const second = breakParagraph(args, measurer, spaceAndHyphen);
    expect(second).toEqual(first);
    expect(serialiseTree(treeOf(first))).toBe(serialiseTree(treeOf(second)));
  });
});

describe('tab stops (FE-081)', () => {
  // Five points per character at 10 pt, so a tab's width is only the distance to its stop.
  const widths = fixedWidthMeasurer({ emWidth: 0.5 });
  /** Test stand-in: a line may end after a space or a tab that is followed by a non-space. */
  const spaceOrTab: BreakOpportunities = {
    opportunities(text) {
      const out: number[] = [];
      for (let i = 0; i + 1 < text.length; i++) {
        const c = text.charAt(i);
        if ((c === ' ' || c === '\t') && text.charAt(i + 1) !== ' ') out.push(i + 1);
      }
      return out;
    },
  };

  it('advances a tab to the next left stop, measured from the column edge', () => {
    const frag = breakParagraph(
      input({ runs: single('aa\tbb'), columnWidth: 100, tabStops: [40] }),
      widths,
      spaceOrTab,
    );
    expectContiguous(frag, 5);
    expect(frag.lines).toHaveLength(1);
    // 'aa' is 10 pt, the tab goes to the stop at 40 pt, and 'bb' ends at 50 pt.
    expect(frag.lines[0]!.width).toBe(50);
  });

  it('counts a tab towards the fit, so the next word can move to the next line', () => {
    // 'aa\tbb' fits 55 pt (the tab stops at 40 pt, then 'bb' ends at 50 pt); 'cc' would end at 65 pt.
    const frag = breakParagraph(
      input({ runs: single('aa\tbb cc'), columnWidth: 55, tabStops: [40] }),
      widths,
      spaceOrTab,
    );
    expectContiguous(frag, 8);
    expect(frag.lines.map((l) => [l.from, l.to, l.width])).toEqual([
      [0, 6, 50],
      [6, 8, 10],
    ]);
  });

  it('gives a tab no width when the paragraph has neither stops nor default spacing', () => {
    const frag = breakParagraph(
      input({ runs: single('aa\tbb cc'), columnWidth: 55 }),
      widths,
      spaceOrTab,
    );
    expect(frag.lines.map((l) => [l.from, l.to])).toEqual([[0, 8]]);
    // 'aa' 10 pt, the tab 0 pt, 'bb' 10 pt, the space 5 pt and 'cc' 10 pt.
    expect(frag.lines[0]!.width).toBe(35);
  });

  it('measures a stop from the column edge when the line is indented', () => {
    const frag = breakParagraph(
      input({ runs: single('a\tb'), columnWidth: 100, indentLeft: 20, tabStops: [50] }),
      widths,
      spaceOrTab,
    );
    expect(frag.lines[0]!.x).toBe(20);
    // 'a' ends at 25 pt, the tab goes to 50 pt, and 'b' ends at 55 pt: 55 - 20 = 35 pt of line.
    expect(frag.lines[0]!.width).toBe(35);
  });

  it('uses default stops past the last custom stop, and none when no default spacing is set', () => {
    const withDefault = breakParagraph(
      input({ runs: single('abcdef\tg'), columnWidth: 100, tabStops: [20], defaultTabStop: 36 }),
      widths,
      spaceOrTab,
    );
    // 'abcdef' ends at 30 pt, past the stop at 20 pt; the next default stop is 36 pt; 'g' ends at 41 pt.
    expect(withDefault.lines[0]!.width).toBe(41);
    const noDefault = breakParagraph(
      input({ runs: single('abcdef\tg'), columnWidth: 100, tabStops: [20] }),
      widths,
      spaceOrTab,
    );
    expect(noDefault.lines[0]!.width).toBe(35);
  });

  it('leaves a trailing tab out of the fit', () => {
    const frag = breakParagraph(
      input({ runs: single('aa\t'), columnWidth: 100, tabStops: [40] }),
      widths,
      spaceOrTab,
    );
    expect(frag.lines[0]!.width).toBe(10);
  });

  it('rejects a negative default tab spacing', () => {
    expect(() =>
      breakParagraph(input({ runs: single('a\tb'), defaultTabStop: -1 }), widths, spaceOrTab),
    ).toThrow(RangeError);
  });

  it('breaks random paragraphs with tabs so that every line fits and the next word does not', () => {
    const next = rng(20261114);
    const letters = 'abcdefgimwlt';
    const stopsAll = [30, 60, 90];
    for (let trial = 0; trial < 200; trial++) {
      let text = '';
      const pieces = 2 + Math.floor(next() * 10);
      for (let w = 0; w < pieces; w++) {
        const len = 1 + Math.floor(next() * 5);
        for (let c = 0; c < len; c++) text += letters[Math.floor(next() * letters.length)];
        const r = next();
        text += r < 0.3 ? '\t' : r < 0.6 ? ' ' : '';
      }
      const f = font();
      const columnWidth = 30 + next() * 120;
      const frag = breakParagraph(
        input({
          blockId: `t${trial}`,
          runs: single(text, f),
          columnWidth,
          tabStops: stopsAll,
        }),
        widths,
        spaceOrTab,
      );
      expectContiguous(frag, text.length);

      // Reference widths, one character at a time: a tab goes to the next stop past the position.
      const refPos = (x: number, a: number, b: number): number => {
        let p = x;
        for (let i = a; i < b; i++) {
          if (text.charAt(i) === '\t') p = stopsAll.find((s) => s > p) ?? p;
          else p += widths.advance(f, text.charAt(i));
        }
        return p;
      };
      const fitRef = (x: number, a: number, o: number): number => {
        let e = o;
        while (e > a && (text.charAt(e - 1) === ' ' || text.charAt(e - 1) === '\t')) e--;
        return refPos(x, a, e) - x;
      };
      const opps = [...spaceOrTab.opportunities(text), text.length];
      for (const line of frag.lines) {
        expect(line.width).toBeCloseTo(fitRef(line.x, line.from, line.to), 9);
        const interior = opps.some((o) => o > line.from && o < line.to);
        if (interior) expect(line.width).toBeLessThanOrEqual(columnWidth + 1e-9);
        const following = opps.find((o) => o > line.to);
        if (following !== undefined)
          expect(fitRef(line.x, line.from, following)).toBeGreaterThan(columnWidth + 1e-9);
      }
    }
  });
});

describe('the paragraph fragment (FE-078)', () => {
  it('records the block identifier and the offsets it covers, with no gap or overlap', () => {
    const measurer = advanceTableMeasurer(SYNTHETIC_SERIF);
    const next = rng(7);
    for (let trial = 0; trial < 100; trial++) {
      const words = Array.from({ length: 1 + Math.floor(next() * 20) }, (_, i) =>
        'w'.repeat(1 + Math.floor(next() * 12)).concat(i % 3 === 0 ? '.' : ''),
      );
      const text = words.join(' ');
      const frag = breakParagraph(
        input({ blockId: `block-${trial}`, runs: single(text), columnWidth: 60 + next() * 80 }),
        measurer,
        spaceAndHyphen,
      );
      expect(frag.kind).toBe('paragraph');
      expect(frag.blockId).toBe(`block-${trial}`);
      expect([frag.from, frag.to]).toEqual([0, text.length]);
      expectContiguous(frag, text.length);
      let y = 0;
      for (const line of frag.lines) {
        expect(line.y).toBeCloseTo(y, 9);
        y += line.height;
      }
      expect(frag.height).toBeCloseTo(y, 9);
    }
  });

  it('serialises to the same JSON on every call, with numbers rounded to a thousandth', () => {
    const measurer = fixedWidthMeasurer({ emWidth: 0.5 });
    const frag = breakParagraph(
      input({ runs: single('one two three four five six'), columnWidth: 37.3333333 }),
      measurer,
      spaceAndHyphen,
    );
    const tree = treeOf(frag);
    const once = serialiseTree(tree);
    expect(serialiseTree(tree)).toBe(once);
    const pages = JSON.parse(once) as Array<{ fragments: ParagraphFragment[] }>;
    expect(pages).toHaveLength(1);
    expect(pages[0]!.fragments[0]!.blockId).toBe('p1');
    expect(pages[0]!.fragments[0]!.width).toBe(37.333);
    expect(once).not.toMatch(/\.\d{4,}/);
  });
});

/** Wraps one fragment in a one-page tree, for serialisation checks. */
function treeOf(frag: ParagraphFragment): LayoutTree {
  return {
    engine: 'test-only',
    measurer: 'test-only',
    pages: [
      {
        index: 0,
        section: 0,
        width: 595,
        height: 842,
        fragments: [frag],
        header: [],
        footer: [],
        footnotes: [],
      },
    ],
  };
}
