/**
 * The language of a paragraph reaches the break-opportunity provider (FE-080 criterion 3: the
 * provider interface takes text and language in), and a plugged-in provider that uses it runs
 * through the engine unchanged. In Node.js. The stand-in providers are not the Unicode line
 * breaking algorithm, which FE-080 criteria 1, 2 and 4 need and which is not built.
 */
import { describe, expect, it } from 'vitest';
import { flowParagraphs, toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { layoutFlow } from './engine.ts';
import {
  breakParagraph,
  firstFitBreaker,
  type BreakOpportunities,
  type ItemProviders,
} from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { ParagraphInput } from './lines.ts';
import { paragraphFragments } from './tree.ts';

/** Breaks after a space, whatever the language. */
const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

/** Records the language each call receives, and breaks after a space. */
function recording(): { provider: BreakOpportunities; calls: (string | undefined)[][] } {
  const calls: (string | undefined)[][] = [];
  return {
    calls,
    provider: {
      opportunities(text: string, language?: string) {
        calls.push([text, language]);
        return afterSpace.opportunities(text);
      },
    },
  };
}

/**
 * A stand-in for a Japanese-style breaker: a line may end after any character when the language is
 * `ja`, and only after a space otherwise.
 */
const languageAware: BreakOpportunities = {
  opportunities(text, language) {
    if (language?.startsWith('ja')) {
      const out: number[] = [];
      for (let i = 1; i < text.length; i++) out.push(i);
      return out;
    }
    return afterSpace.opportunities(text);
  },
};

function providersWith(breaks: BreakOpportunities): ItemProviders {
  return {
    measurer: fixedWidthMeasurer(),
    breaks,
    lineBreaker: firstFitBreaker,
  };
}

/** A CDM envelope: the document language is `en-GB`, and a style `Japanese` is `ja-JP`. */
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
              type: 'style_def',
              attrs: {
                id: 'Japanese',
                kind: 'paragraph',
                name: 'Japanese',
                builtIn: false,
                fontFamily: 'Noto Serif',
                fontSize: 220,
                lang: 'ja-JP',
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

const para = (id: string, style: string, text: string): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style },
  content: [{ type: 'text', text }],
});

describe('the language of a paragraph (FE-080 criterion 3)', () => {
  it('passes the language of the style to the provider, and the document language otherwise', () => {
    const flow = toFlow(
      envelope([para('p1', 'Normal', 'hello world'), para('p2', 'Japanese', '日本語の文章')]),
    );
    const langs = [...flowParagraphs(flow.sections.flatMap((s) => s.blocks))].map((p) => [
      p.id,
      p.lang,
    ]);
    expect(langs).toEqual([
      ['p1', 'en-GB'],
      ['p2', 'ja-JP'],
    ]);

    const rec = recording();
    layoutFlow(flow, providersWith(rec.provider));
    const seen = rec.calls.map(([text, language]) => [text, language]);
    expect(seen).toContainEqual(['hello world', 'en-GB']);
    expect(seen).toContainEqual(['日本語の文章', 'ja-JP']);
  });

  it('calls the provider with one argument when no language is set (existing providers see no change)', () => {
    const seenArgs: number[] = [];
    const counting: BreakOpportunities = {
      opportunities(...args: unknown[]) {
        seenArgs.push(args.length);
        return [];
      },
    };
    const input: ParagraphInput = {
      blockId: 'b',
      runs: [{ text: 'abc def', font: { family: 'F', sizePt: 10, bold: false, italic: false } }],
      markFont: { family: 'F', sizePt: 10, bold: false, italic: false },
      columnWidth: 100,
      line: { rule: 'multiple', factor: 1 },
    };
    breakParagraph(input, fixedWidthMeasurer(), counting);
    breakParagraph({ ...input, language: 'fr-FR' }, fixedWidthMeasurer(), counting);
    expect(seenArgs).toEqual([1, 2]);
  });

  it('runs a plugged-in provider that reads the language through the engine, unchanged', () => {
    const flow = toFlow(
      envelope([
        // Longer than the column (about 450 points at 5.5 points a character), with no space.
        para('p1', 'Japanese', '日本語の文章はここで区切れる'.repeat(8)),
        para('p2', 'Normal', 'a b c d'),
      ]),
    );
    const plain = layoutFlow(flow, providersWith(afterSpace)).tree;
    const aware = layoutFlow(flow, providersWith(languageAware)).tree;

    const linesOf = (tree: typeof plain, id: string): number =>
      tree.pages
        .flatMap((p) => [...paragraphFragments(p.fragments)])
        .filter((f) => f.blockId === id)
        .reduce((n, f) => n + f.lines.length, 0);

    // The Japanese paragraph breaks at every character with the language-aware provider, and has
    // no space to break at with the other one.
    expect(linesOf(plain, 'p1')).toBe(1);
    expect(linesOf(aware, 'p1')).toBeGreaterThan(1);
    // The English paragraph is broken the same way by both.
    expect(linesOf(aware, 'p2')).toBe(linesOf(plain, 'p2'));
  });
});
