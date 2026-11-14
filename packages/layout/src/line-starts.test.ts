/**
 * Typeset line starts adopted by the engine (FE-100 criterion 1; 02 §9.7), in Node.js. A paragraph
 * that is not edited since the layout's `seq` starts a line at each typeset line start, and the
 * editor breaks the rest. The tests cover the breaker (`breakParagraphAt`), the adapter that maps
 * CDM offsets to text positions (`paragraphItem` through `layoutFlow`), and the path from a validated
 * `layout.json` through `adoptablePins`. The layout of the adopted pages is checked by the page pass
 * tests (`reconcile-layout.test.ts`); this file does not repeat them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { layoutFlow } from './engine.ts';
import { validateLayoutJson } from './layout-json.ts';
import { adoptablePins } from './reconcile.ts';
import { breakParagraphAt, firstFitBreaker, breakParagraph, type ParagraphInput } from './lines.ts';
import type { BreakOpportunities, ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { LayoutTree, ParagraphFragment } from './tree.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

const measurer = fixedWidthMeasurer();
/** At 11 points a character is 5.5 points wide (`fixedWidthMeasurer`, em 0.5). */
const FONT = { family: 'Noto Serif', sizePt: 11, bold: false, italic: false } as const;
const input = (text: string, extra: Partial<ParagraphInput> = {}): ParagraphInput => ({
  blockId: 'P',
  runs: [{ text, font: FONT }],
  markFont: FONT,
  columnWidth: 60,
  line: { rule: 'multiple', factor: 1 },
  ...extra,
});

/** The starts of the lines of a fragment, in order. */
const lineStarts = (f: ParagraphFragment): number[] => f.lines.map((l) => l.from);

describe('breakParagraphAt cuts the paragraph at the given starts (FE-100 criterion 1)', () => {
  it('with no starts gives the breaker’s own lines', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    expect(breakParagraphAt(input(text), [], firstFitBreaker, measurer, afterSpace)).toEqual(
      breakParagraph(input(text), measurer, afterSpace),
    );
  });

  it('starts a line at each given offset, even inside a word', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const starts = [6, 13, 20];
    const f = breakParagraphAt(input(text), starts, firstFitBreaker, measurer, afterSpace);
    // The breaker still breaks each piece: the given starts are lines, and more lines may follow them.
    expect(lineStarts(f)).toEqual(expect.arrayContaining([0, ...starts]));
    expect(lineStarts(f)).toEqual([...lineStarts(f)].sort((a, b) => a - b));
    for (const l of f.lines) expect(l.from).toBeLessThan(l.to);
    expect(f.lines.at(-1)!.to).toBe(text.length);
  });

  it('keeps a start after a piece that needs more than one line', () => {
    // A piece of 20 characters is 110 points, wider than the 60-point column: the extra line is the
    // editor's, and the start after it is still adopted.
    const text = 'aaaaaaaaaaaaaaaaaaaa bbbbbbbbbb';
    const f = breakParagraphAt(input(text), [20], firstFitBreaker, measurer, afterSpace);
    expect(lineStarts(f)).toContain(20);
    expect(f.lines.at(-1)!.to).toBe(text.length);
  });

  it('applies the first-line indent to the first piece only', () => {
    const text = 'alpha beta gamma delta';
    const f = breakParagraphAt(
      input(text, { indentFirstLine: 10 }),
      [6],
      firstFitBreaker,
      measurer,
      afterSpace,
    );
    expect(f.lines[0]!.x).toBe(10);
    expect(f.lines[1]!.x).toBe(0);
  });

  it('refuses starts that are not strictly inside the paragraph, ascending and whole', () => {
    const text = 'alpha beta';
    for (const bad of [[0], [text.length], [7, 4], [4, 4], [2.5], [-1]])
      expect(
        () => breakParagraphAt(input(text), bad, firstFitBreaker, measurer, afterSpace),
        String(bad),
      ).toThrow(RangeError);
  });

  it('for random text and starts, covers the text in order and begins a line at every start', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom('a', 'b', 'c', ' '), { minLength: 2, maxLength: 150 })
          .map((a) => a.join('')),
        fc.array(fc.nat(), { maxLength: 6 }),
        (text, picks) => {
          const n = text.length;
          const starts = [...new Set(picks.map((p) => (p % (n - 1)) + 1))].sort((a, b) => a - b);
          const f = breakParagraphAt(input(text), starts, firstFitBreaker, measurer, afterSpace);
          let at = 0;
          for (const l of f.lines) {
            expect(l.from).toBe(at);
            expect(l.to).toBeGreaterThan(l.from);
            at = l.to;
          }
          expect(at).toBe(n);
          for (const s of starts) expect(lineStarts(f)).toContain(s);
          expect(f.height).toBeCloseTo(
            f.lines.reduce((h, l) => h + l.height, 0),
            6,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/** A paragraph of plain text in the body; CDM offsets are those of its text. */
const paragraph = (id: string, t: string): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content: [{ type: 'text', text: t }],
});

function envelope(body: CdmNode[]): CdmEnvelopeLike {
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const providers: ItemProviders = { measurer, breaks: afterSpace, lineBreaker: firstFitBreaker };

/** Forty short words: the default lines of a paragraph of this text end well past offset 38. */
const BODY = 'Word ' + Array.from({ length: 40 }, (_, i) => `w${i}x`).join(' ');

/** The lines of block `id` in the tree, as the CDM offsets they start at. */
function linesOf(tree: LayoutTree, id: string): number[] {
  return tree.pages.flatMap((p) =>
    p.fragments.flatMap((f) => (f.kind === 'paragraph' && f.blockId === id ? lineStarts(f) : [])),
  );
}

describe('the engine adopts typeset line starts for unedited paragraphs (FE-100 criterion 1)', () => {
  const flow = toFlow(envelope([paragraph('p0', BODY), paragraph('p1', BODY)]));

  it('starts the lines of a paragraph at the given CDM offsets, and leaves its neighbour to the editor', () => {
    const before = linesOf(layoutFlow(flow, providers).tree, 'p0');
    const pin = 38;
    expect(before).not.toContain(pin);
    const result = layoutFlow(flow, providers, { lines: [{ blockId: 'p0', offset: pin }] });
    expect(linesOf(result.tree, 'p0')).toContain(pin);
    expect(linesOf(result.tree, 'p1')).toEqual(linesOf(layoutFlow(flow, providers).tree, 'p1'));
  });

  it('ignores a start that falls on no text position of the paragraph', () => {
    const plain = layoutFlow(flow, providers).tree;
    const result = layoutFlow(flow, providers, {
      lines: [
        { blockId: 'p0', offset: 0 },
        { blockId: 'p0', offset: BODY.length },
        { blockId: 'p0', offset: BODY.length + 50 },
        { blockId: 'nope', offset: 5 },
      ],
    });
    expect(linesOf(result.tree, 'p0')).toEqual(linesOf(plain, 'p0'));
  });

  it('adopts the line starts of a validated layout.json that are not edited since seq', () => {
    const check = validateLayoutJson({
      seq: 7,
      classVersion: '1.3.0',
      granularity: 'line',
      pages: [{ n: 1, setup: 'ps1', starts: { blockId: 'p0', offset: 0 }, opensWith: 'text' }],
      blocks: { p0: { lineStarts: [0, 37, 90] }, p1: { lineStarts: [0, 45] } },
    });
    if (!check.ok) throw new Error(check.problems.join('; '));
    const pins = adoptablePins(check.layout, new Set(['p1']), 'line');
    expect(pins.lines).toEqual([
      { blockId: 'p0', offset: 0 },
      { blockId: 'p0', offset: 37 },
      { blockId: 'p0', offset: 90 },
    ]);
    const result = layoutFlow(flow, providers, { lines: pins.lines });
    const p0 = linesOf(result.tree, 'p0');
    expect(p0).toContain(37);
    expect(p0).toContain(90);
    // p1 was edited since seq: it keeps the editor's breaks, so its lines are the plain ones.
    expect(linesOf(result.tree, 'p1')).toEqual(linesOf(layoutFlow(flow, providers).tree, 'p1'));
    // Every paragraph is still covered, once and in order.
    for (const id of ['p0', 'p1']) {
      const starts = linesOf(result.tree, id);
      expect(starts[0]).toBe(0);
      expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    }
  });
});
