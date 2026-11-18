// FE-064 criterion 4 on a real page: an equation is sized from the KaTeX screen fonts. The measurer
// (`katexMathMeasurer`, math-measure.ts) draws the equation with the editor's drawer into a hidden
// box in a shadow root and reads its size; a layout pass (`FontAwareLayout`) takes the sizes through
// `layoutFlow`. The KaTeX faces are registered under hash aliases and not yet loaded when the first
// pass measures, so its sizes are the fallback's; when the faces load, the font epoch advances and
// the next pass measures the screen fonts' sizes. Runs in the browser projects; skipped where there
// is no page.
import { toFlow, type CdmEnvelopeLike, type CdmNode } from '../../layout/src/flow.ts';
import { layoutFlow, type LayoutResult } from '../../layout/src/engine.ts';
import { faceArrivals, type LoadableFaceLike } from '../../layout/src/font-arrivals.ts';
import { FontAwareLayout } from '../../layout/src/font-pass.ts';
import {
  firstFitBreaker,
  type BreakOpportunities,
  type ItemProviders,
} from '../../layout/src/items.ts';
import { fixedWidthMeasurer } from '../../layout/src/measure.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { FONT_ALIAS_PREFIX } from './font-registration.ts';
import { KATEX_FONT_ROWS } from './katex-font-manifest.ts';
import { loadKatexFonts } from './katex-fonts.ts';
import { katexMathMeasurer } from './math-measure.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';

const unquoted = (family: string) => family.trim().replace(/^["']|["']$/g, '');

const fontUrls = import.meta.glob('../node_modules/katex/dist/fonts/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function servedBaseUrl(): string {
  const first = Object.values(fontUrls)[0];
  if (first === undefined) throw new Error('the test server serves no KaTeX font');
  return first.slice(0, first.lastIndexOf('/') + 1);
}

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

const LATEX = '\\int_0^1 x^2\\,dx=\\frac{1}{3}';

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
                fontSize: 240,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 12000,
                height: 16000,
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

const body: CdmNode[] = [
  {
    type: 'paragraph',
    attrs: { id: 'p1', style: 'Normal' },
    content: [
      { type: 'text', text: 'Area ' },
      { type: 'equation', attrs: { latex: LATEX } },
      { type: 'text', text: ' ok' },
    ],
  },
  { type: 'equation_block', attrs: { id: 'e1', latex: LATEX } },
];

const base = { breaks: afterSpace, lineBreaker: firstFitBreaker };

function sizes(result: LayoutResult): { line: number; box: number; boxWidth: number } {
  const page = result.tree.pages[0]!;
  const paragraph = page.fragments.find((f) => f.kind === 'paragraph');
  const box = page.fragments.find((f) => f.kind === 'box');
  if (paragraph?.kind !== 'paragraph' || box?.kind !== 'box') throw new Error('no fragments');
  return { line: paragraph.lines[0]!.width, box: box.height, boxWidth: box.width };
}

describe.skipIf(!isBrowser)('equations sized from the screen fonts (FE-064 criterion 4)', () => {
  const hosts: HTMLElement[] = [];

  afterEach(() => {
    for (const host of hosts.splice(0)) host.remove();
    for (const face of Array.from(document.fonts))
      if (unquoted(face.family).startsWith(FONT_ALIAS_PREFIX)) document.fonts.delete(face);
  });

  function shadowRoot(): ShadowRoot {
    const host = document.createElement('div');
    document.body.append(host);
    hosts.push(host);
    return host.attachShadow({ mode: 'open' });
  }

  it('measures nothing before the KaTeX fonts are registered, and the engine keeps its stand-in', () => {
    const math = katexMathMeasurer({ root: shadowRoot() });
    const font = { family: 'Noto Serif', sizePt: 12, bold: false, italic: false };
    expect(math.fonts).toEqual([]);
    expect(math.measure(LATEX, false, font)).toBeNull();
    const plain = layoutFlow(toFlow(envelope(body)), {
      ...base,
      measurer: fixedWidthMeasurer(),
    });
    const withNull = layoutFlow(toFlow(envelope(body)), {
      ...base,
      measurer: fixedWidthMeasurer(),
      math,
    });
    expect(sizes(withNull)).toEqual(sizes(plain));
  });

  it('takes the sizes of the screen fonts once the faces have loaded, and not before', async () => {
    const fonts = await loadKatexFonts(servedBaseUrl());
    expect(fonts?.faces).toHaveLength(KATEX_FONT_ROWS.length);
    const root = shadowRoot();
    const math = katexMathMeasurer({ root });
    expect(math.fonts).toEqual([...new Set(fonts?.aliases.values())]);

    const arrivals = faceArrivals(() => Array.from(document.fonts) as LoadableFaceLike[], {
      load: true,
    });
    const layout = new FontAwareLayout({ measurer: fixedWidthMeasurer(), arrivals, math });
    const providers: Omit<ItemProviders, 'measurer'> = base;
    const doc = toFlow(envelope(body));

    // First pass: the faces are registered and not loaded, so the sizes are the fallback's.
    const first = layout.layout(doc, providers);
    expect(first.epoch).toBe(0);
    for (const alias of math.fonts) expect(first.aliases.has(alias)).toBe(true);
    const before = sizes(first.result);
    expect(before.box).toBeGreaterThan(0);

    // The faces load; the epoch advances once and the next pass measures the screen fonts.
    expect(await first.fonts).toBe(true);
    const second = layout.layout(doc, providers);
    // Each KaTeX family that arrived advances the epoch once.
    expect(second.epoch).toBe(math.fonts.length);
    const after = sizes(second.result);
    expect(after).not.toEqual(before);

    // The pass's sizes are the measurer's own, taken with the loaded faces.
    const font = { family: 'Noto Serif', sizePt: 12, bold: false, italic: false };
    const direct = math.measure(LATEX, true, font);
    expect(direct).not.toBeNull();
    expect(after.box).toBeCloseTo(direct!.height, 6);
    expect(after.boxWidth).toBeCloseTo(Math.min(direct!.width, 12000 / 20), 6);
    expect(await second.fonts).toBe(false);
  });

  it('answers null for a source KaTeX rejects, so the stand-in stays', async () => {
    await loadKatexFonts(servedBaseUrl());
    const math = katexMathMeasurer({ root: shadowRoot() });
    const font = { family: 'Noto Serif', sizePt: 12, bold: false, italic: false };
    expect(math.measure('\\notacommand{', false, font)).toBeNull();
    expect(math.measure('x^2', false, font)).not.toBeNull();
  });
});
