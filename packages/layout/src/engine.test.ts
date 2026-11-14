/**
 * The layout engine's entry point (FE-076), in Node.js: one call from a flow document and the
 * injected providers (measurer, break opportunities, line breaker) to the layout tree. The document
 * is a CDM envelope with paragraphs and a footnote, read through `toFlow`. Coverage is checked with
 * `checkCoverage` (FE-078). The second line breaker (`wordPerLine`) is a stub written for the test.
 */
import { describe, expect, it } from 'vitest';
import { flowParagraphs, toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { LAYOUT_ENGINE, layoutFlow } from './engine.ts';
import {
  firstFitBreaker,
  type BreakOpportunities,
  type ItemProviders,
  type LineBreaker,
} from './items.ts';
import { advanceTableMeasurer, fixedWidthMeasurer, type TextMeasurer } from './measure.ts';
import {
  checkCoverage,
  serialiseTree,
  treeDigest,
  type LayoutTree,
  type ParagraphFragment,
} from './tree.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

/** A line may end before any position: the most breaks a text can have. */
const everyPosition: BreakOpportunities = {
  opportunities(text) {
    return Array.from({ length: Math.max(0, text.length - 1) }, (_, i) => i + 1);
  },
};

function envelope(
  body: CdmNode[],
  stories: CdmNode[] = [],
  setup: Record<string, unknown> = {},
): CdmEnvelopeLike {
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
                ...setup,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
        ...stories,
      ],
    },
  };
}

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** Sixty paragraphs of body text over several pages, and a footnote in the second one. */
function document(): CdmEnvelopeLike {
  const body: CdmNode[] = [];
  for (let i = 0; i < 60; i++) {
    const words = Array.from({ length: 4 + (i % 7) }, (_, w) => `word${i}x${w}`).join(' ');
    if (i === 12)
      body.push(
        paragraph(`p${i}`, [
          text(`${words}, with a mark `),
          {
            type: 'footnote',
            attrs: { id: 'n1' },
            content: [paragraph('fn-1', [text('The note text is here.')])],
          },
          text(' and more.'),
        ]),
      );
    else body.push(paragraph(`p${i}`, [text(words)]));
  }
  return envelope(body);
}

const measurers: readonly TextMeasurer[] = [fixedWidthMeasurer(), advanceTableMeasurer()];
const breakers: readonly BreakOpportunities[] = [afterSpace, everyPosition];

/**
 * A second line breaker, written for the test: one line per break opportunity (every word on a
 * line of its own), with no fitting at all. It records the paragraphs it is asked to break.
 */
function wordPerLine(): LineBreaker & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'word-per-line',
    calls,
    breakParagraph(input, measurer, breaks) {
      calls.push(input.blockId);
      const text = input.runs.map((r) => r.text).join('');
      const font = input.runs[0]?.font ?? input.markFont;
      const m = measurer.lineMetrics(font);
      const height = m.ascent + m.descent + m.lineGap;
      const ends = [...breaks.opportunities(text).filter((o) => o < text.length), text.length];
      let from = 0;
      const lines = (text.length === 0 ? [0] : ends).map((to, i) => {
        const line = {
          from,
          to,
          x: 0,
          y: i * height,
          width: measurer.advance(font, text.slice(from, to)),
          height,
        };
        from = to;
        return line;
      });
      return {
        kind: 'paragraph',
        blockId: input.blockId,
        from: 0,
        to: text.length,
        x: 0,
        y: 0,
        width: input.columnWidth,
        height: lines.length * height,
        lines,
      };
    },
  };
}

const bodyLines = (tree: LayoutTree): number =>
  tree.pages.reduce(
    (n, p) =>
      n + p.fragments.reduce((m, f) => m + (f.kind === 'paragraph' ? f.lines.length : 0), 0),
    0,
  );

describe('the layout engine entry point (FE-076)', () => {
  it('takes only the flow and the three injected providers (criterion 2)', () => {
    // The signature: a flow document and the providers, nothing else.
    expect(layoutFlow.length).toBe(2);

    // The engine reads the three providers and nothing else from the providers object.
    const flow = toFlow(document());
    const read = new Set<PropertyKey>();
    const base: ItemProviders = {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    };
    const watched = new Proxy(base, {
      get(target, key, receiver) {
        read.add(key);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const result = layoutFlow(flow, watched);
    expect([...read].sort()).toEqual(['breaks', 'lineBreaker', 'measurer']);
    expect(serialiseTree(result.tree)).toBe(serialiseTree(layoutFlow(flow, base).tree));
  });

  it('runs a second line breaker that is plugged in, and lays out the lines it returns (criterion 2)', () => {
    const flow = toFlow(document());
    const breaker = wordPerLine();
    const result = layoutFlow(flow, {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: breaker,
    });
    // Every body paragraph and the footnote paragraph went through the injected breaker.
    const paragraphs = flow.sections.flatMap((s) => [...flowParagraphs(s.blocks)].map((p) => p.id));
    expect(new Set(breaker.calls)).toEqual(new Set([...paragraphs, 'fn-1']));
    // Its lines are the tree's lines: one per word, so more than the first-fit breaker gives.
    const words = flow.sections
      .flatMap((s) => [...flowParagraphs(s.blocks)])
      .reduce(
        (n, p) =>
          n +
          p.inlines.reduce(
            (m, i) =>
              m +
              (i.kind === 'text' && i.role === 'text'
                ? i.text.split(' ').filter(Boolean).length
                : 0),
            0,
          ),
        0,
      );
    const firstFit = layoutFlow(flow, {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    });
    expect(bodyLines(result.tree)).toBeGreaterThan(bodyLines(firstFit.tree));
    expect(bodyLines(result.tree)).toBeGreaterThanOrEqual(words);
    expect(checkCoverage(flow, result.tree)).toEqual([]);
    expect(result.pageCountSettled).toBe(true);
  });

  it('lays out the header stories of the flow itself, with the injected providers (criterion 2)', () => {
    // A header with the page number and the page count: no resolver is passed, the story is the
    // flow's own.
    const body = Array.from({ length: 700 }, (_, i) =>
      paragraph(`p${i}`, [text(`Paragraph ${i} of the body, with some words.`)]),
    );
    const header: CdmNode = {
      type: 'story',
      attrs: { id: 'h1' },
      content: [
        paragraph('h1-p', [
          text('Page '),
          { type: 'field', attrs: { kind: 'page' } },
          text(' of '),
          { type: 'field', attrs: { kind: 'pageCount' } },
        ]),
      ],
    };
    const flow = toFlow(envelope(body, [header], { headerDefault: 'h1', headerDistance: 708 }));
    const calls: string[] = [];
    const counting: LineBreaker = {
      id: 'counting-first-fit',
      breakParagraph(input, measurer, breaks) {
        calls.push(input.blockId);
        return firstFitBreaker.breakParagraph(input, measurer, breaks);
      },
    };
    const result = layoutFlow(flow, {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: counting,
    });
    expect(result.pageCountSettled).toBe(true);
    const pages = result.tree.pages;
    expect(pages.length).toBeGreaterThanOrEqual(10);
    // The header story went through the injected breaker too.
    expect(calls).toContain('h1-p');
    // Each page's header is the story, its width that of "Page n of N" at 5.5 points a character.
    for (const p of pages) {
      const lines = p.header.flatMap((f) =>
        f.kind === 'paragraph' ? (f as ParagraphFragment).lines : [],
      );
      expect(lines.length, `page ${p.index}`).toBe(1);
      const expected = `Page ${p.index + 1} of ${pages.length}`.length * 5.5;
      expect(lines[0]!.width, `page ${p.index}`).toBeCloseTo(expected, 6);
    }
  });

  it('returns the same tree for the same flow and providers, on every call (criterion 5)', () => {
    const flow = toFlow(document());
    const providers: ItemProviders = {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    };
    const a = layoutFlow(flow, providers);
    const b = layoutFlow(flow, providers);
    expect(serialiseTree(a.tree)).toBe(serialiseTree(b.tree));
    expect(treeDigest(a.tree)).toBe(treeDigest(b.tree));
    expect(a.pageCountSettled).toBe(true);
    expect(a.unplaced).toEqual([]);
  });

  it('records the engine and the measurer in the tree, and reports the footnote pages', () => {
    const flow = toFlow(document());
    const result = layoutFlow(flow, {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    });
    expect(result.tree.engine).toBe(LAYOUT_ENGINE);
    expect(result.tree.measurer).toBe(fixedWidthMeasurer().id);
    const withNote = result.tree.pages.filter((p) => p.footnotes.length > 0);
    expect(withNote.length).toBe(1);
    expect(withNote[0]!.footnotes.some((f) => f.kind === 'paragraph' && f.blockId === 'fn-1')).toBe(
      true,
    );
  });

  it('runs unchanged with other providers and keeps every block covered (criterion 4)', () => {
    const flow = toFlow(document());
    for (const measurer of measurers)
      for (const breaks of breakers)
        for (const lineBreaker of [firstFitBreaker, wordPerLine()]) {
          const result = layoutFlow(flow, { measurer, breaks, lineBreaker });
          expect(checkCoverage(flow, result.tree), `${measurer.id} ${lineBreaker.id}`).toEqual([]);
          expect(result.tree.measurer).toBe(measurer.id);
          expect(result.pageCountSettled).toBe(true);
        }
  });

  it('gives an identical tree for identical providers built twice', () => {
    const flow = toFlow(document());
    const one = layoutFlow(flow, {
      measurer: advanceTableMeasurer(),
      breaks: everyPosition,
      lineBreaker: firstFitBreaker,
    });
    const two = layoutFlow(flow, {
      measurer: advanceTableMeasurer(),
      breaks: everyPosition,
      lineBreaker: firstFitBreaker,
    });
    expect(serialiseTree(one.tree)).toBe(serialiseTree(two.tree));
  });

  it('returns a frozen result', () => {
    const result = layoutFlow(toFlow(document()), {
      measurer: fixedWidthMeasurer(),
      breaks: afterSpace,
      lineBreaker: firstFitBreaker,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tree)).toBe(true);
    expect(Object.isFrozen(result.tree.pages)).toBe(true);
  });
});
