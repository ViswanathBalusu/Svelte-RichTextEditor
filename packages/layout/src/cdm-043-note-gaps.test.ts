/**
 * CDM-043 criterion 5, layout side, for the `consecutive-footnotes` pair of
 * `packages/model/fixtures/semantics/paragraph-spacing.json`: two footnotes of one page, both in
 * `FootnoteText` (40 twips before, 60 after), are 60 twips apart, the larger of the two, and not 100.
 * The document goes through `toFlow`, `documentItems` and `paginate`, and the gap is read from the
 * footnote area of the page. Node.js only.
 */
import { describe, expect, it } from 'vitest';
import spacingFile from '../../model/fixtures/semantics/paragraph-spacing.json' with { type: 'json' };
import { toFlow, type CdmEnvelopeLike } from './flow.ts';
import { documentItems, firstFitBreaker, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { paginate } from './paginate.ts';
import type { ParagraphFragment } from './tree.ts';

type J = Record<string, unknown>;
const FIXTURE = spacingFile as unknown as {
  settings: J;
  styles: J[];
  pairs: { id: string; expected: number }[];
};

const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: { opportunities: () => [] },
  lineBreaker: firstFitBreaker,
};

const text = (id: string, style: string, extra: J[] = []): J => ({
  type: 'paragraph',
  attrs: { id, style },
  content: [{ type: 'text', text: 'Text.' }, ...extra],
});
const note = (id: string, pid: string): J => ({
  type: 'footnote',
  attrs: { id },
  content: [text(pid, 'FootnoteText')],
});

describe('consecutive footnotes (CDM-043 criterion 5, layout side)', () => {
  it('puts the larger of the two spaces between the paragraphs of consecutive footnotes', () => {
    const expected = FIXTURE.pairs.find((p) => p.id === 'consecutive-footnotes')!.expected;
    const env = {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              { type: 'settings', attrs: FIXTURE.settings },
              ...FIXTURE.styles,
              { type: 'page_setup', attrs: { id: 'ps1' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1' },
            content: [
              text('p01xxxxxxxxxxxxx', 'Body', [
                note('fn01xxxxxxxxxxxx', 'fp01xxxxxxxxxxxx'),
                note('fn02xxxxxxxxxxxx', 'fp02xxxxxxxxxxxx'),
              ]),
            ],
          },
        ],
      },
    } as unknown as CdmEnvelopeLike;
    const { first, items, notes } = documentItems(toFlow(env), providers);
    const { pages } = paginate(items, first, { notes });
    const areas = pages[0]!.footnotes.filter((f): f is ParagraphFragment => f.kind === 'paragraph');
    const a = areas.find((f) => f.blockId === 'fp01xxxxxxxxxxxx')!;
    const b = areas.find((f) => f.blockId === 'fp02xxxxxxxxxxxx')!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // The distance from the bottom of the first paragraph to the top of the second.
    const gap = (b.y - (a.y + a.height)) * 20;
    expect(gap).toBeCloseTo(expected, 6);
  });
});
