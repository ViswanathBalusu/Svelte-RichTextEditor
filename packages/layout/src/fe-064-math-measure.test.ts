/**
 * FE-064 criterion 4 in Node.js, with a fake math measurer: the engine sizes inline and display
 * equations from the injected `MathMeasurer` (the screen fonts' sizes), keeps its stand-in where the
 * measurer answers `null`, caches sizes per font epoch, and a pass notes the math fonts so that
 * their arrival advances the epoch. The difference between the screen size and the typeset size is
 * left to reconciliation (FE-100): the last tests lay out with typeset page starts and show an
 * equation taller than the stand-in overflowing within the tolerance, and the pin dropped beyond it.
 * The browser run with real KaTeX is `packages/element/src/fe-064-math-measure.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontAwareLayout } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { cachingMathMeasurer, type MathMeasurer, type MathSize } from './math-measure.ts';
import { fixedWidthMeasurer, type FontKey } from './measure.ts';
import type { ParagraphFragment } from './tree.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

/** A 200 x 200 pt page with no margins. */
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
                fontSize: 200,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 4000,
                height: 4000,
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const para = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});
const text = (t: string): CdmNode => ({ type: 'text', text: t });
const inlineEq = (latex: string): CdmNode => ({ type: 'equation', attrs: { latex } });
const blockEq = (id: string, latex: string): CdmNode => ({
  type: 'equation_block',
  attrs: { id, latex },
});

/** Sizes made up for the test: 5 pt a character wide, 30 pt tall inline, 80 pt tall displayed. */
function fakeMath(options: { fonts?: string[]; reject?: string } = {}): MathMeasurer & {
  calls: number;
} {
  const m = {
    calls: 0,
    id: 'fake-math',
    fonts: options.fonts ?? [],
    measure(latex: string, display: boolean, _font: FontKey): MathSize | null {
      m.calls += 1;
      if (latex === options.reject) return null;
      return { width: 5 * latex.length, height: display ? 80 : 30 };
    },
  };
  return m;
}

const base = { measurer: fixedWidthMeasurer(), breaks: afterSpace, lineBreaker: firstFitBreaker };

const paragraphsOf = (r: ReturnType<typeof layoutFlow>): ParagraphFragment[] =>
  r.tree.pages.flatMap((p) =>
    p.fragments.filter((f): f is ParagraphFragment => f.kind === 'paragraph'),
  );
const boxesOf = (r: ReturnType<typeof layoutFlow>) =>
  r.tree.pages.flatMap((p) => p.fragments.filter((f) => f.kind === 'box'));

describe('equations sized by the math measurer (FE-064 criterion 4)', () => {
  const body = [
    para('p1', [text('Area '), inlineEq('a^2+b^2'), text(' ok')]),
    blockEq('e1', 'x=\\frac{1}{2}'),
  ];

  it('keeps the stand-in sizes without a math measurer', () => {
    const none = boxesOf(layoutFlow(toFlow(envelope(body)), base))[0];
    const unknown: MathMeasurer = { ...fakeMath(), id: 'none', measure: () => null };
    const nulled = boxesOf(layoutFlow(toFlow(envelope(body)), { ...base, math: unknown }))[0];
    expect(none?.height).toBeGreaterThan(0);
    expect(none?.height).not.toBe(80);
    expect(nulled?.height).toBe(none?.height);
  });

  it('sizes a display equation from the measurer, as wide as the column at most', () => {
    const math = fakeMath();
    const r = layoutFlow(toFlow(envelope(body)), { ...base, math });
    const [eq] = boxesOf(r);
    expect(eq?.height).toBe(80);
    expect(eq?.width).toBe(5 * 'x=\\frac{1}{2}'.length);
    const wide = layoutFlow(toFlow(envelope([blockEq('e2', 'y'.repeat(100))])), { ...base, math });
    expect(boxesOf(wide)[0]?.width).toBe(200);
  });

  it('sets an inline equation at the measured width and lets it raise its line', () => {
    const plain = paragraphsOf(layoutFlow(toFlow(envelope(body)), base))[0]!;
    const sized = paragraphsOf(
      layoutFlow(toFlow(envelope(body)), { ...base, math: fakeMath() }),
    )[0]!;
    const standIn = 'Area '.length + 'a^2+b^2'.length + ' ok'.length;
    expect(plain.lines[0]!.width).toBeCloseTo(standIn * 5, 6);
    // Text at 5 pt a character, the equation at 5 pt x 7 characters wide: same width here, so
    // compare heights, which the 30 pt equation raises above the 10 pt text line.
    expect(sized.lines[0]!.width).toBeCloseTo(standIn * 5, 6);
    expect(plain.lines[0]!.height).toBeLessThan(30);
    expect(sized.lines[0]!.height).toBeGreaterThanOrEqual(30);
  });

  it('changes the line width when the measured width differs from the stand-in', () => {
    const wide: MathMeasurer = {
      ...fakeMath(),
      id: 'wide',
      measure: () => ({ width: 60, height: 12 }),
    };
    const sized = paragraphsOf(layoutFlow(toFlow(envelope(body)), { ...base, math: wide }))[0]!;
    expect(sized.lines[0]!.width).toBeCloseTo(('Area '.length + ' ok'.length) * 5 + 60, 6);
  });

  it('keeps the stand-in where the measurer answers null', () => {
    const math = fakeMath({ reject: 'a^2+b^2' });
    const r = layoutFlow(toFlow(envelope(body)), { ...base, math });
    expect(paragraphsOf(r)[0]!.lines[0]!.height).toBeLessThan(30);
    expect(boxesOf(r)[0]?.height).toBe(80);
  });
});

describe('math sizes follow the font epoch (FE-064 criterion 4)', () => {
  it('answers the second call for one key from the cache, and not under another epoch', () => {
    const inner = fakeMath();
    const font: FontKey = { family: 'F', sizePt: 10, bold: false, italic: false };
    const cache = cachingMathMeasurer(inner, 0);
    cache.measure('x', false, font);
    cache.measure('x', false, font);
    expect(inner.calls).toBe(1);
    cache.measure('x', true, font);
    expect(inner.calls).toBe(2);
    const next = cachingMathMeasurer(inner, 1);
    next.measure('x', false, font);
    expect(inner.calls).toBe(3);
    expect(next.id).not.toBe(cache.id);
  });

  it('notes the math fonts in a pass, and their arrival advances the epoch and the sizes', async () => {
    const alias = `de-font-${'a'.repeat(64)}`;
    const face: LoadableFaceLike & { status: string } = {
      family: alias,
      status: 'unloaded',
      loaded: Promise.resolve(),
      load: () => Promise.resolve(),
    };
    let settle!: () => void;
    const loaded = new Promise<void>((resolve) => {
      settle = () => {
        face.status = 'loaded';
        resolve();
      };
    });
    (face as { loaded: Promise<void> }).loaded = loaded;
    // Wider while the face is not loaded (the fallback's size), narrower once it is.
    const math: MathMeasurer = {
      id: 'faces',
      fonts: [alias],
      measure: (latex) => ({
        width: face.status === 'loaded' ? 20 : 40,
        height: 12 + latex.length * 0,
      }),
    };
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face]),
      math,
    });
    const doc = toFlow(envelope([para('p1', [text('a '), inlineEq('x'), text(' b')])]));
    const providers: Omit<ItemProviders, 'measurer'> = {
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    };

    const first = layout.layout(doc, providers);
    expect(first.epoch).toBe(0);
    expect([...first.aliases]).toContain(alias);
    const width = (p: typeof first): number => paragraphsOf(p.result)[0]!.lines[0]!.width;
    expect(width(first)).toBeCloseTo(('a '.length + ' b'.length) * 5 + 40, 6);

    settle();
    expect(await first.fonts).toBe(true);
    const second = layout.layout(doc, providers);
    expect(second.epoch).toBe(1);
    expect(width(second)).toBeCloseTo(('a '.length + ' b'.length) * 5 + 20, 6);
    expect(await second.fonts).toBe(false);
  });
});

describe('the screen size against the typeset size is left to reconciliation (FE-064 criterion 4, FE-100)', () => {
  // Paragraph A, a display equation and paragraph B on a 200 pt page. On screen the equation is
  // 195 pt tall, so A and E together run over the page body by a few points. The typeset result
  // started B on page 2, with A and E on page 1.
  const body = [para('A', [text('A')]), blockEq('E', 'x'), para('B', [text('B')])];
  const math: MathMeasurer = { ...fakeMath(), measure: () => ({ width: 10, height: 195 }) };
  const pins = (tolerance: number) => ({
    pages: [
      { page: 1, blockId: 'A', offset: 0 },
      { page: 2, blockId: 'B', offset: 0 },
    ],
    tolerance,
  });
  const idsOf = (r: ReturnType<typeof layoutFlow>, page: number): string[] =>
    r.tree.pages[page]!.fragments.map((f) => f.blockId);

  it('lays the screen equation out taller than the page leaves, without pins', () => {
    const r = layoutFlow(toFlow(envelope(body)), { ...base, math });
    // The equation does not fit under A: it goes to page 2, which is not the typeset result.
    expect(idsOf(r, 0)).toEqual(['A']);
  });

  it('adopts the typeset start when the screen equation overflows within the tolerance', () => {
    const r = layoutFlow(toFlow(envelope(body)), { ...base, math }, { pins: pins(20) });
    expect(r.reconciliation!.judgements[0]!.decision).toBe('overflows');
    expect(r.reconciliation!.judgements[0]!.overflow).toBeGreaterThan(0);
    expect(r.reconciliation!.estimated).toEqual([]);
    expect(idsOf(r, 0)).toEqual(['A', 'E']);
    expect(idsOf(r, 1)).toEqual(['B']);
  });

  it('drops the pin and marks the page estimated beyond the tolerance', () => {
    const r = layoutFlow(toFlow(envelope(body)), { ...base, math }, { pins: pins(1) });
    expect(r.reconciliation!.judgements[0]!.decision).toBe('dropped');
    expect(r.reconciliation!.estimated.length).toBeGreaterThan(0);
  });
});
